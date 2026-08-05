import type { DraftEvent } from '@auction/engine'
import { SeqConflictError, type EventStore } from '../../src/store.js'

/** In-memory EventStore for unit tests. Mirrors PgEventStore's seq contract:
 *  append is all-or-nothing and rejects a stale expectedSeq. */
export class MemEventStore implements EventStore {
  private streams = new Map<string, DraftEvent[]>()

  async append(leagueId: string, expectedSeq: number, events: DraftEvent[]): Promise<number> {
    const stream = this.streams.get(leagueId) ?? []
    if (expectedSeq !== stream.length) throw new SeqConflictError(leagueId, expectedSeq + 1)
    const next = [...stream, ...events]
    this.streams.set(leagueId, next)
    return next.length
  }

  async load(leagueId: string): Promise<{ seq: number; events: DraftEvent[] }> {
    const events = [...(this.streams.get(leagueId) ?? [])]
    return { seq: events.length, events }
  }
}
