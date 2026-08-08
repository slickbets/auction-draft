const SIZES = {
  hero: 'clamp(3.5rem, 18vw, 6rem)',
  row: '1.5rem',
  inline: '1rem',
} as const

export type MoneySize = keyof typeof SIZES

/** Whole dollars in tabular figures so digits never jitter as a price climbs. */
export function Money({
  value,
  size = 'inline',
  tone = 'brass',
}: {
  value: number
  size?: MoneySize
  tone?: 'brass' | 'ink' | 'muted'
}) {
  const color = tone === 'brass' ? 'var(--brass)' : tone === 'ink' ? 'var(--ink)' : 'var(--muted)'
  return (
    <span className="numerals" style={{ fontSize: SIZES[size], color, lineHeight: 1, whiteSpace: 'nowrap' }}>
      <span aria-hidden style={{ fontSize: '0.5em', opacity: 0.6, marginRight: '0.1em' }}>
        $
      </span>
      {value}
      <span className="sr-only">{` dollars`}</span>
    </span>
  )
}
