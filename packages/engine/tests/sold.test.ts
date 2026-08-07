import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

describe('CLOCK_EXPIRED during bidding', () => {
  it('sells to high bidder, deducts budget, assigns slot, advances nomination to T2', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now: 2000 })
    s = mustRun(s, { type: 'BID', teamId: 'T5', amount: 42, now: 4000 })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 14_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['SOLD', 'NOMINATION_STARTED'])
    const sold = r.events[0]!
    expect(sold).toMatchObject({ type: 'SOLD', playerId: 'RB1', teamId: 'T5', price: 42, slot: 'RB', overall: 1 })
    expect(r.state.teams['T5']!.budget).toBe(158)
    expect(r.state.teams['T5']!.roster).toEqual([{ playerId: 'RB1', price: 42, slot: 'RB', position: 'RB' }])
    expect(r.state.available).not.toContain('RB1')
    expect(r.state.sales).toHaveLength(1)
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
  })

  it('unopposed nomination sells to the nominator at opening price', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 7, now: 2000 })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 12_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events[0]).toMatchObject({ type: 'SOLD', teamId: 'T1', price: 7 })
  })

  it('rejects expiry before the deadline', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 7, now: 2000 })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 11_999 })
    expect(!r.ok && r.error.code).toBe('CLOCK_NOT_EXPIRED')
  })

  it('completes the draft when the last roster spot fills', () => {
    // 2-team league with 1 QB slot each: two sales end the draft.
    const tiny = { rosterTemplate: [{ name: 'QB', eligible: ['QB' as const], count: 1 }] }
    let s = startedDraft({
      ...tiny,
      teams: [{ id: 'T1', name: 'A' }, { id: 'T2', name: 'B' }],
      nominationOrder: ['T1', 'T2'],
    })
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 1, now: 2000 })
    s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 12_000 }) // T1 full; next nominator is T2
    expect(s.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'QB2', openingBid: 1, now: 13_000 })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 23_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['SOLD', 'DRAFT_COMPLETED'])
    expect(r.state.phase).toEqual({ type: 'complete' })
  })
})
