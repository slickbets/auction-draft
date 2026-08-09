import type { ReactNode } from 'react'

export type ButtonVariant = 'bid' | 'ghost' | 'danger'

const BASE = {
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  fontFamily: 'var(--font)',
  fontVariationSettings: "'wdth' 88, 'wght' 700",
  cursor: 'pointer',
} as const

const VARIANT: Record<ButtonVariant, React.CSSProperties> = {
  // Bid targets are thumb-sized: 44px is the floor for a control someone stabs at
  // while a clock is draining.
  bid: { minHeight: 44, padding: '0 calc(var(--step) * 2)', background: 'var(--brass)', color: 'var(--pitch)', borderColor: 'var(--brass)', fontSize: '1.05rem' },
  ghost: { minHeight: 40, padding: '0 calc(var(--step) * 1.5)', background: 'transparent', color: 'var(--ink)' },
  danger: { minHeight: 40, padding: '0 calc(var(--step) * 1.5)', background: 'transparent', color: 'var(--siren)', borderColor: 'var(--siren)' },
}

export function Button({
  variant = 'ghost',
  disabled,
  reason,
  onClick,
  children,
  ...rest
}: {
  variant?: ButtonVariant
  disabled?: boolean
  /** Why this control is unavailable. Rendered visibly — never a silently dead button. */
  reason?: string
  onClick?: () => void
  children: ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled'>) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        style={{ ...BASE, ...VARIANT[variant], opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
        {...rest}
      >
        {children}
      </button>
      {disabled && reason ? (
        <span className="label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {reason}
        </span>
      ) : null}
    </span>
  )
}
