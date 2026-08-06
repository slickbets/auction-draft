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
    if (!position || !p.full_name || !sleeperId) continue
    // `||` not `??` throughout: Sleeper sends empty strings as well as nulls, and
    // freeze() rejects a pool containing an empty name/team, which would block the
    // draft from starting. Likewise a non-finite rank must not reach an int column.
    rows.push({
      sleeperId,
      name: p.full_name,
      position,
      nflTeam: p.team || 'FA',
      status: p.status || 'Unknown',
      searchRank: Number.isFinite(p.search_rank) ? (p.search_rank as number) : UNRANKED,
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

  /** Sleeper ships ~11k players; one round trip per row would make the
   *  commissioner's draft-morning refresh take minutes, so upsert in chunks. */
  async upsertAll(rows: PlayerRow[], chunkSize = 250): Promise<number> {
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize)
      const values: unknown[] = []
      const tuples = chunk.map((r, j) => {
        const b = j * 6
        values.push(r.sleeperId, r.name, r.position, r.nflTeam, r.status, r.searchRank)
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, now())`
      })
      await this.pool.query(
        `INSERT INTO players (sleeper_id, name, position, nfl_team, status, search_rank, updated_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (sleeper_id) DO UPDATE
         SET name = EXCLUDED.name, position = EXCLUDED.position, nfl_team = EXCLUDED.nfl_team,
             status = EXCLUDED.status, search_rank = EXCLUDED.search_rank, updated_at = now()`,
        values,
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
