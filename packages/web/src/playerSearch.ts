import { firstOpenSlotFor } from '@auction/engine'
import type { DraftState, PlayerInfo } from '@auction/engine'

/**
 * Players the viewer's own team could nominate right now: still available, and
 * rosterable by them specifically. `firstOpenSlotFor !== null` is the single
 * check that does this — it is what keeps kickers (when this league's template
 * has no slot for the position) and positions the team has already capped out
 * (ESPN maximums, enforced by the engine) out of the list, without this module
 * re-deriving any of that roster logic itself.
 *
 * Ordered by the engine's own `rank` (lower = better) so the top of an empty
 * search is the best remaining player, not an arbitrary pool order. Name
 * matching is a case-insensitive substring so "cook" matches "Dalvin Cook".
 */
export function searchPlayers(
  state: DraftState,
  viewerTeamId: string,
  query: string,
  limit = 40,
): PlayerInfo[] {
  const team = state.teams[viewerTeamId]
  if (!team) return []

  const byId = new Map(state.config.players.map(p => [p.id, p]))
  const needle = query.trim().toLowerCase()

  const results = state.available
    .map(id => byId.get(id))
    .filter((p): p is PlayerInfo => p !== undefined)
    .filter(p => firstOpenSlotFor(team, p.position, state.config) !== null)
    .filter(p => needle === '' || p.name.toLowerCase().includes(needle))

  results.sort((a, b) => a.rank - b.rank)
  return results.slice(0, limit)
}
