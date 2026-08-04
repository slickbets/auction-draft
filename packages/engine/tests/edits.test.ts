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
    expect(r.state.teams['T5']!.roster[0]).toMatchObject({ price: 40 })
  })

  it('rejects unknown sales and edits that break the budget invariant', () => {
    const s = afterOneSale()
    const missing = run(s, { type: 'EDIT_PICK', overall: 99, newPrice: 5, now: 20_000 })
    expect(!missing.ok && missing.error.code).toBe('INVALID_EDIT')
    const broke = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 186, now: 20_000 })
    expect(!broke.ok && broke.error.code).toBe('INVALID_EDIT') // T5 would have budget 14 < 15 open slots
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
