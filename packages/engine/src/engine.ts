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

import type { Command, DraftEvent, EngineError, ExecuteResult } from './types.js'
import { openSlotCount, rosterCapacity } from './roster.js'

function err(code: EngineError['code'], message: string): ExecuteResult {
  return { ok: false, error: { code, message } }
}

function teamIsFull(state: DraftState, teamId: string): boolean {
  const t = state.teams[teamId]
  if (!t) return true
  return openSlotCount(t, state.config) <= 0
}

/** NOMINATION_STARTED for next non-full team at/after fromPointer, or DRAFT_COMPLETED. */
export function nextNominationEvents(state: DraftState, fromPointer: number, now: number): DraftEvent[] {
  const order = state.config.nominationOrder
  const n = order.length
  for (let i = 0; i < n; i++) {
    const idx = (fromPointer + i) % n
    const teamId = order[idx]!
    if (!teamIsFull(state, teamId)) {
      return [{ type: 'NOMINATION_STARTED', teamId, deadline: now + state.config.nominationClockMs, at: now }]
    }
  }
  return [{ type: 'DRAFT_COMPLETED', at: now }]
}

export function execute(state: DraftState, cmd: Command): ExecuteResult {
  switch (cmd.type) {
    case 'START_DRAFT': {
      if (state.phase.type !== 'lobby') return err('NOT_IN_LOBBY', 'Draft already started')
      const events: DraftEvent[] = [{ type: 'DRAFT_STARTED', at: cmd.now }]
      events.push(...nextNominationEvents(state, 0, cmd.now))
      return { ok: true, events }
    }
    default:
      return err('WRONG_PHASE', `Unhandled command ${cmd.type}`)
  }
}

export function apply(state: DraftState, event: DraftEvent): DraftState {
  const s: DraftState = structuredClone(state)
  s.seq += 1
  switch (event.type) {
    case 'DRAFT_STARTED':
      return s
    case 'NOMINATION_STARTED':
      s.phase = { type: 'awaiting_nomination', teamId: event.teamId, deadline: event.deadline }
      s.pointer = s.config.nominationOrder.indexOf(event.teamId)
      return s
    case 'DRAFT_COMPLETED':
      s.phase = { type: 'complete' }
      return s
    default:
      return s
  }
}

export function run(state: DraftState, cmd: Command):
  | { ok: true; state: DraftState; events: DraftEvent[] }
  | { ok: false; error: EngineError } {
  const r = execute(state, cmd)
  if (!r.ok) return r
  let s = state
  for (const e of r.events) s = apply(s, e)
  return { ok: true, state: s, events: r.events }
}
