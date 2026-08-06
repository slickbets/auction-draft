import { newDb } from 'pg-mem'
import type { Pool } from 'pg'

/** Fresh in-memory Postgres per call; returned Pool is pg-API-compatible. */
export function newTestPool(): Pool {
  const db = newDb()
  const { Pool: MemPool } = db.adapters.createPg()
  return new MemPool() as unknown as Pool
}
