import type { DraftState, LeagueConfig, TeamState } from './types.js'

export function initialState(config: LeagueConfig): DraftState {
  const teams: Record<string, TeamState> = {}
  for (const t of config.teams) {
    teams[t.id] = { id: t.id, name: t.name, budget: config.budget, roster: [] }
  }
  return {
    config,
    phase: { type: 'lobby' },
    teams,
    available: config.players.map(p => p.id),
    pointer: 0,
    sales: [],
    seq: 0,
  }
}
