import { describe, it, expect } from 'vitest'
import { initialState, run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'
import { testConfig } from './fixtures.js'

describe('clock control', () => {
  it('pause stores remaining time; resume re-arms the deadline from now', () => {
    let s = startedDraft() // awaiting_nomination, deadline 31_000
    s = mustRun(s, { type: 'PAUSE', now: 11_000 }) // 20_000 remaining
    expect(s.phase).toMatchObject({ type: 'paused', remainingMs: 20_000 })
    const bid = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 1, now: 12_000 })
    expect(!bid.ok && bid.error.code).toBe('WRONG_PHASE') // nothing happens while paused
    s = mustRun(s, { type: 'RESUME', now: 60_000 })
    expect(s.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1', deadline: 80_000 })
  })

  it('ADD_TIME extends a live bidding countdown', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 5, now: 2000 }) // deadline 12_000
    s = mustRun(s, { type: 'ADD_TIME', ms: 15_000, now: 5000 })
    expect(s.phase).toMatchObject({ type: 'bidding', deadline: 27_000 })
  })

  it('ADD_TIME while paused extends remainingMs', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'PAUSE', now: 11_000 })
    s = mustRun(s, { type: 'ADD_TIME', ms: 5000, now: 12_000 })
    expect(s.phase).toMatchObject({ type: 'paused', remainingMs: 25_000 })
  })

  it('SET_TIMERS affects future phases, not the live countdown', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'SET_TIMERS', bidClockMs: 5000, now: 3000 })
    expect(s.phase).toMatchObject({ type: 'awaiting_nomination', deadline: 31_000 }) // unchanged
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 1, now: 4000 })
    expect(s.phase).toMatchObject({ type: 'bidding', deadline: 9000 }) // new 5s clock
  })

  it('pause during bidding preserves price and high bidder through resume', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 5, now: 2000 })
    s = mustRun(s, { type: 'BID', teamId: 'T4', amount: 12, now: 4000 }) // deadline 14_000
    s = mustRun(s, { type: 'PAUSE', now: 9000 }) // 5000 remaining
    expect(s.phase).toMatchObject({ type: 'paused', remainingMs: 5000 })
    s = mustRun(s, { type: 'RESUME', now: 30_000 })
    expect(s.phase).toMatchObject({
      type: 'bidding', playerId: 'RB1', price: 12, highBidderId: 'T4', nominatorId: 'T1', deadline: 35_000,
    })
  })

  it('pausing after the deadline clamps remaining time to zero', () => {
    let s = startedDraft() // nomination deadline 31_000
    s = mustRun(s, { type: 'PAUSE', now: 40_000 })
    expect(s.phase).toMatchObject({ type: 'paused', remainingMs: 0 })
    s = mustRun(s, { type: 'RESUME', now: 50_000 })
    expect(s.phase).toMatchObject({ type: 'awaiting_nomination', deadline: 50_000 })
  })

  it('cannot pause the lobby or resume a running draft', () => {
    const fresh = initialState(testConfig())
    const p = run(fresh, { type: 'PAUSE', now: 500 })
    expect(!p.ok && p.error.code).toBe('WRONG_PHASE')
    const lobby = run(startedDraft(), { type: 'RESUME', now: 5000 })
    expect(!lobby.ok && lobby.error.code).toBe('WRONG_PHASE')
  })
})
