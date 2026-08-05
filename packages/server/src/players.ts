import type { Pool } from 'pg'
import type { PlayerInfo, Position } from '@auction/engine'

export interface SleeperPlayer {
  full_name?: string
  position?: string | null
  team?: string | null
  status?: string | null
  search_rank?: number | null
}
export type SleeperPlayerMap = Record<string, SleeperPlayer>

export interface PlayerRow {
  sleeperId: string
  name: string
  position: Position
  nflTeam: string
  status: string
  searchRank: number
}

const POSITION_MAP: Record<string, Position> = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'DST' }
const UNRANKED = 9_999_999

export function toPlayerRows(map: SleeperPlayerMap): PlayerRow[] {
  const rows: PlayerRow[] = []
  for (const [sleeperId, p] of Object.entries(map)) {
    const position = POSITION_MAP[p.position ?? '']
    if (!position || !p.full_name) continue
    rows.push({
      sleeperId,
      name: p.full_name,
      position,
      nflTeam: p.team ?? 'FA',
      status: p.status ?? 'Unknown',
      searchRank: p.search_rank ?? UNRANKED,
    })
  }
  return rows
}

export async function fetchSleeperPlayers(fetchFn: typeof fetch = fetch): Promise<SleeperPlayerMap> {
  const res = await fetchFn('https://api.sleeper.app/v1/players/nfl')
  if (!res.ok) throw new Error(`sleeper fetch failed: ${res.status}`)
  return (await res.json()) as SleeperPlayerMap
}

export class PlayerRepo {
  constructor(private pool: Pool) {}

  async upsertAll(rows: PlayerRow[]): Promise<number> {
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO players (sleeper_id, name, position, nfl_team, status, search_rank, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (sleeper_id) DO UPDATE
         SET name = $2, position = $3, nfl_team = $4, status = $5, search_rank = $6, updated_at = now()`,
        [r.sleeperId, r.name, r.position, r.nflTeam, r.status, r.searchRank],
      )
    }
    return rows.length
  }

  async listForDraft(): Promise<PlayerInfo[]> {
    const r = await this.pool.query('SELECT sleeper_id, name, position, nfl_team, search_rank FROM players ORDER BY search_rank ASC, sleeper_id ASC')
    return r.rows.map((row: { sleeper_id: string; name: string; position: Position; nfl_team: string; search_rank: number }) => ({
      id: row.sleeper_id,
      name: row.name,
      position: row.position,
      nflTeam: row.nfl_team,
      rank: Number(row.search_rank),
    }))
  }
}
