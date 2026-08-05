import { describe, it, expect } from 'vitest'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { toPlayerRows, PlayerRepo, type SleeperPlayerMap } from '../src/players.js'

const FIXTURE: SleeperPlayerMap = {
  '4046': { full_name: 'Patrick Mahomes', position: 'QB', team: 'KC', status: 'Active', search_rank: 20 },
  '9509': { full_name: 'Bijan Robinson', position: 'RB', team: 'ATL', status: 'Active', search_rank: 1 },
  'SF': { full_name: 'San Francisco 49ers', position: 'DEF', team: 'SF', status: 'Active', search_rank: 300 },
  '1234': { full_name: 'Practice Squad Guy', position: 'RB', team: null, status: 'Active', search_rank: null },
  '777': { full_name: 'Some Center', position: 'C', team: 'DAL', status: 'Active', search_rank: 500 },
  '888': { position: 'WR', team: 'NYJ', status: 'Active', search_rank: 50 },
}

describe('toPlayerRows', () => {
  it('filters, maps DEF->DST, defaults FA team and missing rank, drops nameless', () => {
    const rows = toPlayerRows(FIXTURE)
    const ids = rows.map(r => r.sleeperId).sort()
    expect(ids).toEqual(['1234', '4046', '9509', 'SF']) // C dropped, nameless WR dropped
    const dst = rows.find(r => r.sleeperId === 'SF')!
    expect(dst.position).toBe('DST')
    const fa = rows.find(r => r.sleeperId === '1234')!
    expect(fa.nflTeam).toBe('FA')
    expect(fa.searchRank).toBe(9_999_999)
  })
})

describe('PlayerRepo', () => {
  it('upserts idempotently and lists as ranked engine PlayerInfo', async () => {
    const pool = newTestPool()
    await migrate(pool)
    const repo = new PlayerRepo(pool)
    const n1 = await repo.upsertAll(toPlayerRows(FIXTURE))
    expect(n1).toBe(4)
    const n2 = await repo.upsertAll(toPlayerRows(FIXTURE)) // same again: update, not duplicate
    expect(n2).toBe(4)
    const list = await repo.listForDraft()
    expect(list[0]).toEqual({ id: '9509', name: 'Bijan Robinson', position: 'RB', nflTeam: 'ATL', rank: 1 })
    expect(list.map(p => p.rank)).toEqual([...list.map(p => p.rank)].sort((a, b) => a - b))
    expect(list).toHaveLength(4)
  })
})
