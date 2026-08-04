import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft } from './helpers.js'

describe('NOMINATE', () => {
  it('moves to bidding with nominator as high bidder at opening price', () => {
    const s = startedDraft()
    const r = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 23, now: 2000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.phase).toEqual({
      type: 'bidding', playerId: 'RB1', price: 23, highBidderId: 'T1', nominatorId: 'T1', deadline: 2000 + 10_000,
    })
  })

  it('rejects nomination from a team not on the clock', () => {
    const s = startedDraft()
    const r = run(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'RB1', openingBid: 1, now: 2000 })
    expect(!r.ok && r.error.code).toBe('NOT_YOUR_NOMINATION')
  })

  it('rejects unavailable player, sub-$1 and non-integer bids, and bids over max', () => {
    const s = startedDraft()
    expect(!run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'NOPE', openingBid: 1, now: 2000 }).ok).toBe(true)
    const low = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 0, now: 2000 })
    expect(!low.ok && low.error.code).toBe('INVALID_AMOUNT')
    const frac = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 1.5, now: 2000 })
    expect(!frac.ok && frac.error.code).toBe('INVALID_AMOUNT')
    const high = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 186, now: 2000 })
    expect(!high.ok && high.error.code).toBe('EXCEEDS_MAX_BID') // maxBid is 185 (Task 2)
  })

  it('rejects nominating a player the team has no slot for', () => {
    const s = startedDraft({ rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }] })
    const r = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 1, now: 2000 })
    expect(!r.ok && r.error.code).toBe('NO_ELIGIBLE_SLOT')
  })
})
