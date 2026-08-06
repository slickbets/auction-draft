import { describe, it, expect } from 'vitest'
import { newTestPool } from './helpers/testDb.js'
import { buildServer } from '../src/main.js'

describe('buildServer', () => {
  it('boots, serves healthz over a real port, and closes cleanly', async () => {
    const pool = newTestPool()
    const env = { DATABASE_URL: 'unused', PORT: 0, BASE_URL: 'http://localhost', CREATE_KEY: 'k', SLEEPER_SYNC: '0' as const }
    const server = await buildServer(env, pool)
    await new Promise<void>(r => server.http.listen(0, r))
    const port = (server.http.address() as { port: number }).port
    const res = await fetch(`http://localhost:${port}/healthz`)
    expect(await res.json()).toEqual({ ok: true })
    await server.close()
  })
})
