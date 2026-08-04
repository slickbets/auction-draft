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
import { openSlotCount, rosterCapacity, maxBid, firstOpenSlotFor } from './roster.js'

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
    case 'NOMINATE': {
      if (state.phase.type !== 'awaiting_nomination') return err('WRONG_PHASE', 'Not awaiting a nomination')
      if (state.phase.teamId !== cmd.teamId) return err('NOT_YOUR_NOMINATION', `${state.phase.teamId} is on the clock`)
      const team = state.teams[cmd.teamId]
      if (!team) return err('UNKNOWN_TEAM', cmd.teamId)
      if (!state.available.includes(cmd.playerId)) return err('PLAYER_NOT_AVAILABLE', cmd.playerId)
      if (!Number.isInteger(cmd.openingBid) || cmd.openingBid < 1) return err('INVALID_AMOUNT', 'Opening bid must be an integer ≥ $1')
      if (cmd.openingBid > maxBid(team, state.config)) return err('EXCEEDS_MAX_BID', `Max bid ${maxBid(team, state.config)}`)
      const player = state.config.players.find(p => p.id === cmd.playerId)
      if (!player) return err('PLAYER_NOT_AVAILABLE', cmd.playerId)
      if (firstOpenSlotFor(team, player.position, state.config) === null) return err('NO_ELIGIBLE_SLOT', `No open slot for ${player.position}`)
      return {
        ok: true,
        events: [{
          type: 'PLAYER_NOMINATED', teamId: cmd.teamId, playerId: cmd.playerId,
          openingBid: cmd.openingBid, deadline: cmd.now + state.config.bidClockMs, at: cmd.now,
        }],
      }
    }
    case 'BID': {
      if (state.phase.type !== 'bidding') return err('WRONG_PHASE', 'No player on the block')
      const phase = state.phase
      const team = state.teams[cmd.teamId]
      if (!team) return err('UNKNOWN_TEAM', cmd.teamId)
      if (!Number.isInteger(cmd.amount)) return err('INVALID_AMOUNT', 'Bids are whole dollars')
      if (cmd.amount <= phase.price) return err('STALE_PRICE', `Price is already $${phase.price}`)
      if (cmd.teamId === phase.highBidderId) return err('ALREADY_HIGH_BIDDER', 'You are already winning')
      if (cmd.amount > maxBid(team, state.config)) return err('EXCEEDS_MAX_BID', `Max bid ${maxBid(team, state.config)}`)
      const player = state.config.players.find(p => p.id === phase.playerId)!
      if (firstOpenSlotFor(team, player.position, state.config) === null) return err('NO_ELIGIBLE_SLOT', `No open slot for ${player.position}`)
      return {
        ok: true,
        events: [{ type: 'BID_PLACED', teamId: cmd.teamId, amount: cmd.amount, deadline: cmd.now + state.config.bidClockMs, at: cmd.now }],
      }
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
    case 'PLAYER_NOMINATED':
      s.phase = {
        type: 'bidding', playerId: event.playerId, price: event.openingBid,
        highBidderId: event.teamId, nominatorId: event.teamId, deadline: event.deadline,
      }
      return s
    case 'BID_PLACED': {
      if (s.phase.type !== 'bidding') return s
      s.phase = { ...s.phase, price: event.amount, highBidderId: event.teamId, deadline: event.deadline }
      return s
    }
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
