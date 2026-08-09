import { initialState } from '@auction/engine'
import type { DraftState, LeagueConfig, PlayerInfo, Position, SlotDef } from '@auction/engine'

const ALL: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']

/** Small enough that maxBid/openSlotCount arithmetic in tests stays legible:
 *  capacity 4 (QB 1, RB 1, BENCH 2). */
export const TEST_TEMPLATE: SlotDef[] = [
  { name: 'QB', eligible: ['QB'], count: 1 },
  { name: 'RB', eligible: ['RB'], count: 1 },
  { name: 'BENCH', eligible: ALL, count: 2 },
]

export function makePlayers(perPosition: Partial<Record<Position, number>>): PlayerInfo[] {
  const players: PlayerInfo[] = []
  let rank = 1
  for (const pos of ALL) {
    const n = perPosition[pos] ?? 0
    for (let i = 1; i <= n; i++) {
      players.push({ id: `${pos}${i}`, name: `${pos} Player ${i}`, position: pos, nflTeam: 'FA', rank: rank++ })
    }
  }
  return players
}

export function testConfig(overrides: Partial<LeagueConfig> = {}): LeagueConfig {
  const teams = [
    { id: 'T1', name: 'Cook' },
    { id: 'T2', name: 'Dave' },
    { id: 'T3', name: 'Ann' },
  ]
  return {
    teams,
    budget: 200,
    rosterTemplate: TEST_TEMPLATE,
    bidClockMs: 10_000,
    nominationClockMs: 30_000,
    nominationOrder: teams.map(t => t.id),
    nominationExpiryPolicy: 'auto_nominate',
    players: makePlayers({ QB: 3, RB: 3, WR: 3, TE: 3, K: 2, DST: 2 }),
    ...overrides,
  }
}

/** `initialState()` with any top-level DraftState fields (most often `phase`,
 *  sometimes `teams`) patched in — the engine is the source of truth for the
 *  rest of the shape, so tests never hand-build a DraftState from scratch. */
export function testState(overrides: Partial<DraftState> = {}, configOverrides: Partial<LeagueConfig> = {}): DraftState {
  const config = testConfig(configOverrides)
  const base = initialState(config)
  return { ...base, ...overrides }
}
