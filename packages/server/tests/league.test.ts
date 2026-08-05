import { describe, it, expect, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { LeagueService } from '../src/league.js'
import type { PlayerInfo } from '@auction/engine'

const TEMPLATE = [
  { name: 'QB', eligible: ['QB'], count: 1 },
  { name: 'BENCH', eligible: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], count: 2 },
]
const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
const goodConfig = () => ({
  teams: teams(10),
  budget: 200,
  rosterTemplate: TEMPLATE,
  bidClockMs: 10_000,
  nominationClockMs: 30_000,
  nominationOrder: teams(10).map(t => t.id),
  nominationExpiryPolicy: 'auto_nominate',
})
const POOL: PlayerInfo[] = [{ id: 'p1', name: 'QB One', position: 'QB', nflTeam: 'SF', rank: 1 }]

describe('LeagueService', () => {
  let pool: Pool
  let svc: LeagueService
  beforeEach(async () => {
    pool = newTestPool()
    await migrate(pool)
    svc = new LeagueService(pool, 'http://localhost:3000')
  })

  it('creates a league with per-team invite links and resolves every token', async () => {
    const created = await svc.create('My League', goodConfig())
    expect(created.links.teams).toHaveLength(10)
    expect(created.links.commissioner).toContain(`/draft/${created.id}#`)
    const commish = await svc.resolveToken(created.links.commissioner.split('#')[1]!)
    expect(commish).toEqual({ leagueId: created.id, role: 'commissioner' })
    const board = await svc.resolveToken(created.links.board.split('#')[1]!)
    expect(board).toEqual({ leagueId: created.id, role: 'board' })
    const t3 = created.links.teams.find(t => t.teamId === 'T3')!
    const mgr = await svc.resolveToken(t3.url.split('#')[1]!)
    expect(mgr).toEqual({ leagueId: created.id, role: 'manager', teamId: 'T3' })
    expect(await svc.resolveToken('nope')).toBeNull()
  })

  it('rejects every malformed config shape', async () => {
    const cases: { label: string; mutate: (c: any) => void; match?: RegExp }[] = [
      { label: 'budget below roster capacity', mutate: c => (c.budget = 2), match: /budget/i },
      { label: 'non-integer budget', mutate: c => (c.budget = 200.5) },
      { label: 'one team', mutate: c => (c.teams = c.teams.slice(0, 1)) },
      { label: 'empty teams', mutate: c => (c.teams = []) },
      { label: 'twenty-one teams', mutate: c => { c.teams = Array.from({ length: 21 }, (_, i) => ({ id: `X${i}`, name: `X ${i}` })); c.nominationOrder = c.teams.map((t: any) => t.id) } },
      { label: 'empty team id', mutate: c => (c.teams[0].id = '') },
      { label: 'empty team name', mutate: c => (c.teams[0].name = '') },
      { label: 'duplicate team ids', mutate: c => { c.teams[1].id = 'T1'; c.nominationOrder = c.teams.map((t: any) => t.id) }, match: /duplicate/i },
      { label: 'nominationOrder wrong length', mutate: c => (c.nominationOrder = ['T1']), match: /order/i },
      { label: 'nominationOrder unknown id', mutate: c => (c.nominationOrder[0] = 'ZZ'), match: /order/i },
      { label: 'empty rosterTemplate', mutate: c => (c.rosterTemplate = []) },
      { label: 'slot with empty eligible', mutate: c => (c.rosterTemplate[0].eligible = []) },
      { label: 'slot with bad position', mutate: c => (c.rosterTemplate[0].eligible = ['P']) },
      { label: 'slot count zero', mutate: c => (c.rosterTemplate[0].count = 0) },
      { label: 'bid clock too low', mutate: c => (c.bidClockMs = 500) },
      { label: 'nomination clock too high', mutate: c => (c.nominationClockMs = 900_000) },
      { label: 'bad expiry policy', mutate: c => (c.nominationExpiryPolicy = 'nope') },
    ]
    for (const { label, mutate, match } of cases) {
      const cfg = JSON.parse(JSON.stringify(goodConfig()))
      mutate(cfg)
      await expect(svc.create('X', cfg), label).rejects.toThrow(match ?? /./)
    }
  })

  it('rejects an empty or duplicate-id player pool, and an empty league name', async () => {
    const created = await svc.create('My League', goodConfig())
    await expect(svc.freeze(created.id, [])).rejects.toThrow()
    await expect(svc.freeze(created.id, [POOL[0]!, POOL[0]!])).rejects.toThrow(/duplicate/i)
    await expect(svc.create('', goodConfig())).rejects.toThrow()
  })

  it('freeze is atomic: concurrent calls agree on one pool', async () => {
    const created = await svc.create('My League', goodConfig())
    const poolA = [{ id: 'a1', name: 'A One', position: 'QB' as const, nflTeam: 'SF', rank: 1 }]
    const poolB = [{ id: 'b1', name: 'B One', position: 'RB' as const, nflTeam: 'KC', rank: 2 }]
    const [ra, rb] = await Promise.all([svc.freeze(created.id, poolA), svc.freeze(created.id, poolB)])
    expect(ra.players).toEqual(rb.players)
    const stored = await svc.frozenConfig(created.id)
    expect(stored!.players).toEqual(ra.players)
  })

  it('freeze snapshots players once and is idempotent', async () => {
    const created = await svc.create('My League', goodConfig())
    expect(await svc.frozenConfig(created.id)).toBeNull()
    const frozen = await svc.freeze(created.id, POOL)
    expect(frozen.players).toEqual(POOL)
    const again = await svc.freeze(created.id, [])
    expect(again.players).toEqual(POOL) // second freeze ignored, and not rejected by pool validation
    expect((await svc.frozenConfig(created.id))!.players).toEqual(POOL)
  })
})
