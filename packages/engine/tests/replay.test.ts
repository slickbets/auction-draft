import { describe, it, expect } from 'vitest'
import { initialState, run, replay, type DraftEvent } from '../src/index.js'
import { testConfig } from './fixtures.js'

describe('replay', () => {
  it('rebuilds identical state from the event log', () => {
    const cfg = testConfig()
    let s = initialState(cfg)
    const log: DraftEvent[] = []
    const step = (cmd: Parameters<typeof run>[1]) => {
      const r = run(s, cmd)
      if (!r.ok) throw new Error(r.error.code)
      log.push(...r.events)
      s = r.state
    }
    step({ type: 'START_DRAFT', now: 1000 })
    step({ type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now: 2000 })
    step({ type: 'BID', teamId: 'T5', amount: 42, now: 4000 })
    step({ type: 'CLOCK_EXPIRED', now: 14_000 })
    step({ type: 'UNDO_SALE', now: 20_000 })
    step({ type: 'NOMINATE', teamId: 'T1', playerId: 'WR1', openingBid: 2, now: 25_000 })
    expect(replay(cfg, log)).toStrictEqual(s)
  })
})
