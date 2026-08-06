import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { rosterCapacity } from '@auction/engine'
import type { LeagueConfig, PlayerInfo } from '@auction/engine'

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const
const clock = z.number().int().min(1_000).max(600_000)

export const StoredConfigSchema = z
  .object({
    teams: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).min(2).max(20),
    budget: z.number().int().positive().max(10_000),
    rosterTemplate: z
      .array(z.object({ name: z.string().min(1), eligible: z.array(z.enum(POSITIONS)).min(1), count: z.number().int().min(1) }))
      .min(1),
    bidClockMs: clock,
    nominationClockMs: clock,
    nominationOrder: z.array(z.string()),
    nominationExpiryPolicy: z.enum(['auto_nominate', 'skip']),
  })
  .superRefine((cfg, ctx) => {
    const ids = cfg.teams.map(t => t.id)
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate team ids' })
    const order = [...cfg.nominationOrder].sort()
    if (JSON.stringify(order) !== JSON.stringify([...ids].sort()))
      ctx.addIssue({ code: 'custom', message: 'nominationOrder must be a permutation of team ids' })
    // Per team, not league-wide: each team spends its own budget and must be able to
    // fill every roster slot at $1, which is exactly the engine's max-bid invariant.
    if (cfg.budget < rosterCapacity(cfg.rosterTemplate))
      ctx.addIssue({ code: 'custom', message: `budget must be at least roster capacity (${rosterCapacity(cfg.rosterTemplate)})` })
  })
export type StoredConfig = z.infer<typeof StoredConfigSchema>

export type Principal =
  | { leagueId: string; role: 'commissioner' }
  | { leagueId: string; role: 'board' }
  | { leagueId: string; role: 'manager'; teamId: string }

export interface CreatedLeague {
  id: string
  links: { commissioner: string; board: string; teams: { teamId: string; name: string; url: string }[] }
}

export interface LeagueRecord {
  id: string
  name: string
  config: StoredConfig & { players?: PlayerInfo[] }
  frozenAt: Date | null
}

const token = () => randomBytes(16).toString('base64url')

export class LeagueService {
  constructor(private pool: Pool, private baseUrl: string) {}

  private link(leagueId: string, t: string): string {
    return `${this.baseUrl}/draft/${leagueId}#${t}`
  }

  async create(name: string, rawConfig: unknown): Promise<CreatedLeague> {
    const config = StoredConfigSchema.parse(rawConfig)
    const leagueName = z.string().min(1).max(200).parse(name)
    const id = randomBytes(9).toString('base64url')
    const commissionerToken = token()
    const boardToken = token()
    const teams: CreatedLeague['links']['teams'] = []
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'INSERT INTO leagues (id, name, config, commissioner_token, board_token) VALUES ($1, $2, $3, $4, $5)',
        [id, leagueName, JSON.stringify(config), commissionerToken, boardToken],
      )
      for (const t of config.teams) {
        const inviteToken = token()
        await client.query('INSERT INTO teams (league_id, team_id, invite_token) VALUES ($1, $2, $3)', [id, t.id, inviteToken])
        teams.push({ teamId: t.id, name: t.name, url: this.link(id, inviteToken) })
      }
      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        client.release(true)
        throw err
      }
      client.release()
      throw err
    }
    client.release()
    return { id, links: { commissioner: this.link(id, commissionerToken), board: this.link(id, boardToken), teams } }
  }

  async get(id: string): Promise<LeagueRecord | null> {
    const r = await this.pool.query('SELECT id, name, config, frozen_at FROM leagues WHERE id = $1', [id])
    if (!r.rows.length) return null
    const row = r.rows[0]
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config
    return { id: row.id, name: row.name, config, frozenAt: row.frozen_at ?? null }
  }

  async resolveToken(t: string): Promise<Principal | null> {
    const league = await this.pool.query(
      'SELECT id, commissioner_token FROM leagues WHERE commissioner_token = $1 OR board_token = $1',
      [t],
    )
    if (league.rows.length === 1) {
      const row = league.rows[0]
      return { leagueId: row.id, role: row.commissioner_token === t ? 'commissioner' : 'board' }
    }
    if (league.rows.length > 1) return null // ambiguous: fail closed, never guess the higher privilege
    const team = await this.pool.query('SELECT league_id, team_id FROM teams WHERE invite_token = $1', [t])
    if (team.rows.length) return { leagueId: team.rows[0].league_id, role: 'manager', teamId: team.rows[0].team_id }
    return null
  }

  /** Snapshot the player pool into the config exactly once; later calls return the stored config. */
  async freeze(id: string, players: PlayerInfo[]): Promise<LeagueConfig> {
    const rec = await this.get(id)
    if (!rec) throw new Error(`no league ${id}`)
    if (rec.frozenAt) return rec.config as LeagueConfig
    validatePool(players)
    const frozen = { ...rec.config, players }
    // The frozen_at IS NULL predicate makes "exactly once" atomic: a concurrent
    // caller updates zero rows and reads back the pool that actually won.
    const r = await this.pool.query(
      'UPDATE leagues SET config = $1, frozen_at = now() WHERE id = $2 AND frozen_at IS NULL',
      [JSON.stringify(frozen), id],
    )
    // Anything other than exactly one updated row means we did not win the race
    // (pg types rowCount as nullable); read back whichever pool actually landed.
    if (r.rowCount !== 1) {
      const stored = await this.get(id)
      if (!stored) throw new Error(`no league ${id}`)
      return stored.config as LeagueConfig
    }
    return frozen as LeagueConfig
  }

  async frozenConfig(id: string): Promise<LeagueConfig | null> {
    const rec = await this.get(id)
    if (!rec || !rec.frozenAt) return null
    return rec.config as LeagueConfig
  }
}

const PlayerInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.enum(POSITIONS),
  nflTeam: z.string().min(1),
  rank: z.number().finite(), // engine treats rank as "lower = better"; ADP values may be fractional
})

/** The player pool is the one part of LeagueConfig that reaches the engine unvalidated. */
function validatePool(players: PlayerInfo[]): void {
  const parsed = z.array(PlayerInfoSchema).min(1).parse(players)
  const ids = parsed.map(p => p.id)
  if (new Set(ids).size !== ids.length) throw new Error('player pool has duplicate ids')
}
