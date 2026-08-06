import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { createApp } from '../src/app.js'
import { LeagueService } from '../src/league.js'
import { PlayerRepo } from '../src/players.js'

const TEMPLATE = [{ name: 'QB', eligible: ['QB'], count: 1 }]
const teams = Array.from({ length: 2 }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
const CONFIG = {
  teams,
  budget: 200,
  rosterTemplate: TEMPLATE,
  bidClockMs: 10_000,
  nominationClockMs: 30_000,
  nominationOrder: ['T1', 'T2'],
  nominationExpiryPolicy: 'auto_nominate',
}

describe('http api', () => {
  let app: ReturnType<typeof createApp>
  let leagues: LeagueService
  let synced: number

  beforeEach(async () => {
    const pool = newTestPool()
    await migrate(pool)
    leagues = new LeagueService(pool, 'http://localhost:3000')
    synced = 0
    app = createApp({
      leagues,
      players: { repo: new PlayerRepo(pool), sync: async () => { synced += 1; return 42 } },
      createKey: 'sekret',
    })
  })

  it('creates a league with the create key, rejects without', async () => {
    const denied = await request(app).post('/api/leagues').send({ name: 'L', config: CONFIG })
    expect(denied.status).toBe(403)
    const res = await request(app).post('/api/leagues').set('x-create-key', 'sekret').send({ name: 'L', config: CONFIG })
    expect(res.status).toBe(201)
    expect(res.body.links.teams).toHaveLength(2)
    // A superRefine failure (not just a primitive one) must still surface as 400.
    const bad = await request(app).post('/api/leagues').set('x-create-key', 'sekret').send({ name: 'L', config: { ...CONFIG, nominationOrder: ['T1'] } })
    expect(bad.status).toBe(400)
  })

  it('refresh-players requires the commissioner token of that league', async () => {
    const created = await leagues.create('L', CONFIG)
    const token = created.links.commissioner.split('#')[1]!
    const denied = await request(app).post(`/api/leagues/${created.id}/refresh-players`)
    expect(denied.status).toBe(403)
    const ok = await request(app).post(`/api/leagues/${created.id}/refresh-players`).set('authorization', `Bearer ${token}`)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ updated: 42 })
    expect(synced).toBe(1)
  })

  it('returns 500 instead of crashing when league creation fails', async () => {
    const boom = createApp({
      leagues: { create: async () => { throw new Error('postgres is down') }, resolveToken: async () => null } as any,
      players: { repo: {} as any, sync: async () => 0 },
      createKey: 'sekret',
    })
    const res = await request(boom).post('/api/leagues').set('x-create-key', 'sekret').send({ name: 'L', config: CONFIG })
    expect(res.status).toBe(500)
  })

  it('returns 500 instead of crashing when the player sync fails', async () => {
    const created = await leagues.create('L', CONFIG)
    const token = created.links.commissioner.split('#')[1]!
    const boom = createApp({
      leagues,
      players: { repo: {} as any, sync: async () => { throw new Error('sleeper 503') } },
      createKey: 'sekret',
    })
    const res = await request(boom).post(`/api/leagues/${created.id}/refresh-players`).set('authorization', `Bearer ${token}`)
    expect(res.status).toBe(500)
  })
})
