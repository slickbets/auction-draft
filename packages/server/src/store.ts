import type { Pool } from 'pg'
import type { DraftEvent } from '@auction/engine'

export class SeqConflictError extends Error {
  constructor(leagueId: string, seq: number) {
    super(`seq conflict for league ${leagueId} at ${seq}`)
    this.name = 'SeqConflictError'
  }
}

export interface EventStore {
  append(leagueId: string, expectedSeq: number, events: DraftEvent[]): Promise<number>
  load(leagueId: string): Promise<{ seq: number; events: DraftEvent[] }>
}

export class PgEventStore implements EventStore {
  constructor(private pool: Pool) {}

  async append(leagueId: string, expectedSeq: number, events: DraftEvent[]): Promise<number> {
    const client = await this.pool.connect()
    let release = () => client.release()
    let seq = expectedSeq
    try {
      await client.query('BEGIN')
      for (const e of events) {
        seq += 1
        await client.query(
          'INSERT INTO draft_events (league_id, seq, type, payload) VALUES ($1, $2, $3, $4)',
          [leagueId, seq, e.type, JSON.stringify(e)],
        )
      }
      await client.query('COMMIT')
      return seq
    } catch (err) {
      let rollbackFailed = false
      try {
        await client.query('ROLLBACK')
      } catch {
        // The connection may be stuck in an aborted transaction; discard it below
        // rather than returning it to the pool for the next caller to trip over.
        rollbackFailed = true
      }
      release = rollbackFailed ? () => client.release(true) : () => client.release()
      if (isUniqueViolation(err)) throw new SeqConflictError(leagueId, seq)
      throw err
    } finally {
      release()
    }
  }

  async load(leagueId: string): Promise<{ seq: number; events: DraftEvent[] }> {
    const r = await this.pool.query(
      'SELECT seq, payload FROM draft_events WHERE league_id = $1 ORDER BY seq',
      [leagueId],
    )
    const events = r.rows.map((row: { payload: DraftEvent | string }) =>
      typeof row.payload === 'string' ? (JSON.parse(row.payload) as DraftEvent) : row.payload,
    )
    const seq = r.rows.length ? Number(r.rows[r.rows.length - 1].seq) : 0
    return { seq, events }
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return e?.code === '23505' || /duplicate key value violates unique constraint|unique constraint|duplicate key/i.test(e?.message ?? '')
}
