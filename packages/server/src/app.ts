import express from 'express'
import { ZodError } from 'zod'
import type { LeagueService } from './league.js'
import type { PlayerRepo } from './players.js'

export interface AppDeps {
  leagues?: LeagueService
  players?: { repo: PlayerRepo; sync: () => Promise<number> }
  createKey?: string
  webDist?: string
}

export function createApp(deps: AppDeps): express.Express {
  const app = express()
  app.use(express.json())

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  app.post('/api/leagues', async (req, res) => {
    if (!deps.leagues || !deps.createKey) return res.status(503).json({ error: 'not configured' })
    if (req.header('x-create-key') !== deps.createKey) return res.status(403).json({ error: 'forbidden' })
    try {
      const { name, config } = req.body ?? {}
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' })
      const created = await deps.leagues.create(name.trim(), config)
      return res.status(201).json(created)
    } catch (err) {
      if (err instanceof ZodError) return res.status(400).json({ error: 'invalid config', issues: err.issues })
      console.error('POST /api/leagues failed', err)
      return res.status(500).json({ error: 'internal' })
    }
  })

  app.post('/api/leagues/:id/refresh-players', async (req, res) => {
    if (!deps.leagues || !deps.players) return res.status(503).json({ error: 'not configured' })
    try {
      const auth = req.header('authorization') ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const principal = token ? await deps.leagues.resolveToken(token) : null
      if (!principal || principal.role !== 'commissioner' || principal.leagueId !== req.params.id) {
        return res.status(403).json({ error: 'forbidden' })
      }
      const updated = await deps.players.sync()
      return res.json({ updated })
    } catch (err) {
      console.error('POST /api/leagues/:id/refresh-players failed', err)
      return res.status(500).json({ error: 'internal' })
    }
  })

  if (deps.webDist) {
    app.use(express.static(deps.webDist))
    app.get('/draft/*', (_req, res) => {
      res.sendFile('index.html', { root: deps.webDist! })
    })
  }

  return app
}
