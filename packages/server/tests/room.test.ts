import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MemEventStore } from './helpers/memStore.js'
import { Room, type RoomDeps } from '../src/room.js'
import type { DraftEvent, LeagueConfig } from '@auction/engine'

function config(): LeagueConfig {
  const teams = Array.from({ length: 2 }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
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
  }
}

describe('Room', () => {
  let deps: RoomDeps
  let broadcasts: { seq: number; events: DraftEvent[] }[]
  let nowMs: number

  beforeEach(() => {
    vi.useFakeTimers()
    nowMs = 1_000
    broadcasts = []
    deps = {
      store: new MemEventStore(),
      broadcast: (_id, seq, events) => broadcasts.push({ seq, events }),
      notify: () => {},
      clock: () => nowMs,
    }
  })
  afterEach(() => vi.useRealTimers())

  it('runs commands through execute/persist/apply/broadcast with server-stamped now', async () => {
    const room = await Room.create('l1', config(), deps)
    const r = await room.dispatch({ type: 'START_DRAFT' })
    expect(r.ok).toBe(true)
    expect(room.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1', deadline: 31_000 })
    expect(room.lastSeq).toBe(2)
    expect(broadcasts[0]!.events.map(e => e.type)).toEqual(['DRAFT_STARTED', 'NOMINATION_STARTED'])
    const { events } = await deps.store.load('l1')
    expect(events.map(e => e.type)).toEqual(['DRAFT_STARTED', 'NOMINATION_STARTED'])
    room.close()
  })

  it('returns engine errors without persisting or broadcasting', async () => {
    const room = await Room.create('l1', config(), deps)
    await room.dispatch({ type: 'START_DRAFT' })
    const bad = await room.dispatch({ type: 'BID', teamId: 'T2', amount: 5 })
    expect(!bad.ok && bad.error.code).toBe('WRONG_PHASE')
    expect(room.lastSeq).toBe(2)
    expect(broadcasts).toHaveLength(1)
    room.close()
  })

  it('fires the clock: nomination expiry auto-nominates, bid expiry sells', async () => {
    const room = await Room.create('l1', config(), deps)
    await room.dispatch({ type: 'START_DRAFT' })
    nowMs = 31_001
    await vi.advanceTimersByTimeAsync(30_001)
    expect(room.state.phase).toMatchObject({ type: 'bidding', playerId: 'QB1', highBidderId: 'T1' })
    nowMs = 41_002
    await vi.advanceTimersByTimeAsync(10_001)
    expect(room.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
    expect(room.state.teams['T1']!.roster).toHaveLength(1)
    room.close()
  })

  it('serializes concurrent dispatches: same-price race yields one winner and one STALE_PRICE', async () => {
    const room = await Room.create('l1', config(), deps)
    await room.dispatch({ type: 'START_DRAFT' })
    await room.dispatch({ type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 5 })
    const [a, b] = await Promise.all([
      room.dispatch({ type: 'BID', teamId: 'T2', amount: 6 }),
      room.dispatch({ type: 'BID', teamId: 'T2', amount: 6 }),
    ])
    const oks = [a, b].filter(r => r.ok)
    const errs = [a, b].filter(r => !r.ok)
    expect(oks).toHaveLength(1)
    expect(errs).toHaveLength(1)
    if (!errs[0]!.ok) expect(errs[0]!.error.code).toMatch(/STALE_PRICE|ALREADY_HIGH_BIDDER/)
    room.close()
  })

  it('close() is terminal: queued work cannot arm a new timer', async () => {
    const room = await Room.create('l1', config(), deps)
    await room.dispatch({ type: 'START_DRAFT' })
    const queued = room.dispatch({ type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 1 })
    room.close()
    await queued
    await room.idle()
    // If a timer were armed post-close, this would fire CLOCK_EXPIRED and change phase.
    const before = JSON.stringify(room.state.phase)
    nowMs += 60_000
    await vi.advanceTimersByTimeAsync(60_000)
    expect(JSON.stringify(room.state.phase)).toBe(before)
  })
})
