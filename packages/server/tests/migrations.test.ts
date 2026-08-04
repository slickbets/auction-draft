import { describe, it, expect } from 'vitest'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { loadEnv } from '../src/env.js'

describe('migrations', () => {
  it('applies all migrations once and is idempotent', async () => {
    const pool = newTestPool()
    const first = await migrate(pool)
    expect(first.length).toBeGreaterThan(0)
    const second = await migrate(pool)
    expect(second).toEqual([])
    const r = await pool.query(
      `INSERT INTO leagues (id, name, config, commissioner_token, board_token)
       VALUES ('l1', 'Test', '{}', 'ct', 'bt') RETURNING id`,
    )
    expect(r.rows[0].id).toBe('l1')
    for (const table of ['teams', 'draft_events', 'players']) {
      const q = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
      expect(q.rows[0].n).toBe(0)
    }
  })
})

describe('env', () => {
  it('parses with defaults and rejects missing DATABASE_URL', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://x', BASE_URL: 'http://localhost:3000', CREATE_KEY: 'k' })
    expect(env.PORT).toBe(3000)
    expect(env.SLEEPER_SYNC).toBe('0')
    expect(() => loadEnv({ BASE_URL: 'http://x', CREATE_KEY: 'k' })).toThrow()
  })
})
