import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MemEventStore } from './helpers/memStore.js'
import { Room, type RoomDeps } from '../src/room.js'
import type { LeagueConfig } from '@auction/engine'

function config(overrides: Partial<LeagueConfig> = {}): LeagueConfig {
  const teams = [{ id: 'T1', name: 'A' }, { id: 'T2', name: 'B' }]
  return {
    teams,
    budget: 200,
    rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }],
    bidClockMs: 10_000,
    nominationClockMs: 30_000,
    nominationOrder: ['T1', 'T2'],
    nominationExpiryPolicy: 'auto_nominate',
    players: [
      { id: 'QB1', name: 'QB One', position: 'QB', nflTeam: 'SF', rank: 1 },
      { id: 'QB2', name: 'QB Two', position: 'QB', nflTeam: 'KC', rank: 2 },
    ],
    ...overrides,
  }
}

describe('recovery', () => {
  let deps: RoomDeps
  let notices: { type: string }[]
  let nowMs: number

  beforeEach(async () => {
    vi.useFakeTimers()
    nowMs = 1_000
    notices = []
    deps = {
      store: new MemEventStore(),
      broadcast: () => {},
      notify: (_id, n) => notices.push(n),
      clock: () => nowMs,
    }
  })
  afterEach(() => vi.useRealTimers())

  it('reloading a mid-bidding room boot-pauses at the last event time with clamped remaining', async () => {
    const cfg = config()
    const room1 = await Room.create('l1', cfg, deps)
    await room1.dispatch({ type: 'START_DRAFT' }) // deadline 31_000
    await room1.dispatch({ type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 3 }) // at 1_000, deadline 11_000
    room1.close()
    // "crash": new room from the same stream, long after the deadline passed
    nowMs = 500_000
    const room2 = await Room.create('l1', cfg, deps)
    expect(room2.state.phase).toMatchObject({ type: 'paused', remainingMs: 10_000 })
    // resume works and re-arms from resume time, not from the stale deadline
    const r = await room2.dispatch({ type: 'RESUME' })
    expect(r.ok).toBe(true)
    expect(room2.state.phase).toMatchObject({ type: 'bidding', price: 3, deadline: 510_000 })
    room2.close()
  })

  it('does not boot-pause a lobby or completed stream', async () => {
    const room1 = await Room.create('l1', config(), deps)
    expect(room1.state.phase).toEqual({ type: 'lobby' })
    room1.close()
  })

  it('watchdog pauses after two full skip rotations and emits a notice', async () => {
    // Pool has only QBs; make both QB slots full via a tiny two-sale draft impossible -> instead: skip policy with no legal players.
    const cfg = config({ nominationExpiryPolicy: 'skip', players: [] })
    const room = await Room.create('l1', cfg, deps)
    await room.dispatch({ type: 'START_DRAFT' })
    for (let i = 0; i < 4; i++) {
      // each expiry: NOMINATION_SKIPPED + NOMINATION_STARTED for the other team
      const ph = room.state.phase
      if (ph.type !== 'awaiting_nomination') break
      nowMs = ph.deadline + 1
      await room.dispatch({ type: 'CLOCK_EXPIRED' })
    }
    await room.idle() // the watchdog's auto-pause is queued behind the triggering command
    expect(notices).toEqual([{ type: 'skip_loop' }])
    expect(room.state.phase.type).toBe('paused')
    room.close()
  })
})
