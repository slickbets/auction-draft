import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { BlockCard } from '../src/views/BlockCard.js'
import { testState } from './helpers/fixtures.js'
import type { DraftView } from '../src/client/draftClient.js'

function biddingView(
  patch: Partial<{ price: number; highBidderId: string; playerId: string }> = {},
  viewPatch: Partial<DraftView> = {},
): DraftView {
  const state = testState({
    phase: {
      type: 'bidding',
      playerId: patch.playerId ?? 'RB1',
      price: patch.price ?? 10,
      highBidderId: patch.highBidderId ?? 'T2',
      nominatorId: 'T1',
      deadline: Date.now() + 8_000,
    },
  })
  return {
    status: 'live',
    seq: 1,
    role: 'manager',
    teamId: 'T1',
    presence: [],
    notice: null,
    lastError: null,
    state,
    ...viewPatch,
  }
}

afterEach(() => vi.useRealTimers())

describe('BlockCard', () => {
  it('renders position, player name, nfl team, and the hero price', () => {
    render(<BlockCard view={biddingView()} msLeft={8_000} totalMs={10_000} />)
    expect(screen.getByText('RB')).toBeTruthy() // position chip
    expect(screen.getByText('RB Player 1')).toBeTruthy()
    expect(screen.getByText('FA')).toBeTruthy()
    expect(screen.getByText('10')).toBeTruthy()
  })

  it('renders nothing outside the bidding phase', () => {
    const view = biddingView()
    const notBidding: DraftView = { ...view, state: { ...view.state!, phase: { type: 'lobby' } } }
    const { container } = render(<BlockCard view={notBidding} msLeft={0} totalMs={10_000} />)
    expect(container.firstChild).toBeNull()
  })

  it('replays the roll animation and shows a rising +$N delta on a price change, which clears after 900ms', () => {
    vi.useFakeTimers()
    const { rerender } = render(<BlockCard view={biddingView({ price: 10 })} msLeft={8_000} totalMs={10_000} />)
    expect(screen.queryByText('+$3')).toBeNull()
    rerender(<BlockCard view={biddingView({ price: 13 })} msLeft={8_000} totalMs={10_000} />)
    expect(screen.getByText('+$3')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(900)
    })
    expect(screen.queryByText('+$3')).toBeNull()
  })

  it('shows GOING ONCE inside 3 seconds and GOING TWICE inside 1.5, with the urgency animation on the card edge', () => {
    const { container, rerender } = render(<BlockCard view={biddingView()} msLeft={5_000} totalMs={10_000} />)
    expect(screen.queryByText('GOING ONCE')).toBeNull()
    const card = () => container.querySelector('[data-testid="block-card"]') as HTMLElement

    rerender(<BlockCard view={biddingView()} msLeft={2_500} totalMs={10_000} />)
    expect(screen.getByText('GOING ONCE')).toBeTruthy()
    expect(card().style.animation).toContain('urgency')

    rerender(<BlockCard view={biddingView()} msLeft={1_200} totalMs={10_000} />)
    expect(screen.getByText('GOING TWICE')).toBeTruthy()
    expect(card().style.animation).toContain('urgency')
  })

  it("reads You're leading, in brass, only when the viewer holds the high bid", () => {
    const { rerender } = render(<BlockCard view={biddingView({ highBidderId: 'T2' })} msLeft={8_000} totalMs={10_000} />)
    expect(screen.getByText('Dave leading')).toBeTruthy()
    expect(screen.queryByText("You're leading")).toBeNull()

    rerender(<BlockCard view={biddingView({ highBidderId: 'T1' })} msLeft={8_000} totalMs={10_000} />)
    const leadLine = screen.getByText("You're leading")
    expect(leadLine.style.color).toContain('var(--brass)')
  })

  it('announces a price change once, not on every render of the ticking clock', () => {
    const view1 = biddingView({ price: 10 })
    const { rerender } = render(<BlockCard view={view1} msLeft={8_000} totalMs={10_000} />)
    const region = () => screen.getByText(/RB Player 1 at \$/)
    expect(region().textContent).toBe('RB Player 1 at $10')

    // Re-render on the same view/state reference (as a clock tick would do) —
    // the live region must not be recomputed or cleared.
    rerender(<BlockCard view={view1} msLeft={7_800} totalMs={10_000} />)
    expect(region().textContent).toBe('RB Player 1 at $10')

    const view2 = biddingView({ price: 12 })
    rerender(<BlockCard view={view2} msLeft={7_800} totalMs={10_000} />)
    expect(region().textContent).toBe('RB Player 1 at $12')
  })
})
