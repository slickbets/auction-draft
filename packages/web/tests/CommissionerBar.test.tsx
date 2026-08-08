import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { DraftState } from '@auction/engine'
import { CommissionerBar } from '../src/views/CommissionerBar.js'
import { makeFakeClient } from './helpers/fakeClient.js'
import { testState } from './helpers/fixtures.js'

function biddingState(patch: Partial<{ price: number; highBidderId: string }> = {}): DraftState {
  return testState({
    phase: {
      type: 'bidding',
      playerId: 'RB1',
      price: patch.price ?? 10,
      highBidderId: patch.highBidderId ?? 'T2',
      nominatorId: 'T1',
      deadline: Date.now() + 8_000,
    },
  })
}

function pausedState(): DraftState {
  return testState({
    phase: {
      type: 'paused',
      inner: { type: 'awaiting_nomination', teamId: 'T2', deadline: Date.now() + 20_000 },
      remainingMs: 12_000,
    },
  })
}

describe('CommissionerBar — start draft', () => {
  it('is enabled in the lobby', () => {
    const { client } = makeFakeClient({ role: 'commissioner', teamId: null, state: testState() })
    render(<CommissionerBar client={client} view={client.view} />)
    const start = screen.getByText('Start draft').closest('button') as HTMLButtonElement
    expect(start.disabled).toBe(false)
  })

  it('is disabled once the draft has left the lobby', () => {
    const { client } = makeFakeClient({ role: 'commissioner', teamId: null, state: biddingState() })
    render(<CommissionerBar client={client} view={client.view} />)
    const start = screen.getByText('Start draft').closest('button') as HTMLButtonElement
    expect(start.disabled).toBe(true)
  })

  it('sends START_DRAFT', async () => {
    const { client, sent } = makeFakeClient({ role: 'commissioner', teamId: null, state: testState() })
    render(<CommissionerBar client={client} view={client.view} />)
    fireEvent.click(screen.getByText('Start draft'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'START_DRAFT' })
  })

  it('shows the plain NO_PLAYERS message instead of a raw error code', async () => {
    const { client, ack } = makeFakeClient({ role: 'commissioner', teamId: null, state: testState() })
    ack({ ok: false, error: { code: 'NO_PLAYERS', message: 'player pool has 0, need at least 20' } })
    render(<CommissionerBar client={client} view={client.view} />)
    fireEvent.click(screen.getByText('Start draft'))
    await screen.findByText('The player pool is empty or too small. Refresh players before starting.')
  })
})

describe('CommissionerBar — pause/resume', () => {
  it('reads Pause while live and sends PAUSE', async () => {
    const { client, sent } = makeFakeClient({ role: 'commissioner', teamId: null, state: biddingState() })
    render(<CommissionerBar client={client} view={client.view} />)
    expect(screen.getByText('Pause')).toBeTruthy()
    expect(screen.queryByText('Resume')).toBeNull()
    fireEvent.click(screen.getByText('Pause'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'PAUSE' })
  })

  it('flips to Resume once paused and sends RESUME', async () => {
    const { client, sent } = makeFakeClient({ role: 'commissioner', teamId: null, state: pausedState() })
    render(<CommissionerBar client={client} view={client.view} />)
    expect(screen.getByText('Resume')).toBeTruthy()
    expect(screen.queryByText('Pause')).toBeNull()
    fireEvent.click(screen.getByText('Resume'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'RESUME' })
  })

  it('disables pause/resume in the lobby, where there is nothing running', () => {
    const { client } = makeFakeClient({ role: 'commissioner', teamId: null, state: testState() })
    render(<CommissionerBar client={client} view={client.view} />)
    const pause = screen.getByText('Pause').closest('button') as HTMLButtonElement
    expect(pause.disabled).toBe(true)
  })
})

