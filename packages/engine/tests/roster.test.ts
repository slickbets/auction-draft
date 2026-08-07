import { describe, it, expect } from 'vitest'
import { initialState, rosterCapacity, openSlotCount, maxBid, firstOpenSlotFor } from '../src/index.js'
import { testConfig, STANDARD_TEMPLATE } from './fixtures.js'

describe('roster math', () => {
  const cfg = testConfig()

  it('capacity sums slot counts', () => {
    expect(rosterCapacity(STANDARD_TEMPLATE)).toBe(16)
  })

  it('initialState gives every team full budget and empty roster', () => {
    const s = initialState(cfg)
    expect(Object.keys(s.teams)).toHaveLength(10)
    expect(s.teams['T1']!.budget).toBe(200)
    expect(s.teams['T1']!.roster).toEqual([])
    expect(s.phase).toEqual({ type: 'lobby' })
    expect(s.available).toHaveLength(cfg.players.length)
    expect(s.pointer).toBe(0)
    expect(s.seq).toBe(0)
  })

  it('maxBid = budget - (openSlots - 1)', () => {
    const s = initialState(cfg)
    const t1 = s.teams['T1']!
    expect(openSlotCount(t1, cfg)).toBe(16)
    expect(maxBid(t1, cfg)).toBe(185) // 200 - 15
  })

  it('assigns first eligible open slot in template order, FLEX after positional, bench last', () => {
    const s = initialState(cfg)
    const t1 = s.teams['T1']!
    expect(firstOpenSlotFor(t1, 'RB', cfg)).toBe('RB')
    t1.roster.push({ playerId: 'RB1', price: 1, slot: 'RB', position: 'RB' }, { playerId: 'RB2', price: 1, slot: 'RB', position: 'RB' })
    expect(firstOpenSlotFor(t1, 'RB', cfg)).toBe('FLEX')
    t1.roster.push({ playerId: 'RB3', price: 1, slot: 'FLEX', position: 'RB' })
    expect(firstOpenSlotFor(t1, 'RB', cfg)).toBe('BENCH')
    expect(firstOpenSlotFor(t1, 'QB', cfg)).toBe('QB')
  })

  it('returns null when no slot fits', () => {
    const cfg2 = testConfig({ rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }] })
    const s = initialState(cfg2)
    expect(firstOpenSlotFor(s.teams['T1']!, 'RB', cfg2)).toBeNull()
  })
})
