import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { BoardView } from '../src/views/BoardView.js'
import { makeFakeClient } from './helpers/fakeClient.js'
import { testState } from './helpers/fixtures.js'
import type { DraftState } from '@auction/engine'

function biddingState(patch: Partial<{ price: number; highBidderId: string; deadline: number }> = {}): DraftState {
  return testState({
    phase: {
      type: 'bidding',
      playerId: 'RB1',
      price: patch.price ?? 10,
      highBidderId: patch.highBidderId ?? 'T2',
      nominatorId: 'T1',
      deadline: patch.deadline ?? Date.now() + 8_000,
    },
  })
}

describe('BoardView — team grid', () => {
  it('shows every team with its remaining budget', () => {
    const { client } = makeFakeClient({ role: 'board', teamId: null, state: testState() })
    render(<BoardView client={client} view={client.view} />)
    for (const team of client.view.state!.config.teams) {
      const card = screen.getByTestId(`team-card-${team.id}`)
      expect(within(card).getByText(team.name)).toBeTruthy()
      expect(within(card).getByText('200')).toBeTruthy()
    }
  })
})

describe('BoardView — sold ticker', () => {
  it('shows the most recent sale first and caps the list at 8', () => {
    const state = testState()
    // 9 sales so the oldest (overall 1) must be dropped.
    const playerIds = ['QB1', 'QB2', 'QB3', 'RB1', 'RB2', 'RB3', 'WR1', 'WR2', 'WR3']
    state.sales = playerIds.map((playerId, i) => ({
      playerId,
      teamId: 'T1',
      price: 10 + i,
      nominatorId: 'T1',
      pointerBefore: 0,
      overall: i + 1,
    }))
    const { client } = makeFakeClient({ role: 'board', teamId: null, state })
    render(<BoardView client={client} view={client.view} />)
    const rows = screen.getAllByTestId(/sold-row-/)
    expect(rows).toHaveLength(8)
    // Newest (overall 9, WR3) first.
    expect(rows[0]!.getAttribute('data-testid')).toBe('sold-row-9')
    expect(rows[0]!.textContent).toContain('WR Player 3')
    // Oldest (overall 1) dropped.
    expect(screen.queryByTestId('sold-row-1')).toBeNull()
  })
})

describe('BoardView — non-interactive', () => {
  it('renders zero button elements in any phase', () => {
    for (const state of [testState(), biddingState(), testState({ phase: { type: 'complete' } })]) {
      const { client } = makeFakeClient({ role: 'board', teamId: null, state })
      const { container, unmount } = render(<BoardView client={client} view={client.view} />)
      expect(container.querySelectorAll('button')).toHaveLength(0)
      unmount()
    }
  })
})

describe('BoardView — phases without crashing', () => {
  it('renders lobby (nothing on the block yet)', () => {
    const { client } = makeFakeClient({ role: 'board', teamId: null, state: testState() })
    render(<BoardView client={client} view={client.view} />)
    expect(screen.getByText(/waiting/i)).toBeTruthy()
  })

  it('renders bidding with the player on the block', () => {
    const { client } = makeFakeClient({ role: 'board', teamId: null, state: biddingState() })
    render(<BoardView client={client} view={client.view} />)
    expect(screen.getByText('RB Player 1')).toBeTruthy()
    expect(screen.getByText('Dave')).toBeTruthy() // T2 leading
  })

  it('renders complete', () => {
    const { client } = makeFakeClient({ role: 'board', teamId: null, state: testState({ phase: { type: 'complete' } }) })
    render(<BoardView client={client} view={client.view} />)
    expect(screen.getByText(/draft complete/i)).toBeTruthy()
  })

  it('does not crash on a snapshot missing config/teams', () => {
    const { client } = makeFakeClient({ role: 'board', teamId: null, state: { phase: { type: 'lobby' } } as any })
    expect(() => render(<BoardView client={client} view={client.view} />)).not.toThrow()
  })
})

describe('BoardView — GOING ONCE / GOING TWICE', () => {
  it('reads GOING ONCE inside 3s and GOING TWICE inside 1.5s, at display scale', () => {
    const { client, push } = makeFakeClient({
      role: 'board',
      teamId: null,
      state: biddingState({ deadline: Date.now() + 8_000 }),
    })
    const { rerender } = render(<BoardView client={client} view={client.view} />)
    expect(screen.queryByText('GOING ONCE')).toBeNull()

    push({ state: biddingState({ deadline: Date.now() + 2_500 }) })
    rerender(<BoardView client={client} view={client.view} />)
    expect(screen.getByText('GOING ONCE')).toBeTruthy()

    push({ state: biddingState({ deadline: Date.now() + 1_000 }) })
    rerender(<BoardView client={client} view={client.view} />)
    expect(screen.getByText('GOING TWICE')).toBeTruthy()
  })
})

describe('BoardView — sold stamp', () => {
  it('shows the SOLD stamp in --sold when a new sale lands, and it is the only green in the render', () => {
    const state = testState({
      phase: { type: 'awaiting_nomination', teamId: 'T2', deadline: Date.now() + 20_000 },
    })
    const { client, push } = makeFakeClient({ role: 'board', teamId: null, state })
    const { container, rerender } = render(<BoardView client={client} view={client.view} />)
    expect(screen.queryByText('SOLD')).toBeNull()

    const nextState = testState({
      phase: { type: 'awaiting_nomination', teamId: 'T3', deadline: Date.now() + 20_000 },
    })
    nextState.sales = [{ playerId: 'RB1', teamId: 'T1', price: 47, nominatorId: 'T2', pointerBefore: 1, overall: 1 }]
    push({ state: nextState })
    rerender(<BoardView client={client} view={client.view} />)

    const stamp = screen.getByText('SOLD')
    expect(stamp.style.color).toContain('var(--sold)')
    // No other element in the tree may use the --sold token.
    const all = [...container.querySelectorAll<HTMLElement>('*')]
    const soldUsers = all.filter(el => el.style.color.includes('var(--sold)') || el.style.background.includes('var(--sold)'))
    expect(soldUsers).toEqual([stamp])
  })
})
