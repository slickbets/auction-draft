import { describe, it, expect, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { PgEventStore, SeqConflictError } from '../src/store.js'
import type { DraftEvent } from '@auction/engine'

const ev = (at: number): DraftEvent => ({ type: 'DRAFT_STARTED', at })

describe('PgEventStore', () => {
  let pool: Pool
  let store: PgEventStore
  beforeEach(async () => {
    pool = newTestPool()
    await migrate(pool)
    await pool.query(`INSERT INTO leagues (id, name, config, commissioner_token, board_token) VALUES ('l1','T','{}','ct','bt')`)
    store = new PgEventStore(pool)
  })

  it('appends with sequential seqs and loads in order', async () => {
    const s1 = await store.append('l1', 0, [ev(1), ev(2)])
    expect(s1).toBe(2)
    const s2 = await store.append('l1', 2, [ev(3)])
    expect(s2).toBe(3)
    const { seq, events } = await store.load('l1')
    expect(seq).toBe(3)
    expect(events.map(e => e.at)).toEqual([1, 2, 3])
  })

  it('throws SeqConflictError on a stale expectedSeq and persists nothing', async () => {
    await store.append('l1', 0, [ev(1)])
    await expect(store.append('l1', 0, [ev(9), ev(10)])).rejects.toBeInstanceOf(SeqConflictError)
    const { seq, events } = await store.load('l1')
    expect(seq).toBe(1)
    expect(events).toHaveLength(1)
  })

  it('loads empty stream as seq 0', async () => {
    const { seq, events } = await store.load('l1')
    expect(seq).toBe(0)
    expect(events).toEqual([])
  })

  it('surfaces the original error and discards the client when rollback fails', async () => {
    const realConnect = pool.connect.bind(pool)
    const client: any = await realConnect()
    const released: unknown[] = []
    client.release = (arg?: unknown) => released.push(arg)
    const origQuery = client.query.bind(client)
    client.query = async (sql: string, params?: unknown[]) => {
      if (sql === 'ROLLBACK') throw new Error('connection terminated')
      return origQuery(sql, params)
    }
    const failing = new PgEventStore({ connect: async () => client } as unknown as Pool)
    await failing.append('l1', 0, [ev(1)])
    // Same seq again -> unique violation -> ROLLBACK throws -> original error must survive
    await expect(failing.append('l1', 0, [ev(2)])).rejects.toBeInstanceOf(SeqConflictError)
    expect(released[released.length - 1]).toBe(true) // client discarded, not recycled
  })
})
