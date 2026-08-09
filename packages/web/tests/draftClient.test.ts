import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import { buildServer } from '../../server/src/main.js'
import { LeagueService } from '../../server/src/league.js'
import { PlayerRepo } from '../../server/src/players.js'
import { createDraftClient, type DraftClient, type DraftView } from '../src/client/draftClient.js'

const CONFIG = {
  teams: [{ id: 'T1', name: 'Cook' }, { id: 'T2', name: 'Dave' }],
  budget: 200,
  rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }, { name: 'BENCH', eligible: ['QB', 'RB'], count: 1 }],
  bidClockMs: 60_000,
  nominationClockMs: 60_000,
  nominationOrder: ['T1', 'T2'],
  nominationExpiryPolicy: 'auto_nominate',
}
const PLAYERS = [
  { sleeperId: 'q1', name: 'QB One', position: 'QB' as const, nflTeam: 'SF', status: 'Active', searchRank: 1 },
  { sleeperId: 'q2', name: 'QB Two', position: 'QB' as const, nflTeam: 'KC', status: 'Active', searchRank: 2 },
  { sleeperId: 'r1', name: 'RB One', position: 'RB' as const, nflTeam: 'ATL', status: 'Active', searchRank: 3 },
  { sleeperId: 'r2', name: 'RB Two', position: 'RB' as const, nflTeam: 'DAL', status: 'Active', searchRank: 4 },
]

function memPool() {
  const db = newDb()
  const { Pool } = db.adapters.createPg()
  return new Pool() as any
}
const settled = (c: DraftClient, p: (v: DraftView) => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    if (p(c.view)) return resolve()
    const t = setTimeout(() => reject(new Error(`condition not met; view=${JSON.stringify(c.view.status)}`)), ms)
    const un = c.subscribe(v => { if (p(v)) { clearTimeout(t); un(); resolve() } })
  })

describe('draftClient', () => {
  let server: Awaited<ReturnType<typeof buildServer>>
  let url: string
  let links: any
  const clients: DraftClient[] = []

  beforeEach(async () => {
    const pool = memPool()
    server = await buildServer(
      { DATABASE_URL: 'unused', PORT: 0, BASE_URL: 'http://localhost', CREATE_KEY: 'k', SLEEPER_SYNC: '0' } as any,
      pool,
    )
    await new Promise<void>(r => server.http.listen(0, r))
    url = `http://localhost:${(server.http.address() as any).port}`
    await new PlayerRepo(pool).upsertAll(PLAYERS)
    links = (await new LeagueService(pool, url).create('Sim', CONFIG)).links
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close()
    await server.close()
  })

  const open = (link: string) => {
    const c = createDraftClient({ url, token: link.split('#')[1]! })
    clients.push(c)
    return c
  }

  it('connects, snapshots, and reports role and team', async () => {
    const c = open(links.teams[0].url)
    await settled(c, v => v.status === 'live')
    expect(c.view.role).toBe('manager')
    expect(c.view.teamId).toBe('T1')
    expect(c.view.state!.phase.type).toBe('lobby')
  })

  it('rejects a bad token instead of hanging', async () => {
    const c = createDraftClient({ url, token: 'garbage' })
    clients.push(c)
    await settled(c, v => v.status === 'rejected')
    expect(c.view.state).toBeNull()
  })

  it('folds broadcast events so every client converges on identical state', async () => {
    const commish = open(links.commissioner)
    const mgr = open(links.teams[0].url)
    await settled(commish, v => v.status === 'live')
    await settled(mgr, v => v.status === 'live')
    expect((await commish.send({ type: 'START_DRAFT' })).ok).toBe(true)
    await settled(mgr, v => v.state?.phase.type === 'awaiting_nomination')
    expect(mgr.view.state).toStrictEqual(commish.view.state)
    expect(mgr.view.seq).toBe(commish.view.seq)
  })

  it('surfaces a rejected command without corrupting state', async () => {
    const mgr = open(links.teams[0].url)
    await settled(mgr, v => v.status === 'live')
    const before = mgr.view.state
    const ack = await mgr.send({ type: 'NOMINATE', teamId: 'T1', playerId: 'q1', openingBid: 5 })
    expect(ack.ok).toBe(false)
    expect(mgr.view.lastError?.code).toBeTruthy()
    expect(mgr.view.state).toStrictEqual(before)
    mgr.dismissError()
    expect(mgr.view.lastError).toBeNull()
  })

  it('corrects for a skewed device clock', async () => {
    const c = open(links.teams[0].url)
    await settled(c, v => v.status === 'live')
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 60_000 // device runs a minute fast
      const deadline = realNow() + 10_000
      expect(c.msLeft(deadline)).toBeGreaterThan(8_000)
      expect(c.msLeft(deadline)).toBeLessThanOrEqual(10_000)
    } finally {
      Date.now = realNow
    }
  })

  it('reports presence for connected seats', async () => {
    const a = open(links.teams[0].url)
    const b = open(links.teams[1].url)
    await settled(a, v => v.status === 'live')
    await settled(b, v => v.status === 'live')
    await settled(a, v => v.presence.some(p => p.teamId === 'T2'))
    expect(a.view.presence.filter(p => p.teamId === 'T1')).toHaveLength(1)
  })
})
