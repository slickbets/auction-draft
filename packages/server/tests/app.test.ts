import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'

describe('app', () => {
  it('serves healthz', async () => {
    const app = createApp({})
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
