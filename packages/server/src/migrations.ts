import type { Pool } from 'pg'

export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE leagues (
        id text PRIMARY KEY,
        name text NOT NULL,
        config jsonb NOT NULL,
        frozen_at timestamptz,
        commissioner_token text NOT NULL UNIQUE,
        board_token text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE teams (
        league_id text NOT NULL REFERENCES leagues(id),
        team_id text NOT NULL,
        invite_token text NOT NULL UNIQUE,
        claimed_at timestamptz,
        PRIMARY KEY (league_id, team_id)
      );
      CREATE TABLE draft_events (
        league_id text NOT NULL REFERENCES leagues(id),
        seq integer NOT NULL,
        type text NOT NULL,
        payload jsonb NOT NULL,
        at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (league_id, seq)
      );
      CREATE TABLE players (
        sleeper_id text PRIMARY KEY,
        name text NOT NULL,
        position text NOT NULL,
        nfl_team text NOT NULL,
        status text NOT NULL,
        search_rank integer NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
]

export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text)`)
  const done = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r: { name: string }) => r.name),
  )
  const applied: string[] = []
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue
    await pool.query(m.sql)
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name])
    applied.push(m.name)
  }
  return applied
}
