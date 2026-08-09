import type { PlayerInfo, SaleRecord, TeamState } from '@auction/engine'
import { Money } from '../ui/Money.js'

/**
 * The board's list of recent sales — newest first, capped at 8 (enough to read
 * across a room without scrolling). Ordered by the engine's own `overall` (the
 * 1-based nomination number) rather than array order, so this can never be
 * fooled by an UNDO_SALE splice or by whatever order a reconnect snapshot
 * happens to carry `sales` in.
 */
export function SoldTicker({
  sales,
  players,
  teams,
}: {
  sales: SaleRecord[]
  players: PlayerInfo[]
  teams: Record<string, TeamState>
}) {
  const byId = new Map(players.map(p => [p.id, p]))
  const recent = [...sales].sort((a, b) => b.overall - a.overall).slice(0, 8)

  if (recent.length === 0) {
    return (
      <p className="label" style={{ margin: 0 }}>
        No sales yet
      </p>
    )
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {recent.map(sale => {
        const player = byId.get(sale.playerId)
        const team = teams[sale.teamId]
        return (
          <li
            key={sale.overall}
            data-testid={`sold-row-${sale.overall}`}
            style={{
              color: 'var(--ink)',
              fontSize: 'clamp(0.8rem, 1.8vmin, 1.3rem)',
            }}
          >
            <span className="name">{player?.name ?? sale.playerId}</span>
            {' → '}
            <span>{team?.name ?? sale.teamId}</span>
            {' · '}
            <Money value={sale.price} size="inline" />
          </li>
        )
      })}
    </ul>
  )
}
