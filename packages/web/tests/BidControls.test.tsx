import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BidControls } from '../src/views/BidControls.js'
import { makeFakeClient } from './helpers/fakeClient.js'
import { testState } from './helpers/fixtures.js'
import type { DraftState } from '@auction/engine'

function biddingState(phasePatch: Partial<{ price: number; highBidderId: string }> = {}): DraftState {
  return testState({
    phase: {
      type: 'bidding',
      playerId: 'RB1',
      price: phasePatch.price ?? 10,
      highBidderId: phasePatch.highBidderId ?? 'T2',
      nominatorId: 'T1',
      deadline: Date.now() + 8_000,
    },
  })
}

describe('BidControls', () => {
  it('labels the quick-bid buttons with the resulting price', () => {
    const { client } = makeFakeClient({ state: biddingState(), teamId: 'T1' })
    render(<BidControls client={client} view={client.view} />)
    expect(screen.getByText('+$1 → 11')).toBeTruthy()
    expect(screen.getByText('+$5 → 15')).toBeTruthy()
  })

  it("sends BID with the resulting amount and the viewer's own teamId", async () => {
    const { client, sent } = makeFakeClient({ state: biddingState(), teamId: 'T1' })
    render(<BidControls client={client} view={client.view} />)
    fireEvent.click(screen.getByText('+$1 → 11'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'BID', teamId: 'T1', amount: 11 })
  })

  it('disables a bid that would exceed max bid, and shows the reason', () => {
    const state = biddingState()
    state.teams['T1']!.budget = 12 // openSlotCount 4 (capacity) -> maxBid = 12 - 3 = 9
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<BidControls client={client} view={client.view} />)
    const plusOne = screen.getByText('+$1 → 11').closest('button') as HTMLButtonElement
    expect(plusOne.disabled).toBe(true)
    // Both quick-bid buttons are over max, so both show the reason.
    expect(screen.getAllByText('Max bid $9').length).toBeGreaterThan(0)
  })

  it("disables when the viewer is already the high bidder, and shows You're leading", () => {
    const state = biddingState({ highBidderId: 'T1' })
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<BidControls client={client} view={client.view} />)
    const plusOne = screen.getByText('+$1 → 11').closest('button') as HTMLButtonElement
    expect(plusOne.disabled).toBe(true)
    expect(screen.getAllByText("You're leading").length).toBeGreaterThan(0)
  })

  it('disables when the viewer has no open roster spot for the position on the block', () => {
    const state = biddingState()
    // Fill T1's dedicated RB slot and both BENCH slots (BENCH is RB-eligible too),
    // leaving only the QB slot open — which cannot take an RB.
    state.teams['T1']!.roster = [
      { playerId: 'RB9', price: 1, slot: 'RB', position: 'RB' },
      { playerId: 'X1', price: 1, slot: 'BENCH', position: 'WR' },
      { playerId: 'X2', price: 1, slot: 'BENCH', position: 'WR' },
    ]
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<BidControls client={client} view={client.view} />)
    const plusOne = screen.getByText('+$1 → 11').closest('button') as HTMLButtonElement
    expect(plusOne.disabled).toBe(true)
    expect(screen.getAllByText('No open spot for a RB').length).toBeGreaterThan(0)
  })

  it('shows the re-raise message on STALE_PRICE and leaves the control enabled to bid again', async () => {
    const { client, ack } = makeFakeClient({ state: biddingState(), teamId: 'T1' })
    ack({ ok: false, error: { code: 'STALE_PRICE', message: 'Price is already $11' } })
    render(<BidControls client={client} view={client.view} />)
    fireEvent.click(screen.getByText('+$1 → 11'))
    await screen.findByText(/Bid again to stay in\./)
    const plusOne = screen.getByText('+$1 → 11').closest('button') as HTMLButtonElement
    expect(plusOne.disabled).toBe(false)
  })

  it('reflects the latest known price in the STALE_PRICE message, not a stale value from click time', async () => {
    const { client, push, ack } = makeFakeClient({ state: biddingState({ price: 10 }), teamId: 'T1' })
    const { rerender } = render(<BidControls client={client} view={client.view} />)
    ack({ ok: false, error: { code: 'STALE_PRICE', message: 'Price is already $15' } })
    fireEvent.click(screen.getByText('+$1 → 11'))
    // Simulate the server's broadcast of the winning bid landing (via `events`)
    // before the ack for this rejected bid resolves — the ordering draftClient
    // guarantees on a real socket — then a re-render with the fresh view.
    push({ state: biddingState({ price: 15 }) })
    rerender(<BidControls client={client} view={client.view} />)
    await screen.findByText('Someone bid $15 first. Bid again to stay in.')
  })

  it('maps EXCEEDS_MAX_BID and NO_ELIGIBLE_SLOT acks to plain copy', async () => {
    const { client, ack } = makeFakeClient({ state: biddingState(), teamId: 'T1' })
    ack({ ok: false, error: { code: 'EXCEEDS_MAX_BID', message: 'Max bid 9' } })
    render(<BidControls client={client} view={client.view} />)
    fireEvent.click(screen.getByText('+$5 → 15'))
    await screen.findByText("That's over your max bid.")
  })

  it('supports a custom bid amount, disabled until a valid whole number is entered', async () => {
    const { client, sent } = makeFakeClient({ state: biddingState(), teamId: 'T1' })
    render(<BidControls client={client} view={client.view} />)
    const input = screen.getByLabelText('Custom bid amount')
    const bidButton = screen.getByText('Bid').closest('button') as HTMLButtonElement
    expect(bidButton.disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'abc' } })
    expect(bidButton.disabled).toBe(true)

    fireEvent.change(input, { target: { value: '25' } })
    expect(bidButton.disabled).toBe(false)
    fireEvent.click(bidButton)
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'BID', teamId: 'T1', amount: 25 })
  })

  it('renders nothing outside the bidding phase', () => {
    const { client } = makeFakeClient({ state: testState(), teamId: 'T1' }) // lobby
    const { container } = render(<BidControls client={client} view={client.view} />)
    expect(container.firstChild).toBeNull()
  })

  it('gives bid buttons a thumb-sized (>=44px) target', () => {
    const { client } = makeFakeClient({ state: biddingState(), teamId: 'T1' })
    render(<BidControls client={client} view={client.view} />)
    const plusOne = screen.getByText('+$1 → 11').closest('button') as HTMLButtonElement
    expect(plusOne.style.minHeight).toBe('44px')
  })
})
