import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft } from './helpers.js'
import { makePlayers } from './fixtures.js'

describe('nomination clock expiry', () => {
  it('auto_nominate puts the best-ranked player up at $1 for the team on the clock', () => {
    const s = startedDraft() // policy auto_nominate; best rank is QB1 (rank 1)
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 31_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events[0]).toMatchObject({ type: 'PLAYER_NOMINATED', teamId: 'T1', playerId: 'QB1', openingBid: 1 })
    expect(r.state.phase).toMatchObject({ type: 'bidding', playerId: 'QB1', price: 1, highBidderId: 'T1' })
  })

  it('skip policy passes to the next team', () => {
    const s = startedDraft({ nominationExpiryPolicy: 'skip' })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 31_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['NOMINATION_SKIPPED', 'NOMINATION_STARTED'])
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2', deadline: 31_000 + 30_000 })
  })

  it('rejects expiry before the nomination deadline', () => {
    const s = startedDraft()
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 30_999 })
    expect(!r.ok && r.error.code).toBe('CLOCK_NOT_EXPIRED')
  })

  it('auto_nominate falls back to skip when no legal player exists for the team', () => {
    const s = startedDraft({
      rosterTemplate: [{ name: 'QB', eligible: ['QB' as const], count: 1 }],
      players: makePlayers({ RB: 5 }), // pool has only RBs; QB-only roster → nothing legal to nominate
    })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 31_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['NOMINATION_SKIPPED', 'NOMINATION_STARTED'])
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
  })
})
