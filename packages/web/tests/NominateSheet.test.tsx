import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { DraftState } from '@auction/engine'
import { NominateSheet } from '../src/views/NominateSheet.js'
import { makeFakeClient } from './helpers/fakeClient.js'
import { testState } from './helpers/fixtures.js'

function myTurnState(overrides: Partial<DraftState> = {}): DraftState {
  return testState({
    phase: { type: 'awaiting_nomination', teamId: 'T1', deadline: Date.now() + 20_000 },
    ...overrides,
  })
}

describe('NominateSheet', () => {
  it("stays closed when it is not the viewer's turn", () => {
    const state = testState({ phase: { type: 'awaiting_nomination', teamId: 'T2', deadline: Date.now() + 20_000 } })
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<NominateSheet client={client} view={client.view} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("opens automatically when it is the viewer's turn, focusing the search field", () => {
    const { client } = makeFakeClient({ state: myTurnState(), teamId: 'T1' })
    render(<NominateSheet client={client} view={client.view} />)
    const search = screen.getByLabelText('Search players')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(search)
  })

  it('never lists a player the viewer has no roster room for', () => {
    const state = myTurnState()
    // Fill T1's dedicated QB slot and both BENCH slots (BENCH is QB-eligible
    // too) with non-QB fillers, leaving only the RB slot open — QB has nowhere
    // left to go, so no QB should appear even though QBs remain available.
    state.teams['T1']!.roster = [
      { playerId: 'QB9', price: 1, slot: 'QB', position: 'QB' },
      { playerId: 'X1', price: 1, slot: 'BENCH', position: 'WR' },
      { playerId: 'X2', price: 1, slot: 'BENCH', position: 'WR' },
    ]
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<NominateSheet client={client} view={client.view} />)
    expect(screen.queryByText(/^QB Player/)).toBeNull()
    expect(screen.getByText('RB Player 1')).toBeTruthy()
  })

  it('filters results by the search field', () => {
    const { client } = makeFakeClient({ state: myTurnState(), teamId: 'T1' })
    render(<NominateSheet client={client} view={client.view} />)
    fireEvent.change(screen.getByLabelText('Search players'), { target: { value: 'RB Player 2' } })
    expect(screen.getByText('RB Player 2')).toBeTruthy()
    expect(screen.queryByText('RB Player 1')).toBeNull()
  })

  it('defaults the opening bid to $1 and never lets it exceed the viewer max bid', () => {
    const state = myTurnState()
    // capacity 4 (QB1, RB1, BENCH2), budget 12 -> maxBid = 12 - (4-1) = 9
    state.teams['T1']!.budget = 12
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<NominateSheet client={client} view={client.view} />)
    fireEvent.click(screen.getByText('RB Player 1'))
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('Max $9')).toBeTruthy()
    const plus = screen.getByText('+').closest('button') as HTMLButtonElement
    for (let i = 0; i < 12; i++) fireEvent.click(plus)
    expect(screen.getByText('9')).toBeTruthy()
    expect(screen.queryByText('10')).toBeNull()
    expect(plus.disabled).toBe(true)
  })

  it("sends NOMINATE with the viewer's own teamId, the selected player, and the opening bid", async () => {
    const { client, sent } = makeFakeClient({ state: myTurnState(), teamId: 'T1' })
    render(<NominateSheet client={client} view={client.view} />)
    fireEvent.click(screen.getByText('RB Player 1'))
    const plus = screen.getByText('+').closest('button') as HTMLButtonElement
    fireEvent.click(plus)
    fireEvent.click(plus)
    fireEvent.click(screen.getByText('Nominate RB Player 1'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toContainEqual({ type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 3 })
  })

  it('closes when the phase changes out of the viewer turn (server auto-nominated at expiry)', () => {
    const { client, push } = makeFakeClient({ state: myTurnState(), teamId: 'T1' })
    const { rerender } = render(<NominateSheet client={client} view={client.view} />)
    expect(screen.getByRole('dialog')).toBeTruthy()

    const bidding = testState({
      phase: {
        type: 'bidding',
        playerId: 'RB1',
        price: 1,
        highBidderId: 'T1',
        nominatorId: 'T1',
        deadline: Date.now() + 10_000,
      },
    })
    push({ state: bidding })
    rerender(<NominateSheet client={client} view={client.view} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
