import { describe, it, expect } from 'vitest'
import { initialState, run, replay, openSlotCount, rosterCapacity, type DraftState, type Command, type SlotDef, type DraftEvent } from '../src/index.js'
import { testConfig, makePlayers } from './fixtures.js'

/** Deterministic PRNG — no Math.random in tests either. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function assertInvariants(s: DraftState) {
  const avail = new Set(s.available)
  const cap = rosterCapacity(s.config.rosterTemplate)
  const seen = new Set<string>()
  for (const team of Object.values(s.teams)) {
    expect(team.roster.length).toBeLessThanOrEqual(cap)
    if (s.phase.type !== 'lobby') expect(team.budget).toBeGreaterThanOrEqual(openSlotCount(team, s.config))
    for (const r of team.roster) {
      expect(seen.has(r.playerId), `player ${r.playerId} on two rosters`).toBe(false)
      seen.add(r.playerId)
      expect(avail.has(r.playerId), `player ${r.playerId} rostered AND available`).toBe(false)
    }
  }
}

// The fuzz league is shaped so positional pool exhaustion is impossible BY
// CONSTRUCTION: K/DST are not bench-eligible (caps their demand at 10 each), and
// every other position's supply exceeds the maximum consumable while any slot for
// it remains open (its slots on the other 9 teams + FLEX + the entire bench).
// Without this, random bench-hoarding can strand a starting slot on an empty pool
// (seed 1 hit it twice: DST, then QB) — a real deadlock the engine leaves to
// commissioner EDIT_PICK, and Plan 2's server will detect and auto-pause.
const FUZZ_TEMPLATE: SlotDef[] = [
  { name: 'QB', eligible: ['QB'], count: 1 },
  { name: 'RB', eligible: ['RB'], count: 2 },
  { name: 'WR', eligible: ['WR'], count: 2 },
  { name: 'TE', eligible: ['TE'], count: 1 },
  { name: 'FLEX', eligible: ['RB', 'WR', 'TE'], count: 1 },
  { name: 'DST', eligible: ['DST'], count: 1 },
  { name: 'K', eligible: ['K'], count: 1 },
  { name: 'BENCH', eligible: ['QB', 'RB', 'WR', 'TE'], count: 7 },
]

describe('fuzz: random drafts preserve invariants', () => {
  it('runs 100 seeded random drafts to completion legally', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rand = mulberry32(seed)
      const cfg = testConfig({
        rosterTemplate: FUZZ_TEMPLATE,
        players: makePlayers({ QB: 80, RB: 100, WR: 100, TE: 90, K: 15, DST: 15 }),
      })
      let s = initialState(cfg)
      const log: DraftEvent[] = []
      let now = 1000
      let r = run(s, { type: 'START_DRAFT', now })
      if (!r.ok) throw new Error('start failed')
      s = r.state
      log.push(...r.events)
      let guard = 0
      while (s.phase.type !== 'complete' && guard++ < 20_000) {
        now += 500 + Math.floor(rand() * 2000)
        const cmd = pickCommand(s, rand, now)
        const res = run(s, cmd)
        if (res.ok) { s = res.state; log.push(...res.events) } // invalid commands are expected; engine must just reject them
        assertInvariants(s)
      }
      expect(s.phase.type, `seed ${seed}`).toBe('complete')
      expect(replay(cfg, log)).toStrictEqual(s)
    }
  }, 300_000)
})

function pickCommand(s: DraftState, rand: () => number, now: number): Command {
  const teams = s.config.nominationOrder
  const teamId = teams[Math.floor(rand() * teams.length)]!
  if (s.phase.type === 'awaiting_nomination') {
    const roll = rand()
    if (roll < 0.05) return { type: 'PAUSE', now }
    if (roll < 0.08 && s.sales.length > 0) {
      return { type: 'EDIT_PICK', overall: 1 + Math.floor(rand() * s.sales.length), newPrice: 1 + Math.floor(rand() * 50), now }
    }
    if (roll < 0.1) return { type: 'ADJUST_BUDGET', teamId, delta: Math.floor(rand() * 21) - 10, now }
    if (roll < 0.12) return { type: 'ADD_TIME', ms: Math.floor(rand() * 10_000), now }
    if (roll < 0.14) return { type: 'SET_TIMERS', bidClockMs: 5000 + Math.floor(rand() * 10_000), now }
    if (roll < 0.4) return { type: 'CLOCK_EXPIRED', now: s.phase.deadline + 1 }
    const playerId = s.available[Math.floor(rand() * s.available.length)] ?? 'NONE'
    return { type: 'NOMINATE', teamId: rand() < 0.8 ? s.phase.teamId : teamId, playerId, openingBid: 1 + Math.floor(rand() * 5), now }
  }
  if (s.phase.type === 'bidding') {
    const roll = rand()
    if (roll < 0.03) return { type: 'PAUSE', now }
    if (roll < 0.4) return { type: 'CLOCK_EXPIRED', now: s.phase.deadline + 1 }
    if (roll < 0.45 && s.sales.length > 0) return { type: 'UNDO_SALE', now }
    return { type: 'BID', teamId, amount: s.phase.price + 1 + Math.floor(rand() * 3), now }
  }
  if (s.phase.type === 'paused') return { type: 'RESUME', now }
  return { type: 'CLOCK_EXPIRED', now }
}
