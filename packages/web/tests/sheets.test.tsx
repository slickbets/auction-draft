import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { maxBid } from '@auction/engine'
import { RosterSheet } from '../src/views/RosterSheet.js'
import { TeamsSheet } from '../src/views/TeamsSheet.js'
import { testState } from './helpers/fixtures.js'

describe('RosterSheet', () => {
  it('renders filled and empty slots in template order (QB, RB, BENCH, BENCH), empty ones as outlines', () => {
    const state = testState()
    state.teams['T1']!.roster = [{ playerId: 'RB1', price: 14, slot: 'RB', position: 'RB' }]
    render(<RosterSheet view={{ state } as any} teamId="T1" open onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    const rows = within(dialog).getAllByTestId(/^roster-slot-/)
    expect(rows.map(r => r.dataset.testid)).toEqual([
      'roster-slot-QB-0',
      'roster-slot-RB-0',
      'roster-slot-BENCH-0',
      'roster-slot-BENCH-1',
    ])

    // Filled: RB row shows the player and price.
    expect(within(rows[1]!).getByText('RB Player 1')).toBeTruthy()
    expect(within(rows[1]!).getByText('14')).toBeTruthy()
    expect(rows[1]!.dataset.filled).toBe('true')

    // Empty: QB and both BENCH rows render as outlines, not filled.
    expect(rows[0]!.dataset.filled).toBe('false')
    expect(rows[2]!.dataset.filled).toBe('false')
    expect(rows[3]!.dataset.filled).toBe('false')
  })

  it('shows spent, remaining, and max bid in the footer', () => {
    const state = testState()
    state.teams['T1']!.roster = [{ playerId: 'RB1', price: 14, slot: 'RB', position: 'RB' }]
    state.teams['T1']!.budget = 186 // 200 - 14
    render(<RosterSheet view={{ state } as any} teamId="T1" open onClose={() => {}} />)

    const expectedMax = maxBid(state.teams['T1']!, state.config)
    // Scoped to the totals row: the RB row's price is also 14, so an unscoped
    // query would match the roster entry rather than the footer.
    const totals = within(screen.getByTestId('roster-totals'))
    expect(totals.getByText('Spent')).toBeTruthy()
    expect(totals.getByText('14')).toBeTruthy()
    expect(totals.getByText('Remaining')).toBeTruthy()
    expect(totals.getByText('186')).toBeTruthy()
    expect(totals.getByText('Max bid')).toBeTruthy()
    expect(totals.getByText(String(expectedMax))).toBeTruthy()
  })

  it('renders nothing when closed', () => {
    const state = testState()
    render(<RosterSheet view={{ state } as any} teamId="T1" open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('TeamsSheet', () => {
  it('sorts teams by remaining budget descending', () => {
    const state = testState()
    state.teams['T1']!.budget = 120
    state.teams['T2']!.budget = 200
    state.teams['T3']!.budget = 50
    render(<TeamsSheet view={{ state } as any} open onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    const names = within(dialog)
      .getAllByTestId(/^team-row-/)
      .map(row => row.dataset.testid)
    expect(names).toEqual(['team-row-T2', 'team-row-T1', 'team-row-T3'])
  })

  it('shows remaining budget and open slot count for every team', () => {
    const state = testState()
    render(<TeamsSheet view={{ state } as any} open onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByText('200')).toHaveLength(3) // all three teams start with the full budget
    expect(within(dialog).getAllByText('4')).toHaveLength(3) // template capacity, all open
    expect(within(dialog).getByText('Cook')).toBeTruthy()
    expect(within(dialog).getByText('Dave')).toBeTruthy()
    expect(within(dialog).getByText('Ann')).toBeTruthy()
  })
})
