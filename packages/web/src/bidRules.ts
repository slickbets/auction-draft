import { maxBid, firstOpenSlotFor } from '@auction/engine'
import type { DraftView } from './client/draftClient.js'

export interface BidState {
  allowed: boolean
  reason?: string
}

/**
 * Mirrors the server's BID legality checks — for display only. The server's ack
 * is still the truth; this exists so a control can be disabled with an explained
 * reason instead of going silently dead, and so the copy matches what the server
 * would say if asked.
 *
 * Deliberately does NOT compare `amount` against the current price the way the
 * server's STALE_PRICE check does: a race between this render and the click must
 * never lock a manager out of re-raising, so "the local price looks stale" is not
 * a condition this function will ever report as disallowed.
 */
export function bidState(view: DraftView, amount: number): BidState {
  const state = view.state
  if (!state || state.phase.type !== 'bidding' || !view.teamId) {
    return { allowed: false }
  }
  const phase = state.phase
  const team = state.teams[view.teamId]
  if (!team) return { allowed: false }

  if (phase.highBidderId === view.teamId) {
    return { allowed: false, reason: "You're leading" }
  }

  const max = maxBid(team, state.config)
  if (amount > max) {
    return { allowed: false, reason: `Max bid $${max}` }
  }

  const player = state.config.players.find(p => p.id === phase.playerId)
  if (player && firstOpenSlotFor(team, player.position, state.config) === null) {
    return { allowed: false, reason: `No open spot for a ${player.position}` }
  }

  return { allowed: true }
}
