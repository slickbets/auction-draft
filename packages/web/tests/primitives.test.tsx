import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Money } from '../src/ui/Money.js'
import { PositionChip } from '../src/ui/PositionChip.js'
import { Countdown, phaseFor } from '../src/ui/Countdown.js'
import { Button } from '../src/ui/Button.js'
import { Sheet } from '../src/ui/Sheet.js'

describe('Money', () => {
  it('renders whole dollars with tabular numerals', () => {
    const { container } = render(<Money value={47} size="hero" />)
    expect(screen.getByText('47')).toBeTruthy()
    expect(container.querySelector('.numerals')).toBeTruthy()
  })
})

describe('PositionChip', () => {
  it('colors each position from the token palette, never a literal hex', () => {
    const { container } = render(<PositionChip position="RB" />)
    const chip = container.firstElementChild as HTMLElement
    expect(chip.textContent).toBe('RB')
    expect(chip.style.background).toContain('var(--pos-rb)')
  })
})

describe('Countdown', () => {
  it('classifies urgency by remaining time', () => {
    expect(phaseFor(9_000)).toBe('normal')
    expect(phaseFor(3_000)).toBe('urgent')
    expect(phaseFor(2_900)).toBe('urgent')
    expect(phaseFor(0)).toBe('expired')
  })

  it('shows whole seconds remaining, rounding up so a live clock never reads 0 early', () => {
    render(<Countdown msLeft={6_200} totalMs={10_000} />)
    expect(screen.getByText('7')).toBeTruthy()
  })

  it('switches to the urgency color inside the closing seconds', () => {
    const { container, rerender } = render(<Countdown msLeft={9_000} totalMs={10_000} />)
    const digits = () => container.querySelector('.numerals') as HTMLElement
    expect(digits().style.color).toContain('var(--brass)')
    rerender(<Countdown msLeft={2_000} totalMs={10_000} />)
    expect(digits().style.color).toContain('var(--siren)')
  })
})

describe('Button', () => {
  it('explains why it is disabled instead of going silently dead', () => {
    render(
      <Button variant="bid" disabled reason="Max bid $14">
        +$5
      </Button>,
    )
    expect(screen.getByRole('button')).toHaveProperty('disabled', true)
    expect(screen.getByText('Max bid $14')).toBeTruthy()
  })

  it('gives bid controls a thumb-sized target', () => {
    render(<Button variant="bid">+$1</Button>)
    expect((screen.getByRole('button') as HTMLElement).style.minHeight).toBe('44px')
  })

  it('fires onClick when enabled and not when disabled', () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <Button variant="bid" onClick={onClick}>
        Bid
      </Button>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
    rerender(
      <Button variant="bid" disabled reason="nope" onClick={onClick}>
        Bid
      </Button>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    render(
      <Sheet open={false} onClose={() => {}} title="Roster">
        <p>hidden</p>
      </Sheet>,
    )
    expect(screen.queryByText('hidden')).toBeNull()
  })

  it('is a modal dialog labelled for screen readers', () => {
    render(
      <Sheet open onClose={() => {}} title="Your roster">
        <button type="button">first</button>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Your roster')
  })

  it('closes on Escape so a mis-tap never traps someone mid-auction', () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Roster">
        <button type="button">first</button>
      </Sheet>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the sheet and returns it to the opener on close', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { rerender } = render(
      <Sheet open onClose={() => {}} title="Roster">
        <button type="button">inside</button>
      </Sheet>,
    )
    expect((document.activeElement as HTMLElement).textContent).toBe('inside')

    rerender(
      <Sheet open={false} onClose={() => {}} title="Roster">
        <button type="button">inside</button>
      </Sheet>,
    )
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
