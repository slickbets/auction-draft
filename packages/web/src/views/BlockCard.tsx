import { useEffect, useRef, useState } from 'react'
import type { DraftView } from '../client/draftClient.js'
import { Money } from '../ui/Money.js'
import { PositionChip } from '../ui/PositionChip.js'
import { Countdown, phaseFor } from '../ui/Countdown.js'
import { useTick } from '../ui/useTick.js'

/**
 * The block card — the product's signature moment: the few seconds where money
 * and a draining clock are in tension. Purely presentational: `msLeft`/`totalMs`
 * are supplied by the caller (which owns the live tick against `client.msLeft`),
 * so this component never touches the client itself.
 */
export function BlockCard({ view, msLeft, totalMs }: { view: DraftView; msLeft: number; totalMs: number }) {
  const state = view.state
  const phase = state && state.phase.type === 'bidding' ? state.phase : null
  const player = state && phase ? state.config.players.find(p => p.id === phase.playerId) : undefined

  const { delta, key } = useTick(phase?.price ?? 0)

  // Announce each price change once — the countdown alone re-renders this
  // component roughly every 200ms, and a naive effect would re-announce on
  // every one of those renders instead of only on an actual price move.
  const announcedPrice = useRef<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    if (!phase) return
    if (announcedPrice.current === phase.price) return
    announcedPrice.current = phase.price
    setAnnouncement(`${player?.name ?? 'Player'} at $${phase.price}`)
  }, [phase, player])

  if (!state || !phase) return null

  const leaderTeam = state.teams[phase.highBidderId]
  const viewerLeading = phase.highBidderId === view.teamId
  const clockPhase = phaseFor(msLeft)
  const label = clockPhase !== 'urgent' ? 'ON THE BLOCK' : msLeft <= 1_500 ? 'GOING TWICE' : 'GOING ONCE'

  return (
    <div
      data-testid="block-card"
      style={{
        position: 'relative',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        padding: 'calc(var(--step) * 2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--step)',
        animation: clockPhase === 'urgent' ? 'urgency 1s ease-in-out infinite' : undefined,
      }}
    >
      <span className="label" style={clockPhase === 'urgent' ? { color: 'var(--siren)', fontWeight: 800 } : undefined}>
        {label}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--step)' }}>
        {player && <PositionChip position={player.position} />}
        <span className="name" style={{ fontSize: '1.1rem' }}>
          {player?.name ?? phase.playerId}
        </span>
        {player && <span className="label">{player.nflTeam}</span>}
      </div>

      <div style={{ position: 'relative', display: 'inline-block' }}>
        <span key={key} style={{ display: 'inline-block', animation: 'tick-roll 220ms ease-out' }}>
          <Money value={phase.price} size="hero" />
        </span>
        {delta !== null && (
          <span
            aria-hidden
            className="numerals"
            style={{
              position: 'absolute',
              top: 0,
              left: '100%',
              marginLeft: 'var(--step)',
              color: 'var(--brass)',
              fontSize: '1.25rem',
              animation: 'delta-rise 900ms ease-out forwards',
            }}
          >
            {`+$${delta}`}
          </span>
        )}
      </div>

      <div style={{ color: viewerLeading ? 'var(--brass)' : 'var(--ink)', fontWeight: 600 }}>
        {viewerLeading ? "You're leading" : `${leaderTeam?.name ?? phase.highBidderId} leading`}
      </div>

      <Countdown msLeft={msLeft} totalMs={totalMs} />

      {/* Screen-reader-only: announces once per price change, not on every render. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
