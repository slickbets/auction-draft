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

  it('rejects invalid configs', async () => {
    await expect(svc.create('X', { ...goodConfig(), budget: 2 })).rejects.toThrow(/budget/i)
    await expect(svc.create('X', { ...goodConfig(), nominationOrder: ['T1'] })).rejects.toThrow(/order/i)
    const dup = goodConfig()
    dup.teams[1] = { id: 'T1', name: 'Dup' }
    await expect(svc.create('X', dup)).rejects.toThrow()
    await expect(svc.create('X', { ...goodConfig(), bidClockMs: 500 })).rejects.toThrow()
  })

  it('freeze snapshots players once and is idempotent', async () => {
    const created = await svc.create('My League', goodConfig())
    expect(await svc.frozenConfig(created.id)).toBeNull()
    const frozen = await svc.freeze(created.id, POOL)
    expect(frozen.players).toEqual(POOL)
    const again = await svc.freeze(created.id, [])
    expect(again.players).toEqual(POOL) // second freeze ignored
    expect((await svc.frozenConfig(created.id))!.players).toEqual(POOL)
  })
})
