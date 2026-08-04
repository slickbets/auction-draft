import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

function afterOneSale() {
  let s = startedDraft()
  s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now: 2000 })
  s = mustRun(s, { type: 'BID', teamId: 'T5', amount: 42, now: 4000 })
  s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 14_000 }) // sold to T5, T2 on the clock
  return s
}

describe('UNDO_SALE', () => {
  it('reverses the sale: refund, roster removal, player back in pool, nominator back on the clock', () => {
    const s = afterOneSale()
    const r = run(s, { type: 'UNDO_SALE', now: 20_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.teams['T5']!.budget).toBe(200)
    expect(r.state.teams['T5']!.roster).toEqual([])
    expect(r.state.available).toContain('RB1')
    expect(r.state.sales).toHaveLength(0)
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1', deadline: 50_000 })
  })

  it('cancels an in-flight auction too, returning that player to the pool', () => {
    let s = afterOneSale() // T2 on the clock
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'WR1', openingBid: 3, now: 16_000 })
    const r = run(s, { type: 'UNDO_SALE', now: 17_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.available).toContain('WR1')
    expect(r.state.available).toContain('RB1')
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1' })
  })

  it('rejects when there is nothing to undo', () => {
    const s = startedDraft()
    const r = run(s, { type: 'UNDO_SALE', now: 5000 })
    expect(!r.ok && r.error.code).toBe('NOTHING_TO_UNDO')
  })

  it('reopens a completed draft', () => {
    const tiny = { rosterTemplate: [{ name: 'QB', eligible: ['QB' as const], count: 1 }] }
    let s = startedDraft({ ...tiny, teams: [{ id: 'T1', name: 'A' }, { id: 'T2', name: 'B' }], nominationOrder: ['T1', 'T2'] })
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 1, now: 2000 })
    s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 12_000 })
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'QB2', openingBid: 1, now: 13_000 })
    s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 23_000 }) // complete
    expect(s.phase.type).toBe('complete')
    const r = run(s, { type: 'UNDO_SALE', now: 30_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
  })
})
