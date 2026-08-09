import { maxBid } from '@auction/engine'
import type { DraftState, PlayerInfo, RosterEntry } from '@auction/engine'
import { Money } from '../ui/Money.js'
import { PositionChip } from '../ui/PositionChip.js'
import { Sheet } from '../ui/Sheet.js'

/** One row per slot the template defines, in template order — filled rows carry the
 *  player, empty ones stay as outlines so "what do I still need" is answerable
 *  without counting. */
function slotRows(state: DraftState, teamId: string) {
  const team = state.teams[teamId]
  const remaining = [...(team?.roster ?? [])]
  const rows: { slot: string; index: number; entry: RosterEntry | null }[] = []
  for (const slot of state.config.rosterTemplate) {
    for (let i = 0; i < slot.count; i++) {
      const at = remaining.findIndex(r => r.slot === slot.name)
      rows.push({ slot: slot.name, index: i, entry: at >= 0 ? remaining.splice(at, 1)[0]! : null })
    }
  }
  return rows
}

export function RosterSheet({
  view,
  teamId,
  open,
  onClose,
}: {
  view: { state: DraftState | null }
  teamId: string
  open: boolean
  onClose: () => void
}) {
  const state = view.state
  // Bail before touching state: a closed sheet does no work, and a partial state
  // (mid-reconnect, or a malformed snapshot) must never crash the screen behind it.
  if (!open || !state?.config?.rosterTemplate || !state.teams) return null
  const team = state.teams[teamId]
  const byId = new Map<string, PlayerInfo>((state.config.players ?? []).map(p => [p.id, p]))
  const rows = slotRows(state, teamId)
  const spent = (team?.roster ?? []).reduce((n, r) => n + r.price, 0)

  return (
    <Sheet open={open} onClose={onClose} title="Your roster">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--step)' }}>
        {rows.map(({ slot, index, entry }) => {
          const player = entry ? byId.get(entry.playerId) : undefined
          return (
            <div
              key={`${slot}-${index}`}
              data-testid={`roster-slot-${slot}-${index}`}
              data-filled={entry ? 'true' : 'false'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--step)',
                padding: 'var(--step)',
                borderRadius: 'var(--radius)',
                border: entry ? '1px solid var(--line)' : '1px dashed var(--line)',
                background: entry ? 'var(--pitch)' : 'transparent',
                opacity: entry ? 1 : 0.7,
              }}
            >
              <span className="label" style={{ minWidth: '4.5ch' }}>
                {slot}
              </span>
              {entry && player ? (
                <>
                  <PositionChip position={player.position} />
                  <span className="name" style={{ flex: 1 }}>
                    {player.name}
                  </span>
                  <Money value={entry.price} size="row" />
                </>
              ) : (
                <span className="label" style={{ flex: 1, textTransform: 'none', letterSpacing: 0 }}>
                  Empty
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div
        data-testid="roster-totals"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 'var(--step)',
          marginTop: 'calc(var(--step) * 2)',
          paddingTop: 'var(--step)',
          borderTop: '1px solid var(--line)',
        }}
      >
        <div>
          <div className="label">Spent</div>
          <Money value={spent} size="row" tone="muted" />
        </div>
        <div>
          <div className="label">Remaining</div>
          <Money value={team?.budget ?? 0} size="row" />
        </div>
        <div>
          <div className="label">Max bid</div>
          <Money value={team ? maxBid(team, state.config) : 0} size="row" />
        </div>
      </div>
    </Sheet>
  )
}
