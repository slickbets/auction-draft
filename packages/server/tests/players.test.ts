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
  // Sleeper also emits empty strings and junk ranks, not just nulls:
  '555': { full_name: 'Blank Team Guy', position: 'TE', team: '', status: '', search_rank: 400 },
  '666': { full_name: 'Nan Rank Guy', position: 'K', team: 'DEN', status: 'Active', search_rank: NaN },
}

describe('toPlayerRows', () => {
  it('filters, maps DEF->DST, defaults FA team and missing rank, drops nameless', () => {
    const rows = toPlayerRows(FIXTURE)
    const ids = rows.map(r => r.sleeperId).sort()
    expect(ids).toEqual(['1234', '4046', '555', '666', '9509', 'SF']) // C dropped, nameless WR dropped
    const dst = rows.find(r => r.sleeperId === 'SF')!
    expect(dst.position).toBe('DST')
    const fa = rows.find(r => r.sleeperId === '1234')!
    expect(fa.nflTeam).toBe('FA')
    expect(fa.searchRank).toBe(9_999_999)
  })

  it('never emits a row that freeze() would reject', () => {
    // freeze() requires non-empty id/name/nflTeam, an engine position, and a finite rank.
    // An empty-string team from Sleeper would otherwise block the draft from starting.
    const rows = toPlayerRows(FIXTURE)
    const blank = rows.find(r => r.sleeperId === '555')!
    expect(blank.nflTeam).toBe('FA')
    expect(blank.status).toBe('Unknown')
    const nan = rows.find(r => r.sleeperId === '666')!
    expect(nan.searchRank).toBe(9_999_999)
    for (const r of rows) {
      expect(r.sleeperId.length).toBeGreaterThan(0)
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.nflTeam.length).toBeGreaterThan(0)
      expect(Number.isFinite(r.searchRank)).toBe(true)
      expect(['QB', 'RB', 'WR', 'TE', 'K', 'DST']).toContain(r.position)
    }
  })
})

describe('PlayerRepo', () => {
  it('upserts idempotently and lists as ranked engine PlayerInfo', async () => {
    const pool = newTestPool()
    await migrate(pool)
    const repo = new PlayerRepo(pool)
    const n1 = await repo.upsertAll(toPlayerRows(FIXTURE))
    expect(n1).toBe(6)
    const n2 = await repo.upsertAll(toPlayerRows(FIXTURE)) // same again: update, not duplicate
    expect(n2).toBe(6)
    const list = await repo.listForDraft()
    expect(list[0]).toEqual({ id: '9509', name: 'Bijan Robinson', position: 'RB', nflTeam: 'ATL', rank: 1 })
    expect(list.map(p => p.rank)).toEqual([...list.map(p => p.rank)].sort((a, b) => a - b))
    expect(list).toHaveLength(6)
  })

  it('upserts across chunk boundaries and applies updates from a later feed', async () => {
    const pool = newTestPool()
    await migrate(pool)
    const repo = new PlayerRepo(pool)
    const many = Array.from({ length: 7 }, (_, i) => ({
      sleeperId: `p${i}`, name: `P ${i}`, position: 'RB' as const, nflTeam: 'FA', status: 'Active', searchRank: i + 1,
    }))
    await repo.upsertAll(many, 3) // force multiple chunks
    expect(await repo.listForDraft()).toHaveLength(7)
    // a later feed moves a player and re-ranks him
    await repo.upsertAll([{ ...many[0]!, name: 'P 0 Traded', nflTeam: 'BUF', searchRank: 99 }], 3)
    const list = await repo.listForDraft()
    expect(list).toHaveLength(7)
    expect(list.find(p => p.id === 'p0')).toEqual({ id: 'p0', name: 'P 0 Traded', position: 'RB', nflTeam: 'BUF', rank: 99 })
    expect(list[list.length - 1]!.id).toBe('p0') // re-ranked to the end
  })
})
