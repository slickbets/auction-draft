import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

function bidding(now = 2000) {
  return mustRun(startedDraft(), { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now })
}

describe('BID', () => {
  it('valid bid raises price, sets high bidder, resets deadline', () => {
    const s = bidding()
    const r = run(s, { type: 'BID', teamId: 'T2', amount: 11, now: 5000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.phase).toMatchObject({ type: 'bidding', price: 11, highBidderId: 'T2', deadline: 15_000 })
  })

  it('rejects stale price (amount <= current)', () => {
    const s = bidding()
    const r = run(s, { type: 'BID', teamId: 'T2', amount: 10, now: 5000 })
    expect(!r.ok && r.error.code).toBe('STALE_PRICE')
  })

  it('rejects the current high bidder raising themselves', () => {
    const s = bidding()
    const r = run(s, { type: 'BID', teamId: 'T1', amount: 12, now: 5000 })
    expect(!r.ok && r.error.code).toBe('ALREADY_HIGH_BIDDER')
  })

  it('rejects bids over maxBid and non-integers', () => {
    const s = bidding()
    const over = run(s, { type: 'BID', teamId: 'T2', amount: 186, now: 5000 })
    expect(!over.ok && over.error.code).toBe('EXCEEDS_MAX_BID')
    const frac = run(s, { type: 'BID', teamId: 'T2', amount: 11.5, now: 5000 })
    expect(!frac.ok && frac.error.code).toBe('INVALID_AMOUNT')
  })

  it('rejects a bidder with no eligible open slot for the player', () => {
    const s = bidding()
    // Fill T2's only RB-capable slots so an RB no longer fits.
    const s2 = structuredClone(s)
    const t2 = s2.teams['T2']!
    t2.roster = [
      { playerId: 'RB2', price: 1, slot: 'RB' }, { playerId: 'RB3', price: 1, slot: 'RB' },
      { playerId: 'RB4', price: 1, slot: 'FLEX' },
      ...Array.from({ length: 7 }, (_, i) => ({ playerId: `WR${i + 1}`, price: 1, slot: 'BENCH' })),
    ]
    t2.budget = 190
    const r = run(s2, { type: 'BID', teamId: 'T2', amount: 11, now: 5000 })
    expect(!r.ok && r.error.code).toBe('NO_ELIGIBLE_SLOT')
  })

  it('race semantics: two bids at same amount — first wins, second gets STALE_PRICE', () => {
    const s = bidding()
    const first = run(s, { type: 'BID', teamId: 'T2', amount: 11, now: 5000 })
    if (!first.ok) throw new Error('first bid should win')
    const second = run(first.state, { type: 'BID', teamId: 'T3', amount: 11, now: 5001 })
    expect(!second.ok && second.error.code).toBe('STALE_PRICE')
  })
})
