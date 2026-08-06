import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { io as client, type Socket } from 'socket.io-client'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { PgEventStore } from '../src/store.js'
import { LeagueService } from '../src/league.js'
import { PlayerRepo, toPlayerRows } from '../src/players.js'
import { RoomManager } from '../src/rooms.js'
import { attachSockets } from '../src/sockets.js'

const CONFIG = {
  teams: [{ id: 'T1', name: 'A' }, { id: 'T2', name: 'B' }],
  budget: 200,
  rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }],
  bidClockMs: 10_000,
  nominationClockMs: 30_000,
  nominationOrder: ['T1', 'T2'],
  nominationExpiryPolicy: 'auto_nominate',
}
const SLEEPER_FIXTURE = {
  q1: { full_name: 'QB One', position: 'QB', team: 'SF', status: 'Active', search_rank: 1 },
  q2: { full_name: 'QB Two', position: 'QB', team: 'KC', status: 'Active', search_rank: 2 },
}

function connect(port: number, token: string): Promise<{ socket: Socket; snapshot: any }> {
  return new Promise((resolve, reject) => {
    const socket = client(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'] })
    socket.on('snapshot', snapshot => resolve({ socket, snapshot }))
    socket.on('connect_error', reject)
  })
}
const emit = (socket: Socket, payload: unknown): Promise<any> =>
  new Promise(resolve => socket.emit('command', payload, resolve))

describe('socket gateway', () => {
  let http: HttpServer
  let port: number
  let leagues: LeagueService
  let leagueId: string
  let tokens: { commissioner: string; board: string; t1: string; t2: string }
  const open: Socket[] = []

  beforeEach(async () => {
    const pool = newTestPool()
    await migrate(pool)
    leagues = new LeagueService(pool, 'http://x')
    const playerRepo = new PlayerRepo(pool)
    await playerRepo.upsertAll(toPlayerRows(SLEEPER_FIXTURE))
    const store = new PgEventStore(pool)
    http = createServer()
    const io = new Server(http)
    const rooms = new RoomManager(
      {
        store,
        broadcast: (id, seq, events) => io.to(`league:${id}`).emit('events', { seq, events }),
        notify: (id, notice) => io.to(`league:${id}`).emit('notice', notice),
        clock: () => Date.now(),
      },
      leagues,
    )
    attachSockets(io, { leagues, rooms, playerRepo })
    await new Promise<void>(r => http.listen(0, r))
    port = (http.address() as { port: number }).port
    const created = await leagues.create('L', CONFIG)
    leagueId = created.id
    tokens = {
      commissioner: created.links.commissioner.split('#')[1]!,
      board: created.links.board.split('#')[1]!,
      t1: created.links.teams.find(t => t.teamId === 'T1')!.url.split('#')[1]!,
      t2: created.links.teams.find(t => t.teamId === 'T2')!.url.split('#')[1]!,
    }
  })
  afterEach(async () => {
    for (const s of open.splice(0)) s.disconnect()
    await new Promise<void>(r => http.close(() => r()))
  })

  it('rejects bad tokens, snapshots by role', async () => {
    await expect(connect(port, 'garbage')).rejects.toBeTruthy()
    const c = await connect(port, tokens.commissioner)
    open.push(c.socket)
    expect(c.snapshot).toMatchObject({ seq: 0, role: 'commissioner', state: { phase: { type: 'lobby' } } })
    expect(Number.isFinite(c.snapshot.now)).toBe(true)
    const m = await connect(port, tokens.t1)
    open.push(m.socket)
    expect(m.snapshot).toMatchObject({ role: 'manager', teamId: 'T1' })
  })

  it('enforces the authorization matrix', async () => {
    const b = await connect(port, tokens.board)
    const m = await connect(port, tokens.t1)
    open.push(b.socket, m.socket)
    expect((await emit(b.socket, { type: 'START_DRAFT' })).error.code).toBe('FORBIDDEN')
    expect((await emit(m.socket, { type: 'START_DRAFT' })).error.code).toBe('FORBIDDEN')
    expect((await emit(m.socket, { type: 'ADJUST_BUDGET', teamId: 'T1', delta: 10 })).error.code).toBe('FORBIDDEN')
    expect((await emit(m.socket, { type: 'BID', teamId: 'T2', amount: 5 })).error.code).toBe('FORBIDDEN')
    expect((await emit(m.socket, { type: 'BID', teamId: 'T1', amount: -3 })).error.code).toBe('INVALID_COMMAND')
  })

  it('commissioner START_DRAFT freezes players then drafts flow end to end', async () => {
    const c = await connect(port, tokens.commissioner)
    const m1 = await connect(port, tokens.t1)
    open.push(c.socket, m1.socket)
    const received: any[] = []
    m1.socket.on('events', e => received.push(e))
    const started = await emit(c.socket, { type: 'START_DRAFT' })
    expect(started.ok).toBe(true)
    expect((await leagues.frozenConfig(leagueId))!.players).toHaveLength(2)
    const nom = await emit(m1.socket, { type: 'NOMINATE', teamId: 'T1', playerId: 'q1', openingBid: 3 })
    expect(nom.ok).toBe(true)
    await new Promise(r => setTimeout(r, 50))
    expect(received.flatMap(e => e.events.map((x: any) => x.type))).toContain('PLAYER_NOMINATED')
  })

  it('commissioner can drive every correction tool over the wire', async () => {
    const c = await connect(port, tokens.commissioner)
    const m1 = await connect(port, tokens.t1)
    open.push(c.socket, m1.socket)
    const received: any[] = []
    c.socket.on('events', e => received.push(e))
    // Waits for a broadcast event of the given type rather than a blind sleep, since
    // the SOLD below comes from the room's own bid-clock timer, not from an ack.
    const waitForEventType = (type: string, timeoutMs = 5000): Promise<void> =>
      new Promise((resolve, reject) => {
        const seen = () => received.some(e => e.events.some((x: any) => x.type === type))
        if (seen()) return resolve()
        const interval = setInterval(() => {
          if (seen()) {
            clearInterval(interval)
            clearTimeout(timer)
            resolve()
          }
        }, 20)
        const timer = setTimeout(() => {
          clearInterval(interval)
          reject(new Error(`timed out waiting for ${type}`))
        }, timeoutMs)
      })

    expect((await emit(c.socket, { type: 'START_DRAFT' })).ok).toBe(true)
    expect((await emit(c.socket, { type: 'SET_TIMERS', bidClockMs: 1_000 })).ok).toBe(true)
    expect((await emit(c.socket, { type: 'ADD_TIME', ms: 5_000 })).ok).toBe(true)
    expect((await emit(c.socket, { type: 'PAUSE' })).ok).toBe(true)
    expect((await emit(c.socket, { type: 'RESUME' })).ok).toBe(true)
    // No live bid yet (still awaiting a nomination), so a budget correction is legal here.
    expect((await emit(c.socket, { type: 'ADJUST_BUDGET', teamId: 'T2', delta: 5 })).ok).toBe(true)
    // Proxy-nominate for T1. The 1s bid clock (set above) then expires on its own with
    // T1 as the only bidder, producing a real SOLD for UNDO_SALE/EDIT_PICK to correct.
    expect((await emit(c.socket, { type: 'NOMINATE', teamId: 'T1', playerId: 'q1', openingBid: 3 })).ok).toBe(true)
    await waitForEventType('SOLD')
    expect((await emit(c.socket, { type: 'EDIT_PICK', overall: 1, newPrice: 5 })).ok).toBe(true)
    expect((await emit(c.socket, { type: 'UNDO_SALE' })).ok).toBe(true)
  }, 10_000)

  it('acks a command sent immediately on connect, before the snapshot arrives', async () => {
    // socket.io drops events with no listener, so a client that does not wait for
    // the snapshot must still get an ack rather than hanging forever.
    const socket = client(`http://localhost:${port}`, { auth: { token: tokens.commissioner }, transports: ['websocket'] })
    open.push(socket)
    const acked = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ack within 2s')), 2000)
      socket.on('connect', () => {
        socket.emit('command', { type: 'START_DRAFT' }, (res: unknown) => {
          clearTimeout(timer)
          resolve(res)
        })
      })
    })
    expect(acked.ok).toBe(true)
  })

  it('broadcasts presence on connect and disconnect', async () => {
    const c = await connect(port, tokens.commissioner)
    open.push(c.socket)
    const seen: any[] = []
    c.socket.on('presence', p => seen.push(p))
    const m = await connect(port, tokens.t2)
    await new Promise(r => setTimeout(r, 50))
    m.socket.disconnect()
    await new Promise(r => setTimeout(r, 50))
    const flat = seen.map(p => p.connected.map((x: any) => x.teamId ?? x.role).sort())
    expect(flat.some(l => l.includes('T2'))).toBe(true)
    expect(flat[flat.length - 1]).not.toContain('T2')
  })
})
