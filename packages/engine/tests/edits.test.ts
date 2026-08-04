import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

function afterOneSale() {
  let s = startedDraft()
  s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now: 2000 })
  s = mustRun(s, { type: 'BID', teamId: 'T5', amount: 42, now: 4000 })
  s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 14_000 })
  return s
}

describe('EDIT_PICK', () => {
  it('moves a sold player to another team with budget transfer and re-slotting', () => {
    const s = afterOneSale()
    const r = run(s, { type: 'EDIT_PICK', overall: 1, newTeamId: 'T3', now: 20_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.teams['T5']!.budget).toBe(200)
    expect(r.state.teams['T5']!.roster).toEqual([])
    expect(r.state.teams['T3']!.budget).toBe(158)
    expect(r.state.teams['T3']!.roster).toEqual([{ playerId: 'RB1', price: 42, slot: 'RB' }])
    expect(r.state.sales[0]).toMatchObject({ teamId: 'T3', price: 42 })
  })

  it('corrects a price in place', () => {
    const s = afterOneSale()
    const r = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 40, now: 20_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.teams['T5']!.budget).toBe(160)
    expect(r.state.teams['T5']!.roster[0]).toEqual({ playerId: 'RB1', price: 40, slot: 'RB' })
  })

  it('rejects unknown sales and edits that break the budget invariant', () => {
    const s = afterOneSale()
    const missing = run(s, { type: 'EDIT_PICK', overall: 99, newPrice: 5, now: 20_000 })
    expect(!missing.ok && missing.error.code).toBe('INVALID_EDIT')
    const broke = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 186, now: 20_000 })
    expect(!broke.ok && broke.error.code).toBe('INVALID_EDIT') // T5 would have budget 14 < 15 open slots
  })

  it('rejects edits and budget changes while an auction is live or paused over one', () => {
    let s = afterOneSale()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'WR1', openingBid: 3, now: 16_000 })
    const e1 = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 40, now: 17_000 })
    expect(!e1.ok && e1.error.code).toBe('WRONG_PHASE')
    const a1 = run(s, { type: 'ADJUST_BUDGET', teamId: 'T2', delta: 10, now: 17_000 })
    expect(!a1.ok && a1.error.code).toBe('WRONG_PHASE')
    s = mustRun(s, { type: 'PAUSE', now: 17_000 })
    const e2 = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 40, now: 18_000 })
    expect(!e2.ok && e2.error.code).toBe('WRONG_PHASE')
  })

  it('cross-team destination boundary: exact invariant passes, one dollar past fails', () => {
    let s = afterOneSale()
    s = mustRun(s, { type: 'ADJUST_BUDGET', teamId: 'T2', delta: -140, now: 20_000 }) // T2: $60, 16 open
    const past = run(s, { type: 'EDIT_PICK', overall: 1, newTeamId: 'T2', newPrice: 46, now: 21_000 })
    expect(!past.ok && past.error.code).toBe('INVALID_EDIT') // 60-46=14 < 15 open after add
    const exact = run(s, { type: 'EDIT_PICK', overall: 1, newTeamId: 'T2', newPrice: 45, now: 21_000 })
    if (!exact.ok) throw new Error(exact.error.code)
    expect(exact.state.teams['T2']!.budget).toBe(15)
    expect(exact.state.teams['T2']!.roster).toEqual([{ playerId: 'RB1', price: 45, slot: 'RB' }])
  })

  it('rejects unknown teams, bad prices, and fractional deltas', () => {
    const s = afterOneSale()
    const t = run(s, { type: 'EDIT_PICK', overall: 1, newTeamId: 'NOPE', now: 20_000 })
    expect(!t.ok && t.error.code).toBe('UNKNOWN_TEAM')
    const p = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 1.5, now: 20_000 })
    expect(!p.ok && p.error.code).toBe('INVALID_EDIT')
    const z = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 0, now: 20_000 })
    expect(!z.ok && z.error.code).toBe('INVALID_EDIT')
    const d = run(s, { type: 'ADJUST_BUDGET', teamId: 'T2', delta: 2.5, now: 20_000 })
    expect(!d.ok && d.error.code).toBe('INVALID_ADJUSTMENT')
  })
})

describe('ADJUST_BUDGET', () => {
  it('applies a delta and rejects one that breaks the invariant', () => {
    const s = afterOneSale()
    const up = run(s, { type: 'ADJUST_BUDGET', teamId: 'T2', delta: 50, now: 20_000 })
    if (!up.ok) throw new Error(up.error.code)
    expect(up.state.teams['T2']!.budget).toBe(250)
    const down = run(s, { type: 'ADJUST_BUDGET', teamId: 'T2', delta: -185, now: 20_000 })
    expect(!down.ok && down.error.code).toBe('INVALID_ADJUSTMENT') // 15 < 16 open slots
  })
})
