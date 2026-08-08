import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import { maxBid, openSlotCount } from '@auction/engine'
import { ManagerView } from '../src/views/ManagerView.js'
import { makeFakeClient } from './helpers/fakeClient.js'
import { testState } from './helpers/fixtures.js'

afterEach(() => vi.useRealTimers())

describe('ManagerView — lobby', () => {
  it('shows the waiting message and dedupes connected seats by teamId', () => {
    const { client } = makeFakeClient({
      state: testState(),
      teamId: 'T1',
      presence: [
        { role: 'manager', teamId: 'T1' },
        { role: 'manager', teamId: 'T1' }, // same manager, a second device
        { role: 'manager', teamId: 'T2' },
      ],
    })
    render(<ManagerView client={client} view={client.view} />)
    expect(screen.getByText('Waiting for the commissioner to start')).toBeTruthy()
    expect(screen.getAllByText('Cook')).toHaveLength(1)
    expect(screen.getAllByText('Dave')).toHaveLength(1)
    expect(screen.queryByText('Ann')).toBeNull()
  })
})

describe('ManagerView — awaiting_nomination', () => {
  it("prompts the viewer to nominate when it's their team, with a mount point for the nominate sheet", () => {
    const state = testState({ phase: { type: 'awaiting_nomination', teamId: 'T1', deadline: Date.now() + 20_000 } })
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<ManagerView client={client} view={client.view} />)
    expect(screen.getByText("You're up — nominate a player")).toBeTruthy()
    expect(screen.getByTestId('nominate-sheet-mount')).toBeTruthy()
  })

  it('shows who is nominating, and the countdown, when it is not the viewer', () => {
    const state = testState({ phase: { type: 'awaiting_nomination', teamId: 'T2', deadline: Date.now() + 20_000 } })
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<ManagerView client={client} view={client.view} />)
    expect(screen.getByText('Dave is nominating')).toBeTruthy()
    expect(within(screen.getByTestId('phase-body')).getByText('sec')).toBeTruthy()
  })

  it('keeps the countdown live by re-reading client.msLeft on a tick', () => {
    vi.useFakeTimers()
    const state = testState({ phase: { type: 'awaiting_nomination', teamId: 'T2', deadline: Date.now() + 20_000 } })
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<ManagerView client={client} view={client.view} />)
    const body = within(screen.getByTestId('phase-body'))
    const before = Number(body.getByText(/^\d+$/).textContent)
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    const after = Number(body.getByText(/^\d+$/).textContent)
    expect(after).toBeLessThan(before)
  })
})

describe('ManagerView — bidding', () => {
  it('renders the block card and bid controls together', () => {
    const state = testState({
      phase: {
        type: 'bidding',
        playerId: 'RB1',
        price: 10,
        highBidderId: 'T2',
        nominatorId: 'T1',
        deadline: Date.now() + 8_000,
      },
    })
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<ManagerView client={client} view={client.view} />)
    expect(screen.getByText('RB Player 1')).toBeTruthy() // BlockCard
    expect(screen.getByText('+$1 → 11')).toBeTruthy() // BidControls
  })
})

describe('ManagerView — paused', () => {
  it('shows the paused message and the frozen remaining time', () => {
    const state = testState({
      phase: {
        type: 'paused',
        inner: {
          type: 'bidding',
          playerId: 'RB1',
          price: 10,
          highBidderId: 'T2',
          nominatorId: 'T1',
          deadline: 999_999,
        },
        remainingMs: 6_400,
      },
    })
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<ManagerView client={client} view={client.view} />)
    expect(screen.getByText('Draft paused by the commissioner')).toBeTruthy()
    expect(within(screen.getByTestId('phase-body')).getByText('7')).toBeTruthy() // ceil(6400/1000)
  })
})

describe('ManagerView — complete', () => {
  it("shows the draft-complete message and the viewer's final roster", () => {
    const state = testState({ phase: { type: 'complete' } })
    state.teams['T1']!.roster = [{ playerId: 'RB1', price: 14, slot: 'RB', position: 'RB' }]
    state.teams['T1']!.budget = 186
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<ManagerView client={client} view={client.view} />)
    expect(screen.getByText('Draft complete')).toBeTruthy()
    expect(screen.getByText('RB Player 1')).toBeTruthy()
    expect(screen.getByText('14')).toBeTruthy()
  })
})

describe('StatusHeader (mounted inside ManagerView)', () => {
  it("shows the viewer's engine-derived budget, max bid, and open slots — never hand-computed", () => {
    const state = testState()
    const team = state.teams['T1']!
    const expectedMax = maxBid(team, state.config)
    const expectedOpen = openSlotCount(team, state.config)
    const { client } = makeFakeClient({ state, teamId: 'T1' })
    render(<ManagerView client={client} view={client.view} />)
    expect(screen.getByText('Max bid')).toBeTruthy()
    expect(screen.getByText(String(expectedMax))).toBeTruthy()
    expect(screen.getByText(String(team.budget))).toBeTruthy()
    expect(screen.getByText(String(expectedOpen))).toBeTruthy()
  })
})
