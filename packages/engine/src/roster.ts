import type { LeagueConfig, Position, SlotDef, TeamState } from './types.js'

export function rosterCapacity(template: SlotDef[]): number {
  return template.reduce((n, s) => n + s.count, 0)
}

export function openSlotCount(team: TeamState, cfg: LeagueConfig): number {
  return rosterCapacity(cfg.rosterTemplate) - team.roster.length
}

export function maxBid(team: TeamState, cfg: LeagueConfig): number {
  return team.budget - (openSlotCount(team, cfg) - 1)
}

export function firstOpenSlotFor(team: TeamState, position: Position, cfg: LeagueConfig): string | null {
  for (const slot of cfg.rosterTemplate) {
    if (!slot.eligible.includes(position)) continue
    const used = team.roster.filter(r => r.slot === slot.name).length
    if (used < slot.count) return slot.name
  }
  return null
}
