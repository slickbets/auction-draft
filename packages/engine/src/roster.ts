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

export function positionCount(team: TeamState, position: Position): number {
  return team.roster.reduce((n, r) => (r.position === position ? n + 1 : n), 0)
}

/** True when this league can ever roster the position: some slot accepts it and its cap isn't 0. */
export function isDraftablePosition(cfg: LeagueConfig, position: Position): boolean {
  if (cfg.maxPerPosition?.[position] === 0) return false
  return cfg.rosterTemplate.some(s => s.eligible.includes(position))
}

export function firstOpenSlotFor(team: TeamState, position: Position, cfg: LeagueConfig): string | null {
  const max = cfg.maxPerPosition?.[position]
  if (max !== undefined && positionCount(team, position) >= max) return null
  for (const slot of cfg.rosterTemplate) {
    if (!slot.eligible.includes(position)) continue
    const used = team.roster.filter(r => r.slot === slot.name).length
    if (used < slot.count) return slot.name
  }
  return null
}
