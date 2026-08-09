import type { ReactNode } from 'react'
import { maxBid, openSlotCount } from '@auction/engine'
import type { DraftView } from '../client/draftClient.js'
import { Money } from '../ui/Money.js'

/**
 * The three numbers a bidder must never compute themselves, always mounted for
 * managers. Both figures come straight from the engine against the viewer's own
 * team — never recomputed by hand here, so this can't drift from what the server
 * will actually enforce.
 */
export function StatusHeader({ view }: { view: DraftView }) {
  const state = view.state
  // Defensive beyond what the type promises: a partial/malformed state must never
  // crash this component and take the rest of the screen down with it — "never a
  // blank screen" applies to render errors too, not just connection states.
  const team = state?.teams && view.teamId ? state.teams[view.teamId] : null
  if (!state || !state.config || !team) return null

  return (
    <div
      style={{
        display: 'flex',
        gap: 'calc(var(--step) * 3)',
        padding: 'calc(var(--step) * 1.5) calc(var(--step) * 2)',
        borderBottom: '1px solid var(--line)',
        background: 'var(--surface)',
      }}
    >
      <Stat label="Budget left" value={<Money value={team.budget} size="row" />} />
      <Stat label="Max bid" value={<Money value={maxBid(team, state.config)} size="row" />} />
      <Stat
        label="Open spots"
        value={
          <span className="numerals" style={{ fontSize: '1.5rem', color: 'var(--ink)' }}>
            {openSlotCount(team, state.config)}
          </span>
        }
      />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="label">{label}</span>
      {value}
    </div>
  )
}
