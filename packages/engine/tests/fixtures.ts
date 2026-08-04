import type { LeagueConfig, PlayerInfo, Position, SlotDef } from '../src/types.js'

const ALL: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']

export const STANDARD_TEMPLATE: SlotDef[] = [
  { name: 'QB', eligible: ['QB'], count: 1 },
  { name: 'RB', eligible: ['RB'], count: 2 },
  { name: 'WR', eligible: ['WR'], count: 2 },
  { name: 'TE', eligible: ['TE'], count: 1 },
  { name: 'FLEX', eligible: ['RB', 'WR', 'TE'], count: 1 },
  { name: 'DST', eligible: ['DST'], count: 1 },
  { name: 'K', eligible: ['K'], count: 1 },
  { name: 'BENCH', eligible: ALL, count: 7 },
] // capacity 16

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
  const teams = Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
  return {
    teams,
    budget: 200,
    rosterTemplate: STANDARD_TEMPLATE,
    bidClockMs: 10_000,
    nominationClockMs: 30_000,
    nominationOrder: teams.map(t => t.id),
    nominationExpiryPolicy: 'auto_nominate',
    players: makePlayers({ QB: 25, RB: 60, WR: 60, TE: 25, K: 15, DST: 15 }),
    ...overrides,
  }
}
