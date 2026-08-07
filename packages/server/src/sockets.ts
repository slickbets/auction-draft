import type { Server, Socket } from 'socket.io'
import { ZodError } from 'zod'
import { rosterCapacity, isDraftablePosition } from '@auction/engine'
import type { LeagueConfig } from '@auction/engine'
import type { LeagueService, Principal } from './league.js'
import type { PlayerRepo } from './players.js'
import type { RoomManager } from './rooms.js'
import { parseWireCommand } from './wire.js'
import type { WireCommand } from './room.js'

export interface SocketDeps {
  leagues: LeagueService
  rooms: RoomManager
  playerRepo: PlayerRepo
  clockNow?: () => number
}

type Ack = (result: { ok: true } | { ok: false; error: { code: string; message: string } }) => void
const deny = (ack: Ack, code: string, message: string) => ack({ ok: false, error: { code, message } })

const MANAGER_COMMANDS = new Set<WireCommand['type']>(['NOMINATE', 'BID'])

function authorized(principal: Principal, cmd: WireCommand): boolean {
  if (principal.role === 'commissioner') return cmd.type !== 'CLOCK_EXPIRED' // clock is server-internal
  if (principal.role === 'board') return false
  if (!MANAGER_COMMANDS.has(cmd.type)) return false
  return (cmd as { teamId?: string }).teamId === principal.teamId
}

export function attachSockets(io: Server, deps: SocketDeps): void {
  const connected = new Map<string, Map<string, Principal>>() // leagueId -> socketId -> principal
  const clockNow = deps.clockNow ?? (() => Date.now())

  const presence = (leagueId: string) => {
    const list = [...(connected.get(leagueId)?.values() ?? [])].map(p =>
      p.role === 'manager' ? { role: p.role, teamId: p.teamId } : { role: p.role },
    )
    io.to(`league:${leagueId}`).emit('presence', { connected: list })
  }

  // Deadlines are absolute server epoch ms, so a client renders the correct countdown
  // only if it knows the server's clock at snapshot time — a skewed client clock would
  // otherwise misrender it.
  const snapshotFor = (room: { lastSeq: number; state: unknown }, p: Principal) => ({
    seq: room.lastSeq,
    state: room.state,
    role: p.role,
    now: clockNow(),
    ...(p.role === 'manager' ? { teamId: p.teamId } : {}),
  })

  /** A reload rebuilds the room from a new config (e.g. the player pool frozen at
   *  draft start). Clients that joined earlier hold a snapshot whose config is now
   *  stale, and events never carry config — so push a fresh snapshot to each. */
  const resyncLeague = (leagueId: string, room: { lastSeq: number; state: unknown }) => {
    for (const [socketId, p] of connected.get(leagueId) ?? []) {
      io.sockets.sockets.get(socketId)?.emit('snapshot', snapshotFor(room, p))
    }
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token
    const principal = typeof token === 'string' ? await deps.leagues.resolveToken(token) : null
    if (!principal) return next(new Error('unauthorized'))
    ;(socket.data as { principal: Principal }).principal = principal
    next()
  })

  io.on('connection', (socket: Socket) => {
    const principal = (socket.data as { principal: Principal }).principal
    const { leagueId } = principal

    // Join/snapshot needs I/O, but socket.io DROPS events that arrive before a
    // listener exists — a client bidding the instant it connects would get no ack
    // at all. So register listeners synchronously and have them await readiness.
    const ready = (async () => {
      const room = await deps.rooms.getOrLoad(leagueId)
      if (!room) {
        socket.disconnect(true)
        return null
      }
      await socket.join(`league:${leagueId}`)
      if (!connected.has(leagueId)) connected.set(leagueId, new Map())
      connected.get(leagueId)!.set(socket.id, principal)
      socket.emit('snapshot', snapshotFor(room, principal))
      presence(leagueId)
      return room
    })()
    ready.catch(() => socket.disconnect(true))

    socket.on('command', async (payload: unknown, ack: Ack) => {
      if (typeof ack !== 'function') return
      if (!(await ready.catch(() => null))) return deny(ack, 'NO_LEAGUE', 'league not found')
      let cmd: WireCommand
      try {
        cmd = parseWireCommand(payload)
      } catch (err) {
        return deny(ack, 'INVALID_COMMAND', err instanceof ZodError ? err.issues.map(i => i.message).join('; ') : 'invalid command')
      }
      if (!authorized(principal, cmd)) return deny(ack, 'FORBIDDEN', 'not allowed for your role')

      let target = await deps.rooms.getOrLoad(leagueId)
      if (!target) return deny(ack, 'NO_LEAGUE', 'league not found')

      if (cmd.type === 'START_DRAFT' && !(await deps.leagues.frozenConfig(leagueId))) {
        const rec = await deps.leagues.get(leagueId)
        // Undraftable positions (e.g. a league with maxPerPosition.K = 0, dropping
        // kickers) never enter the frozen config, the player search, or the snapshot.
        const pool = (await deps.playerRepo.listForDraft())
          .filter(p => !rec || isDraftablePosition(rec.config as LeagueConfig, p.position))
        const needed = rec ? rec.config.teams.length * rosterCapacity(rec.config.rosterTemplate) : 1
        if (pool.length < needed) {
          return deny(ack, 'NO_PLAYERS', `player pool has ${pool.length}, need at least ${needed} — refresh players first`)
        }
        await deps.leagues.freeze(leagueId, pool)
        target = await deps.rooms.reload(leagueId)
        if (!target) return deny(ack, 'NO_LEAGUE', 'league not found')
        resyncLeague(leagueId, target)
      }

      try {
        const result = await target.dispatch(cmd)
        if (result.ok) return ack({ ok: true })
        return ack({ ok: false, error: { code: result.error.code, message: result.error.message } })
      } catch {
        // Store/infra failure: the command was NOT applied. Client keeps its state; commissioner pauses.
        return deny(ack, 'INTERNAL', 'server error — command not applied')
      }
    })

    socket.on('disconnect', () => {
      void ready.catch(() => null).then(() => {
        connected.get(leagueId)?.delete(socket.id)
        presence(leagueId)
      })
    })
  })
}