describe('CommissionerBar — add time', () => {
  it('sends ADD_TIME with 30000ms', async () => {
    const { client, sent } = makeFakeClient({ role: 'commissioner', teamId: null, state: biddingState() })
    render(<CommissionerBar client={client} view={client.view} />)
    fireEvent.click(screen.getByText('+30s'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'ADD_TIME', ms: 30_000 })
  })

  it('disables +30s in the lobby, where there is no clock to extend', () => {
    const { client } = makeFakeClient({ role: 'commissioner', teamId: null, state: testState() })
    render(<CommissionerBar client={client} view={client.view} />)
    const addTime = screen.getByText('+30s').closest('button') as HTMLButtonElement
    expect(addTime.disabled).toBe(true)
  })
})

describe('CommissionerBar — proxy controls', () => {
  it('requires choosing a team before either proxy action is usable', () => {
    const { client } = makeFakeClient({ role: 'commissioner', teamId: null, state: biddingState() })
    render(<CommissionerBar client={client} view={client.view} />)
    const nominateFor = screen.getByText('Nominate for…').closest('button') as HTMLButtonElement
    const bidFor = screen.getByText('Bid for…').closest('button') as HTMLButtonElement
    expect(nominateFor.disabled).toBe(true)
    expect(bidFor.disabled).toBe(true)
    expect(screen.getAllByText('Choose a team first').length).toBeGreaterThan(0)
  })

  it('echoes the chosen team in the proxy action labels once selected', () => {
    const { client } = makeFakeClient({ role: 'commissioner', teamId: null, state: biddingState() })
    render(<CommissionerBar client={client} view={client.view} />)
    fireEvent.change(screen.getByLabelText('Acting as'), { target: { value: 'T2' } })
    expect(screen.getByText('Nominate for Dave')).toBeTruthy()
    expect(screen.getByText('Bid for Dave')).toBeTruthy()
  })

  it("sends a proxy BID with the selected team's id, never the commissioner's own", async () => {
    const { client, sent } = makeFakeClient({
      role: 'commissioner',
      teamId: null, // the commissioner owns no team of their own
      state: biddingState({ price: 10, highBidderId: 'T1' }),
    })
    render(<CommissionerBar client={client} view={client.view} />)
    fireEvent.change(screen.getByLabelText('Acting as'), { target: { value: 'T2' } })
    fireEvent.click(screen.getByText('Bid for Dave'))
    fireEvent.click(screen.getByText('+$1 for Dave → 11'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'BID', teamId: 'T2', amount: 11 })
    expect(sent).not.toContainEqual(expect.objectContaining({ type: 'BID', teamId: client.view.teamId }))
  })

  it('sends a proxy NOMINATE with the selected team\'s id', async () => {
    const state = testState({ phase: { type: 'awaiting_nomination', teamId: 'T2', deadline: Date.now() + 20_000 } })
    const { client, sent } = makeFakeClient({ role: 'commissioner', teamId: null, state })
    render(<CommissionerBar client={client} view={client.view} />)
    fireEvent.change(screen.getByLabelText('Acting as'), { target: { value: 'T2' } })
    fireEvent.click(screen.getByText('Nominate for Dave'))
    fireEvent.click(screen.getByText('RB Player 1'))
    fireEvent.click(screen.getByText('Nominate RB Player 1 for Dave'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'NOMINATE', teamId: 'T2', playerId: 'RB1', openingBid: 1 })
  })
})

describe('CommissionerBar — no corrections', () => {
  it('never renders undo, edit, or budget-adjustment controls (Plan 4)', () => {
    const { client } = makeFakeClient({ role: 'commissioner', teamId: null, state: biddingState() })
    render(<CommissionerBar client={client} view={client.view} />)
    expect(screen.queryByText(/undo/i)).toBeNull()
    expect(screen.queryByText(/edit pick/i)).toBeNull()
    expect(screen.queryByText(/adjust budget/i)).toBeNull()
  })
})

describe('CommissionerBar — defensive on partial state', () => {
  it('does not crash on a snapshot missing config/teams', () => {
    const { client } = makeFakeClient({ role: 'commissioner', teamId: null, state: { phase: { type: 'lobby' } } as any })
    expect(() => render(<CommissionerBar client={client} view={client.view} />)).not.toThrow()
  })
})
