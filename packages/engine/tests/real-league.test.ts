import { describe, it, expect } from 'vitest'
import {
  initialState,
  rosterCapacity,
  firstOpenSlotFor,
  isDraftablePosition,
  maxBid,
  type LeagueConfig,
  type Position,
  type SlotDef,
} from '../src/index.js'

/** The exact settings confirmed by the commissioner for the 2026-09-06 draft
 *  (ESPN Roster Settings: 17 roster / 10 starters / 7 bench, no kickers). */
const TEMPLATE: SlotDef[] = [
  { name: 'QB', eligible: ['QB'], count: 2 },
  { name: 'RB', eligible: ['RB'], count: 2 },
  { name: 'WR', eligible: ['WR'], count: 2 },
  { name: 'TE', eligible: ['TE'], count: 1 },
  { name: 'FLEX', eligible: ['RB', 'WR', 'TE'], count: 2 },
  { name: 'DST', eligible: ['DST'], count: 1 },
  { name: 'BENCH', eligible: ['QB', 'RB', 'WR', 'TE', 'DST'], count: 7 },
]

const teams = Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))

function realConfig(): LeagueConfig {
  return {
    teams,
    budget: 200,
    rosterTemplate: TEMPLATE,
    maxPerPosition: { QB: 4, RB: 7, WR: 7, TE: 4, DST: 3 },
    bidClockMs: 10_000,
    nominationClockMs: 30_000,
    nominationOrder: teams.map(t => t.id),
    nominationExpiryPolicy: 'auto_nominate',
    players: [],
  }
}

describe("the league's actual draft-night configuration", () => {
  const cfg = realConfig()

  it('has 17 roster spots per team, 170 picks for the league', () => {
    expect(rosterCapacity(cfg.rosterTemplate)).toBe(17)
    expect(rosterCapacity(cfg.rosterTemplate) * cfg.teams.length).toBe(170)
  })

  it('starters total 10 and bench 7, matching ESPN', () => {
    const starters = cfg.rosterTemplate.filter(s => s.name !== 'BENCH').reduce((n, s) => n + s.count, 0)
    expect(starters).toBe(10)
    expect(cfg.rosterTemplate.find(s => s.name === 'BENCH')!.count).toBe(7)
  })

  it('drafts no kickers, but every other position is draftable', () => {
    expect(isDraftablePosition(cfg, 'K')).toBe(false)
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'DST'] as Position[]) {
      expect(isDraftablePosition(cfg, pos)).toBe(true)
    }
    // and a kicker can never be assigned a slot, so it can never be nominated
    const team = initialState(cfg).teams['T1']!
    expect(firstOpenSlotFor(team, 'K', cfg)).toBeNull()
  })

  it('opening max bid is 184 dollars (budget minus one dollar for each other slot)', () => {
    expect(maxBid(initialState(cfg).teams['T1']!, cfg)).toBe(184)
  })

  it('blocks an 8th running back even with bench room and money left', () => {
    const s = initialState(cfg)
    const team = s.teams['T1']!
    // 7 RBs: fills RB(2) + FLEX(2) + 3 bench, leaving 4 bench spots open
    const slots = ['RB', 'RB', 'FLEX', 'FLEX', 'BENCH', 'BENCH', 'BENCH']
    slots.forEach((slot, i) => team.roster.push({ playerId: `rb${i}`, price: 1, slot, position: 'RB' }))
    expect(team.roster).toHaveLength(7)
    expect(firstOpenSlotFor(team, 'RB', cfg)).toBeNull() // capped
    expect(firstOpenSlotFor(team, 'WR', cfg)).toBe('WR') // other positions unaffected
    expect(maxBid(team, cfg)).toBeGreaterThan(0) // and it is not a money problem
  })

  it('caps are collectively loose enough to always fill a roster', () => {
    const caps = cfg.maxPerPosition!
    const reachable = (Object.keys(caps) as Position[])
      .filter(p => isDraftablePosition(cfg, p))
      .reduce((n, p) => n + caps[p]!, 0)
    expect(reachable).toBeGreaterThanOrEqual(rosterCapacity(cfg.rosterTemplate))
  })
})
