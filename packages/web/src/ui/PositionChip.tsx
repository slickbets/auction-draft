import type { Position } from '@auction/engine'

const COLOR: Record<Position, string> = {
  QB: 'var(--pos-qb)',
  RB: 'var(--pos-rb)',
  WR: 'var(--pos-wr)',
  TE: 'var(--pos-te)',
  DST: 'var(--pos-dst)',
  K: 'var(--muted)', // this league drafts none; present only so the map is total
}

export function PositionChip({ position }: { position: Position }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 6px',
        borderRadius: 4,
        background: COLOR[position],
        color: 'var(--pitch)',
        fontSize: '0.7rem',
        fontVariationSettings: "'wdth' 88, 'wght' 700",
        letterSpacing: '0.04em',
      }}
    >
      {position}
    </span>
  )
}
