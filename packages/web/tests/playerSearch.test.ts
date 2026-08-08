import { describe, it, expect } from 'vitest'
import type { LeagueConfig, PlayerInfo, Position, SlotDef } from '@auction/engine'
import { initialState } from '@auction/engine'
import { searchPlayers } from '../src/playerSearch.js'

const ALL: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']

function players(perPosition: Partial<Record<Position, number>>): PlayerInfo[] {
  const list: PlayerInfo[] = []
  let rank = 1
  for (const pos of ALL) {
    const n = perPosition[pos] ?? 0
    for (let i = 1; i <= n; i++) {
      list.push({ id: `${pos}${i}`, name: `${pos} Player ${i}`, position: pos, nflTeam: 'FA', rank: rank++ })
    }
  }
  return list
}

/** No slot anywhere accepts K — mirrors a real league that doesn't draft kickers. */
const NO_KICKER_TEMPLATE: SlotDef[] = [
  { name: 'QB', eligible: ['QB'], count: 1 },
  { name: 'FLEX', eligible: ['RB', 'WR', 'TE'], count: 3 },
]

function configWith(overrides: Partial<LeagueConfig> = {}): LeagueConfig {
  const teams = [{ id: 'T1', name: 'Cook' }, { id: 'T2', name: 'Dave' }]
  return {
    teams,
    budget: 200,
    rosterTemplate: NO_KICKER_TEMPLATE,
    bidClockMs: 10_000,
    nominationClockMs: 30_000,
    nominationOrder: teams.map(t => t.id),
    nominationExpiryPolicy: 'auto_nominate',
    players: players({ QB: 2, RB: 2, WR: 2, TE: 2, K: 2, DST: 2 }),
    ...overrides,
  }
}

describe('searchPlayers', () => {
  it('never returns a kicker when this league has no slot for the position', () => {
    const config = configWith()
    const state = initialState(config)
    const results = searchPlayers(state, 'T1', '')
    expect(results.some(p => p.position === 'K')).toBe(false)
  })

  it('excludes a position the viewer has already filled to its cap', () => {
    const config = configWith({ maxPerPosition: { RB: 1 } })
    let state = initialState(config)
    // Give T1 one RB already, filling the position's cap of 1.
    state = {
      ...state,
      teams: {
        ...state.teams,
        T1: { ...state.teams['T1']!, roster: [{ playerId: 'RB1', price: 5, slot: 'FLEX', position: 'RB' }] },
      },
      available: state.available.filter(id => id !== 'RB1'),
    }
    const results = searchPlayers(state, 'T1', '')
    expect(results.some(p => p.position === 'RB')).toBe(false)
  })

  it('still lets a different team (with no RB yet) see RB results under the same cap', () => {
    const config = configWith({ maxPerPosition: { RB: 1 } })
    const state = initialState(config)
    const results = searchPlayers(state, 'T2', '')
    expect(results.some(p => p.position === 'RB')).toBe(true)
  })

  it('only returns players still in the available pool', () => {
    const config = configWith()
    let state = initialState(config)
    state = { ...state, available: state.available.filter(id => id !== 'QB1') }
    const results = searchPlayers(state, 'T1', '')
    expect(results.some(p => p.id === 'QB1')).toBe(false)
  })

  it('orders results by engine rank ascending', () => {
    const config = configWith()
    const state = initialState(config)
    const results = searchPlayers(state, 'T1', '')
    const ranks = results.map(p => p.rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('caps results at the given limit, keeping the best-ranked players', () => {
    const config = configWith({ players: players({ QB: 1, RB: 30, WR: 1, TE: 1 }) })
    const state = initialState(config)
    const results = searchPlayers(state, 'T1', '', 5)
    expect(results).toHaveLength(5)
    expect(results.map(p => p.rank)).toEqual([1, 2, 3, 4, 5])
  })

  it('defaults the limit to 40', () => {
    const config = configWith({ players: players({ QB: 1, RB: 50 }) })
    const state = initialState(config)
    const results = searchPlayers(state, 'T1', '')
    expect(results).toHaveLength(40)
  })

  it('matches names case-insensitively on a substring', () => {
    const config = configWith()
    const state = initialState(config)
    const results = searchPlayers(state, 'T1', 'qb player 2')
    expect(results.map(p => p.id)).toEqual(['QB2'])
  })

  it('returns the top of the list for an empty query', () => {
    const config = configWith()
    const state = initialState(config)
    const results = searchPlayers(state, 'T1', '')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.rank).toBe(Math.min(...results.map(p => p.rank)))
  })

  it('returns nothing for an unknown viewer team', () => {
    const config = configWith()
    const state = initialState(config)
    expect(searchPlayers(state, 'NOPE', '')).toEqual([])
  })
})
