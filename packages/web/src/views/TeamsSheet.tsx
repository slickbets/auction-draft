import { openSlotCount } from '@auction/engine'
import type { DraftState } from '@auction/engine'
import { Money } from '../ui/Money.js'
import { Sheet } from '../ui/Sheet.js'

/** Sorted by money left, because the question this screen answers mid-auction is
 *  "who can still outbid me". */
export function TeamsSheet({
  view,
  open,
  onClose,
}: {
  view: { state: DraftState | null; teamId?: string | null }
  open: boolean
  onClose: () => void
}) {
  const state = view.state
  if (!open || !state?.teams || !state.config) return null
  const teams = Object.values(state.teams).sort((a, b) => b.budget - a.budget)

  return (
    <Sheet open={open} onClose={onClose} title="All teams">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 'var(--step)', padding: '0 var(--step)' }}>
          <span className="label" style={{ flex: 1 }}>
            Team
          </span>
          <span className="label" style={{ minWidth: '5ch', textAlign: 'right' }}>
            Left
          </span>
          <span className="label" style={{ minWidth: '5ch', textAlign: 'right' }}>
            Open
          </span>
        </div>
        {teams.map(team => (
          <div
            key={team.id}
            data-testid={`team-row-${team.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--step)',
              padding: 'var(--step)',
              borderRadius: 'var(--radius)',
              background: team.id === view.teamId ? 'var(--pitch)' : 'transparent',
              border: '1px solid var(--line)',
            }}
          >
            <span className="name" style={{ flex: 1 }}>
              {team.name}
            </span>
            <span style={{ minWidth: '5ch', textAlign: 'right' }}>
              <Money value={team.budget} size="row" />
            </span>
            <span className="numerals" style={{ minWidth: '5ch', textAlign: 'right', fontSize: '1.1rem' }}>
              {openSlotCount(team, state.config)}
            </span>
          </div>
        ))}
      </div>
    </Sheet>
  )
}
