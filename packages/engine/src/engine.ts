import type { DraftState, LeagueConfig, TeamState } from './types.js'
import type { Command, DraftEvent, EngineError, ExecuteResult } from './types.js'
import { openSlotCount, maxBid, firstOpenSlotFor } from './roster.js'

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

function err(code: EngineError['code'], message: string): ExecuteResult {
  return { ok: false, error: { code, message } }
}

function teamIsFull(state: DraftState, teamId: string): boolean {
  const t = state.teams[teamId]
  if (!t) return true
  return openSlotCount(t, state.config) <= 0
}

/** True while a bid could still be charged: live bidding, or paused over bidding. */
function hasLiveBid(state: DraftState): boolean {
  return state.phase.type === 'bidding' ||
    (state.phase.type === 'paused' && state.phase.inner.type === 'bidding')
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
    case 'CLOCK_EXPIRED': {
      if (state.phase.type === 'bidding') {
        const phase = state.phase
        if (cmd.now < phase.deadline) return err('CLOCK_NOT_EXPIRED', 'Deadline not reached')
        const winner = state.teams[phase.highBidderId]!
        const player = state.config.players.find(p => p.id === phase.playerId)!
        const slot = firstOpenSlotFor(winner, player.position, state.config)!
        const sold: DraftEvent = {
          type: 'SOLD', playerId: player.id, teamId: winner.id, price: phase.price, slot,
          nominatorId: phase.nominatorId, pointerBefore: state.pointer,
          overall: state.sales.length + 1, at: cmd.now,
        }
        const after = apply(state, sold)
        return { ok: true, events: [sold, ...nextNominationEvents(after, state.pointer + 1, cmd.now)] }
      }
      if (state.phase.type === 'awaiting_nomination') {
        if (cmd.now < state.phase.deadline) return err('CLOCK_NOT_EXPIRED', 'Deadline not reached')
        const teamId = state.phase.teamId
        const team = state.teams[teamId]!
        if (state.config.nominationExpiryPolicy === 'auto_nominate') {
          const best = state.config.players
            .filter(p => state.available.includes(p.id) && firstOpenSlotFor(team, p.position, state.config) !== null)
            .sort((a, b) => a.rank - b.rank)[0]
          if (best) {
            return {
              ok: true,
              events: [{
                type: 'PLAYER_NOMINATED', teamId, playerId: best.id, openingBid: 1,
                deadline: cmd.now + state.config.bidClockMs, at: cmd.now,
              }],
            }
          }
          // No legal player for this team: fall through to skip.
        }
        const skipped: DraftEvent = { type: 'NOMINATION_SKIPPED', teamId, at: cmd.now }
        return { ok: true, events: [skipped, ...nextNominationEvents(state, state.pointer + 1, cmd.now)] }
      }
      return err('WRONG_PHASE', 'No clock running')
    }
    case 'PAUSE': {
      if (state.phase.type !== 'awaiting_nomination' && state.phase.type !== 'bidding')
        return err('WRONG_PHASE', 'Nothing to pause')
      return { ok: true, events: [{ type: 'DRAFT_PAUSED', remainingMs: Math.max(0, state.phase.deadline - cmd.now), at: cmd.now }] }
    }
    case 'RESUME': {
      if (state.phase.type !== 'paused') return err('WRONG_PHASE', 'Not paused')
      return { ok: true, events: [{ type: 'DRAFT_RESUMED', deadline: cmd.now + state.phase.remainingMs, at: cmd.now }] }
    }
    case 'ADD_TIME': {
      if (state.phase.type !== 'awaiting_nomination' && state.phase.type !== 'bidding' && state.phase.type !== 'paused')
        return err('WRONG_PHASE', 'No clock to extend')
      return { ok: true, events: [{ type: 'TIME_ADDED', ms: cmd.ms, at: cmd.now }] }
    }
    case 'SET_TIMERS':
      return { ok: true, events: [{ type: 'TIMER_CONFIG_CHANGED', bidClockMs: cmd.bidClockMs, nominationClockMs: cmd.nominationClockMs, at: cmd.now }] }
    case 'UNDO_SALE': {
      const sale = state.sales[state.sales.length - 1]
      if (!sale) return err('NOTHING_TO_UNDO', 'No sales yet')
      const canceled = state.phase.type === 'bidding' ? state.phase.playerId
        : state.phase.type === 'paused' && state.phase.inner.type === 'bidding' ? state.phase.inner.playerId
        : null
      return {
        ok: true,
        events: [{
          type: 'SALE_UNDONE', sale, canceledInFlightPlayerId: canceled,
          nominationDeadline: cmd.now + state.config.nominationClockMs, at: cmd.now,
        }],
      }
    }
    case 'EDIT_PICK': {
      if (hasLiveBid(state)) return err('WRONG_PHASE', 'Finish or undo the live auction before editing picks')
      const sale = state.sales.find(x => x.overall === cmd.overall)
      if (!sale) return err('INVALID_EDIT', `No sale #${cmd.overall}`)
      const toId = cmd.newTeamId ?? sale.teamId
      const price = cmd.newPrice ?? sale.price
      if (!Number.isInteger(price) || price < 1) return err('INVALID_EDIT', 'Price must be an integer ≥ $1')
      const from = state.teams[sale.teamId]!
      const to = state.teams[toId]
      if (!to) return err('UNKNOWN_TEAM', toId)
      if (toId === sale.teamId) {
        const entry = from.roster.find(r => r.playerId === sale.playerId)!
        if (from.budget + sale.price - price < openSlotCount(from, state.config)) {
          return err('INVALID_EDIT', 'Edit would break the budget invariant')
        }
        return {
          ok: true,
          events: [{
            type: 'PICK_EDITED', overall: cmd.overall, fromTeamId: sale.teamId, toTeamId: toId,
            oldPrice: sale.price, newPrice: price, newSlot: entry.slot, at: cmd.now,
          }],
        }
      }
      const player = state.config.players.find(p => p.id === sale.playerId)!
      const newSlot = firstOpenSlotFor(to, player.position, state.config)
      if (newSlot === null) return err('INVALID_EDIT', `${toId} has no open slot for ${player.position}`)
      if (to.budget - price < openSlotCount(to, state.config) - 1) {
        return err('INVALID_EDIT', 'Edit would break the budget invariant')
      }
      return {
        ok: true,
        events: [{
          type: 'PICK_EDITED', overall: cmd.overall, fromTeamId: sale.teamId, toTeamId: toId,
          oldPrice: sale.price, newPrice: price, newSlot, at: cmd.now,
        }],
      }
    }
    case 'ADJUST_BUDGET': {
      if (hasLiveBid(state)) return err('WRONG_PHASE', 'Finish or undo the live auction before adjusting budgets')
      const team = state.teams[cmd.teamId]
      if (!team) return err('UNKNOWN_TEAM', cmd.teamId)
      if (!Number.isInteger(cmd.delta)) return err('INVALID_ADJUSTMENT', 'Whole dollars only')
      if (team.budget + cmd.delta < openSlotCount(team, state.config))
        return err('INVALID_ADJUSTMENT', 'Would break the budget invariant')
      return { ok: true, events: [{ type: 'BUDGET_ADJUSTED', teamId: cmd.teamId, delta: cmd.delta, at: cmd.now }] }
    }
    default: {
      const exhaustive: never = cmd
      return err('WRONG_PHASE', `Unhandled command ${(exhaustive as Command).type}`)
    }
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
    case 'SOLD': {
      const team = s.teams[event.teamId]!
      team.roster.push({ playerId: event.playerId, price: event.price, slot: event.slot })
      team.budget -= event.price
      s.available = s.available.filter(id => id !== event.playerId)
      s.sales.push({
        playerId: event.playerId, teamId: event.teamId, price: event.price,
        nominatorId: event.nominatorId, pointerBefore: event.pointerBefore, overall: event.overall,
      })
      return s
    }
    case 'NOMINATION_SKIPPED':
      return s
    case 'DRAFT_PAUSED': {
      if (s.phase.type === 'awaiting_nomination' || s.phase.type === 'bidding')
        s.phase = { type: 'paused', inner: s.phase, remainingMs: event.remainingMs }
      return s
    }
    case 'DRAFT_RESUMED': {
      if (s.phase.type === 'paused') s.phase = { ...s.phase.inner, deadline: event.deadline }
      return s
    }
    case 'TIME_ADDED': {
      if (s.phase.type === 'awaiting_nomination' || s.phase.type === 'bidding')
        s.phase = { ...s.phase, deadline: s.phase.deadline + event.ms }
      else if (s.phase.type === 'paused')
        s.phase = { ...s.phase, remainingMs: s.phase.remainingMs + event.ms }
      return s
    }
    case 'TIMER_CONFIG_CHANGED': {
      if (event.bidClockMs !== undefined) s.config.bidClockMs = event.bidClockMs
      if (event.nominationClockMs !== undefined) s.config.nominationClockMs = event.nominationClockMs
      return s
    }
    case 'DRAFT_COMPLETED':
      s.phase = { type: 'complete' }
      return s
    case 'SALE_UNDONE': {
      const { sale } = event
      const team = s.teams[sale.teamId]!
      team.roster = team.roster.filter(r => r.playerId !== sale.playerId)
      team.budget += sale.price
      s.available.push(sale.playerId)
      const inFlight = event.canceledInFlightPlayerId
      if (inFlight && !s.available.includes(inFlight)) s.available.push(inFlight)
      s.sales = s.sales.filter(r => r.overall !== sale.overall)
      s.pointer = sale.pointerBefore
      s.phase = { type: 'awaiting_nomination', teamId: sale.nominatorId, deadline: event.nominationDeadline }
      return s
    }
    case 'PICK_EDITED': {
      const sale = s.sales.find(x => x.overall === event.overall)!
      const from = s.teams[event.fromTeamId]!
      const to = s.teams[event.toTeamId]!
      if (event.fromTeamId === event.toTeamId) {
        const entry = from.roster.find(r => r.playerId === sale.playerId)!
        entry.price = event.newPrice
        entry.slot = event.newSlot
        from.budget += event.oldPrice - event.newPrice
      } else {
        from.roster = from.roster.filter(r => r.playerId !== sale.playerId)
        from.budget += event.oldPrice
        to.roster.push({ playerId: sale.playerId, price: event.newPrice, slot: event.newSlot })
        to.budget -= event.newPrice
      }
      sale.teamId = event.toTeamId
      sale.price = event.newPrice
      return s
    }
    case 'BUDGET_ADJUSTED': {
      s.teams[event.teamId]!.budget += event.delta
      return s
    }
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

export function replay(config: LeagueConfig, events: DraftEvent[]): DraftState {
  return events.reduce(apply, initialState(config))
}
