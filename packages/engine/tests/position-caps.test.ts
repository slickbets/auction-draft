import { describe, it, expect } from 'vitest'
import { run, isDraftablePosition } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'
import { testConfig, STANDARD_TEMPLATE } from './fixtures.js'

describe('maxPerPosition roster caps', () => {
  it('a team at its RB cap cannot nominate another RB, even with open FLEX/BENCH slots and plenty of budget', () => {
    const s = startedDraft({ maxPerPosition: { RB: 2 } })
    const s2 = structuredClone(s)
    const t1 = s2.teams['T1']!
    t1.roster = [
      { playerId: 'RB1', price: 1, slot: 'RB', position: 'RB' },
      { playerId: 'RB2', price: 1, slot: 'RB', position: 'RB' },
    ]
    s2.available = s2.available.filter(id => id !== 'RB1' && id !== 'RB2')
    // Plenty of open FLEX/BENCH slots and budget — only the position cap should block this.
    const r = run(s2, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB3', openingBid: 1, now: 2000 })
    expect(!r.ok && r.error.code).toBe('NO_ELIGIBLE_SLOT')
  })

  it('a team at its cap cannot BID on that position', () => {
    const s = startedDraft({ maxPerPosition: { RB: 2 } })
    const s2 = structuredClone(s)
    const t2 = s2.teams['T2']!
    t2.roster = [
      { playerId: 'RB1', price: 1, slot: 'RB', position: 'RB' },
      { playerId: 'RB2', price: 1, slot: 'RB', position: 'RB' },
    ]
    s2.available = s2.available.filter(id => id !== 'RB1' && id !== 'RB2')
    const bidding = mustRun(s2, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB3', openingBid: 1, now: 2000 })
    const r = run(bidding, { type: 'BID', teamId: 'T2', amount: 2, now: 3000 })
    expect(!r.ok && r.error.code).toBe('NO_ELIGIBLE_SLOT')
  })

  it('auto-nomination on nomination-clock expiry skips a capped position and picks the best available rosterable player', () => {
    // Rank order from makePlayers is QB, then RB, WR, TE, K, DST — so QB1 is normally
    // the auto-nominate pick. Capping QB at 0 makes every QB illegal for every team,
    // so the best remaining rank the team CAN roster is the first RB.
    const s = startedDraft({ maxPerPosition: { QB: 0 } })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 31_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events[0]).toMatchObject({ type: 'PLAYER_NOMINATED', teamId: 'T1', playerId: 'RB1', openingBid: 1 })
  })

  it('EDIT_PICK cannot move a player onto a team already at that position cap', () => {
    const s = startedDraft({ maxPerPosition: { RB: 2 } })
    const s2 = structuredClone(s)
    const t2 = s2.teams['T2']!
    t2.roster = [
      { playerId: 'RB4', price: 1, slot: 'RB', position: 'RB' },
      { playerId: 'RB5', price: 1, slot: 'RB', position: 'RB' },
    ]
    s2.available = s2.available.filter(id => id !== 'RB4' && id !== 'RB5')
    let s3 = mustRun(s2, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB3', openingBid: 10, now: 2000 })
    s3 = mustRun(s3, { type: 'BID', teamId: 'T5', amount: 20, now: 4000 })
    s3 = mustRun(s3, { type: 'CLOCK_EXPIRED', now: 14_000 })
    const r = run(s3, { type: 'EDIT_PICK', overall: 1, newTeamId: 'T2', now: 20_000 })
    expect(!r.ok && r.error.code).toBe('INVALID_EDIT')
  })

  it('an uncapped position is unaffected by a cap on a different position', () => {
    const s = startedDraft({ maxPerPosition: { RB: 2 } })
    const s2 = structuredClone(s)
    const t1 = s2.teams['T1']!
    t1.roster = [
      { playerId: 'WR1', price: 1, slot: 'WR', position: 'WR' },
      { playerId: 'WR2', price: 1, slot: 'WR', position: 'WR' },
    ]
    s2.available = s2.available.filter(id => id !== 'WR1' && id !== 'WR2')
    const r = run(s2, { type: 'NOMINATE', teamId: 'T1', playerId: 'WR3', openingBid: 1, now: 2000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.phase).toMatchObject({ type: 'bidding', playerId: 'WR3' })
  })

  it('a config with no maxPerPosition behaves exactly as before', () => {
    const s = startedDraft() // no maxPerPosition override
    const s2 = structuredClone(s)
    const t1 = s2.teams['T1']!
    // Load T1 up with 5 RBs (would exceed any realistic ESPN cap) — uncapped here, so still legal.
    t1.roster = Array.from({ length: 5 }, (_, i) => ({ playerId: `RB${i + 1}`, price: 1, slot: i < 2 ? 'RB' : 'BENCH', position: 'RB' as const }))
    s2.available = s2.available.filter(id => !['RB1', 'RB2', 'RB3', 'RB4', 'RB5'].includes(id))
    const r = run(s2, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB6', openingBid: 1, now: 2000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.phase).toMatchObject({ type: 'bidding', playerId: 'RB6' })
  })

  describe('isDraftablePosition', () => {
    it('returns false for a position capped at 0, even though a slot accepts it', () => {
      const cfg = testConfig({ maxPerPosition: { DST: 0 } })
      expect(isDraftablePosition(cfg, 'DST')).toBe(false)
      expect(isDraftablePosition(cfg, 'RB')).toBe(true) // uncapped, unaffected
    })

    it('returns false for a position no slot accepts, regardless of caps', () => {
      const noKicker = testConfig({
        rosterTemplate: STANDARD_TEMPLATE.filter(s => s.name !== 'K').map(s => ({ ...s, eligible: s.eligible.filter(p => p !== 'K') })),
      })
      expect(isDraftablePosition(noKicker, 'K')).toBe(false)
      expect(isDraftablePosition(noKicker, 'QB')).toBe(true)
    })

    it('returns true for an ordinary eligible, uncapped position, and when maxPerPosition is absent entirely', () => {
      const cfg = testConfig()
      expect(isDraftablePosition(cfg, 'RB')).toBe(true)
      expect(isDraftablePosition(cfg, 'QB')).toBe(true)
    })
  })
})
