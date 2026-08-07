import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { createApp } from '../src/app.js'

describe('SPA serving', () => {
  let dist: string
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'web-dist-'))
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Draft Room</title>')
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
  })
  afterEach(() => rmSync(dist, { recursive: true, force: true }))

  it('serves the app shell for an invite link so the token in the fragment survives', async () => {
    const app = createApp({ webDist: dist })
    const res = await request(app).get('/draft/abc123')
    expect(res.status).toBe(200)
    expect(res.text).toContain('Draft Room')
  })

  it('serves built assets and still answers healthz', async () => {
    const app = createApp({ webDist: dist })
    expect((await request(app).get('/assets/app.js')).status).toBe(200)
    expect((await request(app).get('/healthz')).body).toEqual({ ok: true })
  })

  it('does not swallow unknown api routes with the SPA fallback', async () => {
    const app = createApp({ webDist: dist })
    expect((await request(app).get('/api/nope')).status).toBe(404)
  })

  it('works with no webDist configured (server-only deploys)', async () => {
    const app = createApp({})
    expect((await request(app).get('/draft/abc123')).status).toBe(404)
  })
})
