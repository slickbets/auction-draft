import { describe, it, expect } from 'vitest'
import { initialState, run } from '../src/index.js'
import { testConfig } from './fixtures.js'

describe('START_DRAFT', () => {
  it('moves lobby -> awaiting_nomination for first team in order, with deadline', () => {
    const s0 = initialState(testConfig())
    const r = run(s0, { type: 'START_DRAFT', now: 1000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['DRAFT_STARTED', 'NOMINATION_STARTED'])
    expect(r.state.phase).toEqual({ type: 'awaiting_nomination', teamId: 'T1', deadline: 1000 + 30_000 })
    expect(r.state.seq).toBe(2)
  })

  it('rejects when not in lobby', () => {
    const s0 = initialState(testConfig())
    const r1 = run(s0, { type: 'START_DRAFT', now: 1000 })
    if (!r1.ok) throw new Error('setup')
    const r2 = run(r1.state, { type: 'START_DRAFT', now: 2000 })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.code).toBe('NOT_IN_LOBBY')
  })
})
