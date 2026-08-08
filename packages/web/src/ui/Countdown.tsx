export type ClockPhase = 'normal' | 'urgent' | 'expired'

/** Shared by the countdown and the block card, so the clock's urgency and the
 *  card's edge pulse can never disagree about when the closing seconds start. */
export function phaseFor(msLeft: number): ClockPhase {
  if (msLeft <= 0) return 'expired'
  return msLeft <= 3_000 ? 'urgent' : 'normal'
}

export function Countdown({ msLeft, totalMs }: { msLeft: number; totalMs: number }) {
  const phase = phaseFor(msLeft)
  const pct = totalMs > 0 ? Math.max(0, Math.min(1, msLeft / totalMs)) : 0
  const color = phase === 'normal' ? 'var(--brass)' : 'var(--siren)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--step)' }}>
      <div aria-hidden style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }}>
        <div style={{ width: `${pct * 100}%`, height: '100%', background: color, transition: 'width 120ms linear' }} />
      </div>
      <span className="numerals" style={{ fontSize: '1.25rem', color, minWidth: '2ch', textAlign: 'right' }}>
        {Math.ceil(msLeft / 1000)}
      </span>
      <span className="label">sec</span>
    </div>
  )
}
