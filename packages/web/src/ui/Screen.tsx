import type { ReactNode } from 'react'

export function Screen({ banner, children }: { banner?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {banner}
      {children}
    </div>
  )
}

export function Banner({ tone, children }: { tone: 'warn' | 'info'; children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: 'calc(var(--step) * 1.5)',
        background: tone === 'warn' ? 'var(--siren)' : 'var(--surface)',
        color: tone === 'warn' ? 'var(--pitch)' : 'var(--ink)',
        fontWeight: 600,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  )
}
