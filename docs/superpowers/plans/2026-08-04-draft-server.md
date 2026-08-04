# Draft Server Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host the Plan 1 auction engine behind Socket.IO with a Postgres event log, invite-link auth, Sleeper player sync, crash recovery, and a 10-bot full-draft integration test — deployable to Railway.

**Architecture:** One stateful Node process. Each league gets an in-memory `Room` that owns the authoritative `DraftState`, serializes commands through a promise queue, stamps `now`, runs the engine, persists emitted events to `draft_events` (append-only, per-league seq), applies them, broadcasts to the league's socket room, and re-arms a `setTimeout` from the state's deadline. Recovery = replay events through the engine's `replay()` and boot-pause. HTTP (Express) handles league creation and player refresh; Socket.IO handles everything live.

**Tech Stack:** Node 22, TypeScript 5 strict ESM, Express 4, Socket.IO 4, `pg`, Zod, node-cron, tsx (runtime), Vitest + pg-mem + socket.io-client (tests).

**Prereqs:** Plan 1 merged (`@auction/engine` at `packages/engine`, 48 tests green). Spec: `docs/superpowers/specs/2026-08-04-auction-draft-tool-design.md` (§4 architecture/auth, §8 player data, §10 resilience, §11 testing). Honors every item in Plan 1's "Plan 2/3 backlog" (see plan `2026-08-04-auction-engine.md`).

## Global Constraints

- Node 22.x, TypeScript 5.x `"strict": true`, ESM. Monorepo: this plan only creates `packages/server`.
- **The engine is consumed as-is.** No file in `packages/engine` may be modified by this plan. The engine stays authorization-blind: WHO may send a command is decided entirely in the socket gateway.
- **The server stamps time.** Wire commands never carry `now`; `Room.dispatch` injects it from an injectable `clock: () => number` (default `Date.now`). Nothing else calls `Date.now()` outside `main.ts` wiring.
- **Every wire input is Zod-validated at the boundary** (backlog item): commands (with bounds: bids/prices integer 1..10_000; `ADD_TIME.ms` integer 1_000..600_000; `SET_TIMERS` clocks integer 1_000..600_000; `ADJUST_BUDGET.delta` integer −1_000..1_000, ≠ 0) and league configs (2..20 teams, unique ids, `budget ≥ rosterCapacity(template)`, `nominationOrder` a permutation of team ids, non-empty slots with non-empty eligibility). Clock floor is 1_000ms — real leagues use 10s+, but accelerated simulation leagues are legitimate configs.
- **Frozen-config invariant:** `draft_events` non-empty ⇒ `leagues.frozen_at` set and `leagues.config` contains the player pool. The player pool is snapshotted into the league config at draft start; replay always uses the stored (frozen) config.
- Tokens: `crypto.randomBytes(16).toString('base64url')`. Secrets/config via env only; `.env` is git-ignored.
- **Tests never touch the network.** Sleeper responses come from fixtures; Postgres is `pg-mem` in tests. `npm test` from repo root passes at the end of every task (engine's 48 tests included).
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Server package scaffold + health endpoint

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/app.ts`
- Modify: `package.json` (root — add deps via npm install)
- Test: `packages/server/tests/app.test.ts`

**Interfaces:**
- Produces: `createApp(deps: AppDeps): express.Express` where `AppDeps` starts empty and grows in Tasks 4/5/8; `GET /healthz` → `200 {"ok":true}`.

- [ ] **Step 1: Package config**

`packages/server/package.json`:
```json
{
  "name": "@auction/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@auction/engine": "*",
    "express": "^4.19.0",
    "socket.io": "^4.7.0",
    "pg": "^8.12.0",
    "zod": "^3.23.0",
    "node-cron": "^3.0.0"
  }
}
```

`packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

- [ ] **Step 2: Install dependencies (root)**

Run from repo root:
```bash
npm install
npm install -D @types/express @types/pg @types/node-cron @types/node tsx pg-mem socket.io-client supertest @types/supertest
```

- [ ] **Step 3: Failing test**

`packages/server/tests/app.test.ts`:
```ts
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
```

Run: `npx vitest run packages/server` → FAIL (`createApp` missing).

- [ ] **Step 4: Implement**

`packages/server/src/app.ts`:
```ts
import express from 'express'

export interface AppDeps {}

export function createApp(_deps: AppDeps): express.Express {
  const app = express()
  app.use(express.json())
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })
  return app
}
```

- [ ] **Step 5: Verify + commit**

Run: `npm test && npm run typecheck` → all green (engine's 48 + 1 new).

```bash
git add -A
git commit -m "feat(server): scaffold package with health endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Env config, migrations runner, schema

**Files:**
- Create: `packages/server/src/env.ts`, `packages/server/src/db.ts`, `packages/server/src/migrations.ts`
- Test: `packages/server/tests/helpers/testDb.ts`, `packages/server/tests/migrations.test.ts`

**Interfaces:**
- Produces: `loadEnv(source?): Env` (`DATABASE_URL`, `PORT` default 3000, `BASE_URL`, `CREATE_KEY`, `SLEEPER_SYNC` default "0"); `createPool(databaseUrl): Pool`; `MIGRATIONS` array + `migrate(pool): Promise<string[]>` (idempotent, tracked in `schema_migrations`); test helper `newTestPool(): Pool` (pg-mem-backed, used by every DB test in later tasks).

- [ ] **Step 1: Failing test**

`packages/server/tests/helpers/testDb.ts`:
```ts
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'

/** Fresh in-memory Postgres per call; returned Pool is pg-API-compatible. */
export function newTestPool(): Pool {
  const db = newDb()
  const { Pool: MemPool } = db.adapters.createPg()
  return new MemPool() as unknown as Pool
}
```

`packages/server/tests/migrations.test.ts`:
```ts
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
```

Run: `npx vitest run packages/server/tests/migrations.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`packages/server/src/env.ts`:
```ts
import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  BASE_URL: z.string().url(),
  CREATE_KEY: z.string().min(1),
  SLEEPER_SYNC: z.enum(['0', '1']).default('0'),
})
export type Env = z.infer<typeof EnvSchema>

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source)
}
```

`packages/server/src/db.ts`:
```ts
import pg from 'pg'

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl })
}
```

`packages/server/src/migrations.ts`:
```ts
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
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
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
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(server): env config, migration runner, initial schema

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Postgres event store

**Files:**
- Create: `packages/server/src/store.ts`
- Test: `packages/server/tests/store.test.ts`

**Interfaces:**
- Produces (Room in Task 6 depends on these exact signatures):
  - `interface EventStore { append(leagueId: string, expectedSeq: number, events: DraftEvent[]): Promise<number>; load(leagueId: string): Promise<{ seq: number; events: DraftEvent[] }> }`
  - `class PgEventStore implements EventStore` — `append` inserts inside a transaction with seqs `expectedSeq+1..`, returns the new last seq; a duplicate seq (concurrent writer) rolls back and throws `SeqConflictError`. `load` returns events ordered by seq.
  - `class SeqConflictError extends Error`

- [ ] **Step 1: Failing test**

`packages/server/tests/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { PgEventStore, SeqConflictError } from '../src/store.js'
import type { DraftEvent } from '@auction/engine'

const ev = (at: number): DraftEvent => ({ type: 'DRAFT_STARTED', at })

describe('PgEventStore', () => {
  let pool: Pool
  let store: PgEventStore
  beforeEach(async () => {
    pool = newTestPool()
    await migrate(pool)
    await pool.query(`INSERT INTO leagues (id, name, config, commissioner_token, board_token) VALUES ('l1','T','{}','ct','bt')`)
    store = new PgEventStore(pool)
  })

  it('appends with sequential seqs and loads in order', async () => {
    const s1 = await store.append('l1', 0, [ev(1), ev(2)])
    expect(s1).toBe(2)
    const s2 = await store.append('l1', 2, [ev(3)])
    expect(s2).toBe(3)
    const { seq, events } = await store.load('l1')
    expect(seq).toBe(3)
    expect(events.map(e => e.at)).toEqual([1, 2, 3])
  })

  it('throws SeqConflictError on a stale expectedSeq and persists nothing', async () => {
    await store.append('l1', 0, [ev(1)])
    await expect(store.append('l1', 0, [ev(9), ev(10)])).rejects.toBeInstanceOf(SeqConflictError)
    const { seq, events } = await store.load('l1')
    expect(seq).toBe(1)
    expect(events).toHaveLength(1)
  })

  it('loads empty stream as seq 0', async () => {
    const { seq, events } = await store.load('l1')
    expect(seq).toBe(0)
    expect(events).toEqual([])
  })
})
```

Run: `npx vitest run packages/server/tests/store.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`packages/server/src/store.ts`:
```ts
import type { Pool } from 'pg'
import type { DraftEvent } from '@auction/engine'

export class SeqConflictError extends Error {
  constructor(leagueId: string, seq: number) {
    super(`seq conflict for league ${leagueId} at ${seq}`)
  }
}

export interface EventStore {
  append(leagueId: string, expectedSeq: number, events: DraftEvent[]): Promise<number>
  load(leagueId: string): Promise<{ seq: number; events: DraftEvent[] }>
}

export class PgEventStore implements EventStore {
  constructor(private pool: Pool) {}

  async append(leagueId: string, expectedSeq: number, events: DraftEvent[]): Promise<number> {
    const client = await this.pool.connect()
    let seq = expectedSeq
    try {
      await client.query('BEGIN')
      for (const e of events) {
        seq += 1
        await client.query(
          'INSERT INTO draft_events (league_id, seq, type, payload) VALUES ($1, $2, $3, $4)',
          [leagueId, seq, e.type, JSON.stringify(e)],
        )
      }
      await client.query('COMMIT')
      return seq
    } catch (err) {
      await client.query('ROLLBACK')
      if (isUniqueViolation(err)) throw new SeqConflictError(leagueId, seq)
      throw err
    } finally {
      client.release()
    }
  }

  async load(leagueId: string): Promise<{ seq: number; events: DraftEvent[] }> {
    const r = await this.pool.query(
      'SELECT seq, payload FROM draft_events WHERE league_id = $1 ORDER BY seq',
      [leagueId],
    )
    const events = r.rows.map((row: { payload: DraftEvent | string }) =>
      typeof row.payload === 'string' ? (JSON.parse(row.payload) as DraftEvent) : row.payload,
    )
    const seq = r.rows.length ? Number(r.rows[r.rows.length - 1].seq) : 0
    return { seq, events }
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return e?.code === '23505' || /duplicate key|unique/i.test(e?.message ?? '')
}
```

(The message-regex fallback exists because pg-mem does not always set `code`; real Postgres uses `23505`.)

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(server): append-only event store with seq integrity

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: League service — validation, creation, tokens, freeze

**Files:**
- Create: `packages/server/src/league.ts`
- Test: `packages/server/tests/league.test.ts`

**Interfaces:**
- Produces (socket gateway + HTTP depend on these):
  - `StoredConfig` = engine `LeagueConfig` without `players` (Zod-validated: 2..20 teams, unique ids/names non-empty, integer `budget ≥ rosterCapacity(rosterTemplate)`, template slots non-empty with non-empty `eligible` from the engine `Position` set and integer `count ≥ 1`, `nominationOrder` a permutation of team ids, clocks integer 3_000..600_000, policy enum).
  - `class LeagueService { constructor(pool: Pool, baseUrl: string); create(name: string, config: unknown): Promise<CreatedLeague>; get(id: string): Promise<LeagueRecord | null>; resolveToken(token: string): Promise<Principal | null>; freeze(id: string, players: PlayerInfo[]): Promise<LeagueConfig>; frozenConfig(id: string): Promise<LeagueConfig | null> }`
  - `type Principal = { leagueId: string } & ({ role: 'commissioner' } | { role: 'board' } | { role: 'manager'; teamId: string })`
  - `CreatedLeague = { id: string; links: { commissioner: string; board: string; teams: { teamId: string; name: string; url: string }[] } }` — link shapes: `${baseUrl}/draft/${leagueId}#<token>` (Plan 3 reads the token from the URL fragment so it never hits server logs).
  - `freeze` is idempotent: first call stores `config.players` + `frozen_at`; later calls return the stored frozen config unchanged (draft-day roster changes cannot mutate a started draft).

- [ ] **Step 1: Failing test**

`packages/server/tests/league.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { LeagueService } from '../src/league.js'
import type { PlayerInfo } from '@auction/engine'

const TEMPLATE = [
  { name: 'QB', eligible: ['QB'], count: 1 },
  { name: 'BENCH', eligible: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], count: 2 },
]
const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
const goodConfig = () => ({
  teams: teams(10),
  budget: 200,
  rosterTemplate: TEMPLATE,
  bidClockMs: 10_000,
  nominationClockMs: 30_000,
  nominationOrder: teams(10).map(t => t.id),
  nominationExpiryPolicy: 'auto_nominate',
})
const POOL: PlayerInfo[] = [{ id: 'p1', name: 'QB One', position: 'QB', nflTeam: 'SF', rank: 1 }]

describe('LeagueService', () => {
  let pool: Pool
  let svc: LeagueService
  beforeEach(async () => {
    pool = newTestPool()
    await migrate(pool)
    svc = new LeagueService(pool, 'http://localhost:3000')
  })

  it('creates a league with per-team invite links and resolves every token', async () => {
    const created = await svc.create('My League', goodConfig())
    expect(created.links.teams).toHaveLength(10)
    expect(created.links.commissioner).toContain(`/draft/${created.id}#`)
    const commish = await svc.resolveToken(created.links.commissioner.split('#')[1]!)
    expect(commish).toEqual({ leagueId: created.id, role: 'commissioner' })
    const board = await svc.resolveToken(created.links.board.split('#')[1]!)
    expect(board).toEqual({ leagueId: created.id, role: 'board' })
    const t3 = created.links.teams.find(t => t.teamId === 'T3')!
    const mgr = await svc.resolveToken(t3.url.split('#')[1]!)
    expect(mgr).toEqual({ leagueId: created.id, role: 'manager', teamId: 'T3' })
    expect(await svc.resolveToken('nope')).toBeNull()
  })

  it('rejects invalid configs', async () => {
    await expect(svc.create('X', { ...goodConfig(), budget: 2 })).rejects.toThrow(/budget/i)
    await expect(svc.create('X', { ...goodConfig(), nominationOrder: ['T1'] })).rejects.toThrow(/order/i)
    const dup = goodConfig()
    dup.teams[1] = { id: 'T1', name: 'Dup' }
    await expect(svc.create('X', dup)).rejects.toThrow()
    await expect(svc.create('X', { ...goodConfig(), bidClockMs: 500 })).rejects.toThrow()
  })

  it('freeze snapshots players once and is idempotent', async () => {
    const created = await svc.create('My League', goodConfig())
    expect(await svc.frozenConfig(created.id)).toBeNull()
    const frozen = await svc.freeze(created.id, POOL)
    expect(frozen.players).toEqual(POOL)
    const again = await svc.freeze(created.id, [])
    expect(again.players).toEqual(POOL) // second freeze ignored
    expect((await svc.frozenConfig(created.id))!.players).toEqual(POOL)
  })
})
```

Run: `npx vitest run packages/server/tests/league.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`packages/server/src/league.ts`:
```ts
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
    budget: z.number().int().positive(),
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
    const id = randomBytes(6).toString('base64url')
    const commissionerToken = token()
    const boardToken = token()
    await this.pool.query(
      'INSERT INTO leagues (id, name, config, commissioner_token, board_token) VALUES ($1, $2, $3, $4, $5)',
      [id, name, JSON.stringify(config), commissionerToken, boardToken],
    )
    const teams: CreatedLeague['links']['teams'] = []
    for (const t of config.teams) {
      const inviteToken = token()
      await this.pool.query('INSERT INTO teams (league_id, team_id, invite_token) VALUES ($1, $2, $3)', [id, t.id, inviteToken])
      teams.push({ teamId: t.id, name: t.name, url: this.link(id, inviteToken) })
    }
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
    const league = await this.pool.query('SELECT id, commissioner_token, board_token FROM leagues WHERE commissioner_token = $1 OR board_token = $1', [t])
    if (league.rows.length) {
      const row = league.rows[0]
      return { leagueId: row.id, role: row.commissioner_token === t ? 'commissioner' : 'board' }
    }
    const team = await this.pool.query('SELECT league_id, team_id FROM teams WHERE invite_token = $1', [t])
    if (team.rows.length) return { leagueId: team.rows[0].league_id, role: 'manager', teamId: team.rows[0].team_id }
    return null
  }

  /** Snapshot the player pool into the config exactly once; later calls return the stored config. */
  async freeze(id: string, players: PlayerInfo[]): Promise<LeagueConfig> {
    const rec = await this.get(id)
    if (!rec) throw new Error(`no league ${id}`)
    if (rec.frozenAt) return rec.config as LeagueConfig
    const frozen = { ...rec.config, players }
    await this.pool.query('UPDATE leagues SET config = $1, frozen_at = now() WHERE id = $2', [JSON.stringify(frozen), id])
    return frozen as LeagueConfig
  }

  async frozenConfig(id: string): Promise<LeagueConfig | null> {
    const rec = await this.get(id)
    if (!rec || !rec.frozenAt) return null
    return rec.config as LeagueConfig
  }
}
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(server): league creation, capability tokens, config freeze

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Sleeper player sync

**Files:**
- Create: `packages/server/src/players.ts`
- Test: `packages/server/tests/players.test.ts`

**Interfaces:**
- Produces:
  - `type SleeperPlayerMap = Record<string, SleeperPlayer>` matching Sleeper's `GET https://api.sleeper.app/v1/players/nfl` shape (fields used: `full_name`, `position`, `team`, `status`, `search_rank`).
  - `toPlayerRows(map): PlayerRow[]` — keeps positions QB/RB/WR/TE/K/DEF only, maps Sleeper `DEF` → engine `DST`, defaults missing `team` to `'FA'`, missing/null `search_rank` to `9_999_999`, drops entries with no name.
  - `fetchSleeperPlayers(fetchFn?): Promise<SleeperPlayerMap>` — injectable fetch; never called in tests.
  - `class PlayerRepo { constructor(pool); upsertAll(rows): Promise<number>; listForDraft(): Promise<PlayerInfo[]> }` — `listForDraft` returns engine `PlayerInfo[]` ordered by rank ascending; `id` is the sleeper id.

- [ ] **Step 1: Failing test**

`packages/server/tests/players.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { toPlayerRows, PlayerRepo, type SleeperPlayerMap } from '../src/players.js'

const FIXTURE: SleeperPlayerMap = {
  '4046': { full_name: 'Patrick Mahomes', position: 'QB', team: 'KC', status: 'Active', search_rank: 20 },
  '9509': { full_name: 'Bijan Robinson', position: 'RB', team: 'ATL', status: 'Active', search_rank: 1 },
  'SF': { full_name: 'San Francisco 49ers', position: 'DEF', team: 'SF', status: 'Active', search_rank: 300 },
  '1234': { full_name: 'Practice Squad Guy', position: 'RB', team: null, status: 'Active', search_rank: null },
  '777': { full_name: 'Some Center', position: 'C', team: 'DAL', status: 'Active', search_rank: 500 },
  '888': { position: 'WR', team: 'NYJ', status: 'Active', search_rank: 50 },
}

describe('toPlayerRows', () => {
  it('filters, maps DEF->DST, defaults FA team and missing rank, drops nameless', () => {
    const rows = toPlayerRows(FIXTURE)
    const ids = rows.map(r => r.sleeperId).sort()
    expect(ids).toEqual(['1234', '4046', '9509', 'SF']) // C dropped, nameless WR dropped
    const dst = rows.find(r => r.sleeperId === 'SF')!
    expect(dst.position).toBe('DST')
    const fa = rows.find(r => r.sleeperId === '1234')!
    expect(fa.nflTeam).toBe('FA')
    expect(fa.searchRank).toBe(9_999_999)
  })
})

describe('PlayerRepo', () => {
  it('upserts idempotently and lists as ranked engine PlayerInfo', async () => {
    const pool = newTestPool()
    await migrate(pool)
    const repo = new PlayerRepo(pool)
    const n1 = await repo.upsertAll(toPlayerRows(FIXTURE))
    expect(n1).toBe(4)
    const n2 = await repo.upsertAll(toPlayerRows(FIXTURE)) // same again: update, not duplicate
    expect(n2).toBe(4)
    const list = await repo.listForDraft()
    expect(list[0]).toEqual({ id: '9509', name: 'Bijan Robinson', position: 'RB', nflTeam: 'ATL', rank: 1 })
    expect(list.map(p => p.rank)).toEqual([...list.map(p => p.rank)].sort((a, b) => a - b))
    expect(list).toHaveLength(4)
  })
})
```

Run: `npx vitest run packages/server/tests/players.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`packages/server/src/players.ts`:
```ts
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
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(server): sleeper player sync with DEF->DST mapping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Room — the command pipeline

**Files:**
- Create: `packages/server/src/room.ts`
- Test: `packages/server/tests/room.test.ts`

**Interfaces:**
- Consumes: engine `execute/apply/replay/initialState`, Task 3 `EventStore`.
- Produces (socket gateway and simulator depend on these exact shapes):
  - `type WireCommand = { [K in Command['type']]: Omit<Extract<Command, { type: K }>, 'now'> }[Command['type']]`
  - `type RoomDeps = { store: EventStore; broadcast: (leagueId: string, seq: number, events: DraftEvent[]) => void; notify: (leagueId: string, notice: { type: 'skip_loop' }) => void; clock: () => number }`
  - `class Room { static async create(leagueId, config, deps): Promise<Room>` (loads stream — Task 7 extends recovery behavior); `dispatch(cmd: WireCommand, nowOverride?: number): Promise<ExecuteResult>`; `get state(): DraftState`; `get lastSeq(): number`; `close(): void }`
  - Dispatch pipeline (in order, serialized by an internal promise chain): stamp `now` → `execute` → on error, return it → `store.append(leagueId, lastSeq, events)` → fold events via `apply` → `broadcast` → watchdog (Task 7) → re-arm timer. A timer fire dispatches `{ type: 'CLOCK_EXPIRED' }` through the same pipeline; a `CLOCK_NOT_EXPIRED` rejection is swallowed (a bid raced in and re-armed already).

- [ ] **Step 1: Failing test**

`packages/server/tests/room.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { PgEventStore } from '../src/store.js'
import { Room, type RoomDeps } from '../src/room.js'
import type { DraftEvent, LeagueConfig } from '@auction/engine'

function config(): LeagueConfig {
  const teams = Array.from({ length: 2 }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
  return {
    teams,
    budget: 200,
    rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }],
    bidClockMs: 10_000,
    nominationClockMs: 30_000,
    nominationOrder: ['T1', 'T2'],
    nominationExpiryPolicy: 'auto_nominate',
    players: [
      { id: 'QB1', name: 'QB One', position: 'QB', nflTeam: 'SF', rank: 1 },
      { id: 'QB2', name: 'QB Two', position: 'QB', nflTeam: 'KC', rank: 2 },
    ],
  }
}

describe('Room', () => {
  let deps: RoomDeps
  let broadcasts: { seq: number; events: DraftEvent[] }[]
  let nowMs: number

  beforeEach(async () => {
    vi.useFakeTimers()
    nowMs = 1_000
    const pool = newTestPool()
    await migrate(pool)
    await pool.query(`INSERT INTO leagues (id, name, config, commissioner_token, board_token) VALUES ('l1','T','{}','ct','bt')`)
    broadcasts = []
    deps = {
      store: new PgEventStore(pool),
      broadcast: (_id, seq, events) => broadcasts.push({ seq, events }),
      notify: () => {},
      clock: () => nowMs,
    }
  })
  afterEach(() => vi.useRealTimers())

  it('runs commands through execute/persist/apply/broadcast with server-stamped now', async () => {
    const room = await Room.create('l1', config(), deps)
    const r = await room.dispatch({ type: 'START_DRAFT' })
    expect(r.ok).toBe(true)
    expect(room.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1', deadline: 31_000 })
    expect(room.lastSeq).toBe(2)
    expect(broadcasts[0]!.events.map(e => e.type)).toEqual(['DRAFT_STARTED', 'NOMINATION_STARTED'])
    const { events } = await deps.store.load('l1')
    expect(events.map(e => e.type)).toEqual(['DRAFT_STARTED', 'NOMINATION_STARTED'])
    room.close()
  })

  it('returns engine errors without persisting or broadcasting', async () => {
    const room = await Room.create('l1', config(), deps)
    await room.dispatch({ type: 'START_DRAFT' })
    const bad = await room.dispatch({ type: 'BID', teamId: 'T2', amount: 5 })
    expect(!bad.ok && bad.error.code).toBe('WRONG_PHASE')
    expect(room.lastSeq).toBe(2)
    expect(broadcasts).toHaveLength(1)
    room.close()
  })

  it('fires the clock: nomination expiry auto-nominates, bid expiry sells', async () => {
    const room = await Room.create('l1', config(), deps)
    await room.dispatch({ type: 'START_DRAFT' })
    nowMs = 31_001
    await vi.advanceTimersByTimeAsync(30_001)
    expect(room.state.phase).toMatchObject({ type: 'bidding', playerId: 'QB1', highBidderId: 'T1' })
    nowMs = 41_002
    await vi.advanceTimersByTimeAsync(10_001)
    expect(room.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
    expect(room.state.teams['T1']!.roster).toHaveLength(1)
    room.close()
  })

  it('serializes concurrent dispatches: same-price race yields one winner and one STALE_PRICE', async () => {
    const room = await Room.create('l1', config(), deps)
    await room.dispatch({ type: 'START_DRAFT' })
    await room.dispatch({ type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 5 })
    const [a, b] = await Promise.all([
      room.dispatch({ type: 'BID', teamId: 'T2', amount: 6 }),
      room.dispatch({ type: 'BID', teamId: 'T2', amount: 6 }),
    ])
    const oks = [a, b].filter(r => r.ok)
    const errs = [a, b].filter(r => !r.ok)
    expect(oks).toHaveLength(1)
    expect(errs).toHaveLength(1)
    if (!errs[0]!.ok) expect(errs[0]!.error.code).toMatch(/STALE_PRICE|ALREADY_HIGH_BIDDER/)
    room.close()
  })
})
```

Run: `npx vitest run packages/server/tests/room.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`packages/server/src/room.ts`:
```ts
import { apply, execute, replay } from '@auction/engine'
import type { Command, DraftEvent, DraftState, ExecuteResult, LeagueConfig } from '@auction/engine'
import type { EventStore } from './store.js'

export type WireCommand = { [K in Command['type']]: Omit<Extract<Command, { type: K }>, 'now'> }[Command['type']]

export interface RoomDeps {
  store: EventStore
  broadcast: (leagueId: string, seq: number, events: DraftEvent[]) => void
  notify: (leagueId: string, notice: { type: 'skip_loop' }) => void
  clock: () => number
}

export class Room {
  private chain: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private skipStreak = 0

  protected constructor(
    readonly leagueId: string,
    private st: DraftState,
    private seq: number,
    private deps: RoomDeps,
  ) {}

  static async create(leagueId: string, config: LeagueConfig, deps: RoomDeps): Promise<Room> {
    const { seq, events } = await deps.store.load(leagueId)
    const state = replay(config, events)
    const room = new Room(leagueId, state, seq, deps)
    room.armTimer()
    return room
  }

  get state(): DraftState {
    return this.st
  }
  get lastSeq(): number {
    return this.seq
  }

  dispatch(cmd: WireCommand, nowOverride?: number): Promise<ExecuteResult> {
    const run = this.chain.then(() => this.exec(cmd, nowOverride))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async exec(cmd: WireCommand, nowOverride?: number): Promise<ExecuteResult> {
    const now = nowOverride ?? this.deps.clock()
    const r = execute(this.st, { ...cmd, now } as Command)
    if (!r.ok) return r
    this.seq = await this.deps.store.append(this.leagueId, this.seq, r.events)
    for (const e of r.events) this.st = apply(this.st, e)
    this.deps.broadcast(this.leagueId, this.seq, r.events)
    this.watchdog(r.events)
    this.armTimer()
    return r
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const phase = this.st.phase
    if (phase.type !== 'awaiting_nomination' && phase.type !== 'bidding') return
    const delay = Math.max(0, phase.deadline - this.deps.clock())
    this.timer = setTimeout(() => {
      // CLOCK_NOT_EXPIRED here means a bid raced in and re-armed; benign.
      // The catch prevents an unhandled rejection if the store is down; the
      // draft simply stalls until a client command surfaces the error.
      void this.dispatch({ type: 'CLOCK_EXPIRED' }).catch(() => {})
    }, delay)
  }

  private watchdog(events: DraftEvent[]): void {
    for (const e of events) {
      if (e.type === 'NOMINATION_SKIPPED') this.skipStreak += 1
      else if (e.type !== 'NOMINATION_STARTED') this.skipStreak = 0
    }
    if (this.skipStreak >= 2 * this.st.config.teams.length) {
      this.skipStreak = 0
      this.deps.notify(this.leagueId, { type: 'skip_loop' })
      void this.dispatch({ type: 'PAUSE' }).catch(() => {})
    }
  }

  /** Resolves when every queued command has settled (tests, shutdown). */
  idle(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(server): room command pipeline with authoritative clock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Recovery + skip-loop watchdog behavior

**Files:**
- Modify: `packages/server/src/room.ts` (boot-pause in `Room.create`)
- Create: `packages/server/src/rooms.ts` (RoomManager)
- Test: `packages/server/tests/recovery.test.ts`

**Interfaces:**
- Produces:
  - `Room.create` recovery semantics (backlog item): after replay, if the state is in a timed phase (`awaiting_nomination`/`bidding`), dispatch `{ type: 'PAUSE' }` with `nowOverride` = the last stored event's `at` — the engine's clamp guarantees `remainingMs ≥ 0`; the DRAFT_PAUSED event persists, so recovery is itself in the log. The commissioner resumes (optionally ADD_TIME first).
  - `class RoomManager { constructor(deps: RoomDeps, leagues: LeagueService); getOrLoad(leagueId): Promise<Room | null>; reload(leagueId): Promise<Room | null>; closeAll(): Promise<void> }` — one Room per league, loaded lazily on first use. Config resolution: frozen config if present; otherwise stored config + `players: []` (lobby). `reload` closes and re-creates (used after freeze).
- The watchdog notice contract (from Task 6): after `2 × teams` consecutive `NOMINATION_SKIPPED` events with no intervening sale/nomination, the room auto-pauses and calls `notify(leagueId, { type: 'skip_loop' })`.

- [ ] **Step 1: Failing test**

`packages/server/tests/recovery.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Pool } from 'pg'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { PgEventStore } from '../src/store.js'
import { Room, type RoomDeps } from '../src/room.js'
import type { LeagueConfig } from '@auction/engine'

function config(overrides: Partial<LeagueConfig> = {}): LeagueConfig {
  const teams = [{ id: 'T1', name: 'A' }, { id: 'T2', name: 'B' }]
  return {
    teams,
    budget: 200,
    rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }],
    bidClockMs: 10_000,
    nominationClockMs: 30_000,
    nominationOrder: ['T1', 'T2'],
    nominationExpiryPolicy: 'auto_nominate',
    players: [
      { id: 'QB1', name: 'QB One', position: 'QB', nflTeam: 'SF', rank: 1 },
      { id: 'QB2', name: 'QB Two', position: 'QB', nflTeam: 'KC', rank: 2 },
    ],
    ...overrides,
  }
}

describe('recovery', () => {
  let pool: Pool
  let deps: RoomDeps
  let notices: { type: string }[]
  let nowMs: number

  beforeEach(async () => {
    vi.useFakeTimers()
    nowMs = 1_000
    pool = newTestPool()
    await migrate(pool)
    await pool.query(`INSERT INTO leagues (id, name, config, commissioner_token, board_token) VALUES ('l1','T','{}','ct','bt')`)
    notices = []
    deps = {
      store: new PgEventStore(pool),
      broadcast: () => {},
      notify: (_id, n) => notices.push(n),
      clock: () => nowMs,
    }
  })
  afterEach(() => vi.useRealTimers())

  it('reloading a mid-bidding room boot-pauses at the last event time with clamped remaining', async () => {
    const cfg = config()
    const room1 = await Room.create('l1', cfg, deps)
    await room1.dispatch({ type: 'START_DRAFT' }) // deadline 31_000
    await room1.dispatch({ type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 3 }) // at 1_000, deadline 11_000
    room1.close()
    // "crash": new room from the same stream, long after the deadline passed
    nowMs = 500_000
    const room2 = await Room.create('l1', cfg, deps)
    expect(room2.state.phase).toMatchObject({ type: 'paused', remainingMs: 10_000 })
    // resume works and re-arms from resume time, not from the stale deadline
    const r = await room2.dispatch({ type: 'RESUME' })
    expect(r.ok).toBe(true)
    expect(room2.state.phase).toMatchObject({ type: 'bidding', price: 3, deadline: 510_000 })
    room2.close()
  })

  it('does not boot-pause a lobby or completed stream', async () => {
    const room1 = await Room.create('l1', config(), deps)
    expect(room1.state.phase).toEqual({ type: 'lobby' })
    room1.close()
  })

  it('watchdog pauses after two full skip rotations and emits a notice', async () => {
    // Pool has only QBs; make both QB slots full via a tiny two-sale draft impossible -> instead: skip policy with no legal players.
    const cfg = config({ nominationExpiryPolicy: 'skip', players: [] })
    const room = await Room.create('l1', cfg, deps)
    await room.dispatch({ type: 'START_DRAFT' })
    for (let i = 0; i < 4; i++) {
      // each expiry: NOMINATION_SKIPPED + NOMINATION_STARTED for the other team
      const ph = room.state.phase
      if (ph.type !== 'awaiting_nomination') break
      nowMs = ph.deadline + 1
      await room.dispatch({ type: 'CLOCK_EXPIRED' })
    }
    await room.idle() // the watchdog's auto-pause is queued behind the triggering command
    expect(notices).toEqual([{ type: 'skip_loop' }])
    expect(room.state.phase.type).toBe('paused')
    room.close()
  })
})
```

Run: `npx vitest run packages/server/tests/recovery.test.ts` → FAIL (boot-pause missing).

- [ ] **Step 2: Implement boot-pause — replace `Room.create` in room.ts**

```ts
  static async create(leagueId: string, config: LeagueConfig, deps: RoomDeps): Promise<Room> {
    const { seq, events } = await deps.store.load(leagueId)
    const state = replay(config, events)
    const room = new Room(leagueId, state, seq, deps)
    if (state.phase.type === 'awaiting_nomination' || state.phase.type === 'bidding') {
      const last = events[events.length - 1]!
      await room.dispatch({ type: 'PAUSE' }, last.at)
    }
    room.armTimer()
    return room
  }
```

(Note: `dispatch` already re-arms after the pause — the extra `armTimer()` is a no-op for paused states and arms lobby/complete correctly, i.e. not at all.)

`packages/server/src/rooms.ts`:
```ts
import type { LeagueConfig } from '@auction/engine'
import { Room, type RoomDeps } from './room.js'
import type { LeagueService } from './league.js'

export class RoomManager {
  private rooms = new Map<string, Promise<Room>>()

  constructor(private deps: RoomDeps, private leagues: LeagueService) {}

  private async resolveConfig(leagueId: string): Promise<LeagueConfig | null> {
    const frozen = await this.leagues.frozenConfig(leagueId)
    if (frozen) return frozen
    const rec = await this.leagues.get(leagueId)
    if (!rec) return null
    return { ...rec.config, players: [] } as LeagueConfig
  }

  getOrLoad(leagueId: string): Promise<Room | null> {
    const existing = this.rooms.get(leagueId)
    if (existing) return existing.then(r => r)
    const loading = (async () => {
      const config = await this.resolveConfig(leagueId)
      if (!config) throw new Error(`no league ${leagueId}`)
      return Room.create(leagueId, config, this.deps)
    })()
    this.rooms.set(leagueId, loading)
    loading.catch(() => this.rooms.delete(leagueId))
    return loading.then(
      r => r,
      () => null,
    )
  }

  /** Close and re-create (after config freeze). */
  async reload(leagueId: string): Promise<Room | null> {
    const existing = this.rooms.get(leagueId)
    if (existing) (await existing.catch(() => null))?.close()
    this.rooms.delete(leagueId)
    return this.getOrLoad(leagueId)
  }

  async closeAll(): Promise<void> {
    for (const p of this.rooms.values()) (await p.catch(() => null))?.close()
    this.rooms.clear()
  }
}
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green (watchdog test exercises Task 6 code; if the streak math is off, fix `watchdog`, not the test).

```bash
git add -A
git commit -m "feat(server): crash recovery boot-pause and room manager

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: HTTP API — league creation + player refresh

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/tests/http.test.ts`

**Interfaces:**
- Produces (final `AppDeps`): `{ leagues: LeagueService; players: { repo: PlayerRepo; sync: () => Promise<number> }; createKey: string }`
  - `POST /api/leagues` — header `x-create-key` must equal `createKey` (403 otherwise); body `{ name, config }`; 201 → `CreatedLeague` JSON (all invite links); 400 with Zod issues on invalid config.
  - `POST /api/leagues/:id/refresh-players` — header `authorization: Bearer <commissioner token>` for that league (403 otherwise); triggers `players.sync()`; 200 → `{ updated: number }`.
  - `GET /healthz` unchanged.

- [ ] **Step 1: Failing test**

`packages/server/tests/http.test.ts`:
```ts
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
    const bad = await request(app).post('/api/leagues').set('x-create-key', 'sekret').send({ name: 'L', config: { ...CONFIG, budget: 1 } })
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
})
```

Run: `npx vitest run packages/server/tests/http.test.ts` → FAIL.

- [ ] **Step 2: Implement — replace app.ts**

```ts
import express from 'express'
import { ZodError } from 'zod'
import type { LeagueService } from './league.js'
import type { PlayerRepo } from './players.js'

export interface AppDeps {
  leagues?: LeagueService
  players?: { repo: PlayerRepo; sync: () => Promise<number> }
  createKey?: string
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
      throw err
    }
  })

  app.post('/api/leagues/:id/refresh-players', async (req, res) => {
    if (!deps.leagues || !deps.players) return res.status(503).json({ error: 'not configured' })
    const auth = req.header('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const principal = token ? await deps.leagues.resolveToken(token) : null
    if (!principal || principal.role !== 'commissioner' || principal.leagueId !== req.params.id) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const updated = await deps.players.sync()
    return res.json({ updated })
  })

  return app
}
```

Update the Task 1 test's `createApp({})` call if the compiler complains — `AppDeps` fields are all optional, so it should not.

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(server): league creation and player refresh endpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Socket gateway — auth, snapshot, commands, presence, draft start

**Files:**
- Create: `packages/server/src/sockets.ts`, `packages/server/src/wire.ts`
- Test: `packages/server/tests/sockets.test.ts`

**Interfaces:**
- Produces:
  - `wire.ts`: `WireCommandSchema` — Zod discriminated union over every engine command **minus `now`**, with the Global Constraints bounds. Also `parseWireCommand(input: unknown): WireCommand` (throws ZodError).
  - `sockets.ts`: `attachSockets(io: Server, deps: SocketDeps): void` with `SocketDeps = { leagues: LeagueService; rooms: RoomManager; playerRepo: PlayerRepo }`.
  - **Protocol** (Plan 3's client contract — keep exact):
    - Handshake: `socket.handshake.auth.token` → `leagues.resolveToken`; invalid → connection refused with error `'unauthorized'`.
    - On connect: socket joins room `league:<leagueId>`; server emits `snapshot` → `{ seq, state, role, teamId? }` (board gets the same state; UI hides controls by role).
    - Client emits `command` with `(payload, ack)`; server acks `{ ok: true }` or `{ ok: false, error: { code, message } }`. Validation order: Zod parse (`code: 'INVALID_COMMAND'` on failure) → authorization (`code: 'FORBIDDEN'`) → room dispatch (engine result passed through).
    - **Authorization matrix:** board → no commands. Manager → only `NOMINATE`/`BID` and only with `teamId` equal to their own. Commissioner → every command (proxy nominate/bid included).
    - **START_DRAFT interception:** commissioner-only; if the league isn't frozen, freeze with `playerRepo.listForDraft()` (reject with `code: 'NO_PLAYERS'` if the pool is empty), `rooms.reload(leagueId)`, then dispatch.
    - Broadcasts: `events` → `{ seq, events }` to `league:<leagueId>` (wired from `RoomDeps.broadcast` in Task 10); `notice` → `{ type: 'skip_loop' }`; `presence` → `{ connected: { role, teamId? }[] }` emitted on every connect/disconnect.

- [ ] **Step 1: Failing tests**

`packages/server/tests/sockets.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { io as client, type Socket } from 'socket.io-client'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { PgEventStore } from '../src/store.js'
import { LeagueService } from '../src/league.js'
import { PlayerRepo, toPlayerRows } from '../src/players.js'
import { RoomManager } from '../src/rooms.js'
import { attachSockets } from '../src/sockets.js'

const CONFIG = {
  teams: [{ id: 'T1', name: 'A' }, { id: 'T2', name: 'B' }],
  budget: 200,
  rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }],
  bidClockMs: 10_000,
  nominationClockMs: 30_000,
  nominationOrder: ['T1', 'T2'],
  nominationExpiryPolicy: 'auto_nominate',
}
const SLEEPER_FIXTURE = {
  q1: { full_name: 'QB One', position: 'QB', team: 'SF', status: 'Active', search_rank: 1 },
  q2: { full_name: 'QB Two', position: 'QB', team: 'KC', status: 'Active', search_rank: 2 },
}

function connect(port: number, token: string): Promise<{ socket: Socket; snapshot: any }> {
  return new Promise((resolve, reject) => {
    const socket = client(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'] })
    socket.on('snapshot', snapshot => resolve({ socket, snapshot }))
    socket.on('connect_error', reject)
  })
}
const emit = (socket: Socket, payload: unknown): Promise<any> =>
  new Promise(resolve => socket.emit('command', payload, resolve))

describe('socket gateway', () => {
  let http: HttpServer
  let port: number
  let leagues: LeagueService
  let leagueId: string
  let tokens: { commissioner: string; board: string; t1: string; t2: string }
  const open: Socket[] = []

  beforeEach(async () => {
    const pool = newTestPool()
    await migrate(pool)
    leagues = new LeagueService(pool, 'http://x')
    const playerRepo = new PlayerRepo(pool)
    await playerRepo.upsertAll(toPlayerRows(SLEEPER_FIXTURE))
    const store = new PgEventStore(pool)
    http = createServer()
    const io = new Server(http)
    const rooms = new RoomManager(
      {
        store,
        broadcast: (id, seq, events) => io.to(`league:${id}`).emit('events', { seq, events }),
        notify: (id, notice) => io.to(`league:${id}`).emit('notice', notice),
        clock: () => Date.now(),
      },
      leagues,
    )
    attachSockets(io, { leagues, rooms, playerRepo })
    await new Promise<void>(r => http.listen(0, r))
    port = (http.address() as { port: number }).port
    const created = await leagues.create('L', CONFIG)
    leagueId = created.id
    tokens = {
      commissioner: created.links.commissioner.split('#')[1]!,
      board: created.links.board.split('#')[1]!,
      t1: created.links.teams.find(t => t.teamId === 'T1')!.url.split('#')[1]!,
      t2: created.links.teams.find(t => t.teamId === 'T2')!.url.split('#')[1]!,
    }
  })
  afterEach(async () => {
    for (const s of open.splice(0)) s.disconnect()
    await new Promise<void>(r => http.close(() => r()))
  })

  it('rejects bad tokens, snapshots by role', async () => {
    await expect(connect(port, 'garbage')).rejects.toBeTruthy()
    const c = await connect(port, tokens.commissioner)
    open.push(c.socket)
    expect(c.snapshot).toMatchObject({ seq: 0, role: 'commissioner', state: { phase: { type: 'lobby' } } })
    const m = await connect(port, tokens.t1)
    open.push(m.socket)
    expect(m.snapshot).toMatchObject({ role: 'manager', teamId: 'T1' })
  })

  it('enforces the authorization matrix', async () => {
    const b = await connect(port, tokens.board)
    const m = await connect(port, tokens.t1)
    open.push(b.socket, m.socket)
    expect((await emit(b.socket, { type: 'START_DRAFT' })).error.code).toBe('FORBIDDEN')
    expect((await emit(m.socket, { type: 'START_DRAFT' })).error.code).toBe('FORBIDDEN')
    expect((await emit(m.socket, { type: 'ADJUST_BUDGET', teamId: 'T1', delta: 10 })).error.code).toBe('FORBIDDEN')
    expect((await emit(m.socket, { type: 'BID', teamId: 'T2', amount: 5 })).error.code).toBe('FORBIDDEN')
    expect((await emit(m.socket, { type: 'BID', teamId: 'T1', amount: -3 })).error.code).toBe('INVALID_COMMAND')
  })

  it('commissioner START_DRAFT freezes players then drafts flow end to end', async () => {
    const c = await connect(port, tokens.commissioner)
    const m1 = await connect(port, tokens.t1)
    open.push(c.socket, m1.socket)
    const received: any[] = []
    m1.socket.on('events', e => received.push(e))
    const started = await emit(c.socket, { type: 'START_DRAFT' })
    expect(started.ok).toBe(true)
    expect((await leagues.frozenConfig(leagueId))!.players).toHaveLength(2)
    const nom = await emit(m1.socket, { type: 'NOMINATE', teamId: 'T1', playerId: 'q1', openingBid: 3 })
    expect(nom.ok).toBe(true)
    await new Promise(r => setTimeout(r, 50))
    expect(received.flatMap(e => e.events.map((x: any) => x.type))).toContain('PLAYER_NOMINATED')
  })

  it('broadcasts presence on connect and disconnect', async () => {
    const c = await connect(port, tokens.commissioner)
    open.push(c.socket)
    const seen: any[] = []
    c.socket.on('presence', p => seen.push(p))
    const m = await connect(port, tokens.t2)
    await new Promise(r => setTimeout(r, 50))
    m.socket.disconnect()
    await new Promise(r => setTimeout(r, 50))
    const flat = seen.map(p => p.connected.map((x: any) => x.teamId ?? x.role).sort())
    expect(flat.some(l => l.includes('T2'))).toBe(true)
    expect(flat[flat.length - 1]).not.toContain('T2')
  })
})
```

Run: `npx vitest run packages/server/tests/sockets.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`packages/server/src/wire.ts`:
```ts
import { z } from 'zod'
import type { WireCommand } from './room.js'

const money = z.number().int().min(1).max(10_000)
const clockMs = z.number().int().min(1_000).max(600_000)

export const WireCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('START_DRAFT') }),
  z.object({ type: z.literal('NOMINATE'), teamId: z.string(), playerId: z.string(), openingBid: money }),
  z.object({ type: z.literal('BID'), teamId: z.string(), amount: money }),
  z.object({ type: z.literal('CLOCK_EXPIRED') }),
  z.object({ type: z.literal('PAUSE') }),
  z.object({ type: z.literal('RESUME') }),
  z.object({ type: z.literal('ADD_TIME'), ms: z.number().int().min(1_000).max(600_000) }),
  z.object({ type: z.literal('SET_TIMERS'), bidClockMs: clockMs.optional(), nominationClockMs: clockMs.optional() }),
  z.object({ type: z.literal('UNDO_SALE') }),
  z.object({ type: z.literal('EDIT_PICK'), overall: z.number().int().min(1), newTeamId: z.string().optional(), newPrice: money.optional() }),
  z.object({ type: z.literal('ADJUST_BUDGET'), teamId: z.string(), delta: z.number().int().min(-1_000).max(1_000).refine(d => d !== 0, 'delta must be nonzero') }),
])

export function parseWireCommand(input: unknown): WireCommand {
  return WireCommandSchema.parse(input) as WireCommand
}
```

`packages/server/src/sockets.ts`:
```ts
import type { Server, Socket } from 'socket.io'
import { ZodError } from 'zod'
import type { LeagueService, Principal } from './league.js'
import type { PlayerRepo } from './players.js'
import type { RoomManager } from './rooms.js'
import { parseWireCommand } from './wire.js'
import type { WireCommand } from './room.js'

export interface SocketDeps {
  leagues: LeagueService
  rooms: RoomManager
  playerRepo: PlayerRepo
}

type Ack = (result: { ok: true } | { ok: false; error: { code: string; message: string } }) => void
const deny = (ack: Ack, code: string, message: string) => ack({ ok: false, error: { code, message } })

const MANAGER_COMMANDS = new Set<WireCommand['type']>(['NOMINATE', 'BID'])

function authorized(principal: Principal, cmd: WireCommand): boolean {
  if (principal.role === 'commissioner') return cmd.type !== 'CLOCK_EXPIRED' // clock is server-internal
  if (principal.role === 'board') return false
  if (!MANAGER_COMMANDS.has(cmd.type)) return false
  return (cmd as { teamId?: string }).teamId === principal.teamId
}

export function attachSockets(io: Server, deps: SocketDeps): void {
  const connected = new Map<string, Map<string, Principal>>() // leagueId -> socketId -> principal

  const presence = (leagueId: string) => {
    const list = [...(connected.get(leagueId)?.values() ?? [])].map(p =>
      p.role === 'manager' ? { role: p.role, teamId: p.teamId } : { role: p.role },
    )
    io.to(`league:${leagueId}`).emit('presence', { connected: list })
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token
    const principal = typeof token === 'string' ? await deps.leagues.resolveToken(token) : null
    if (!principal) return next(new Error('unauthorized'))
    ;(socket.data as { principal: Principal }).principal = principal
    next()
  })

  io.on('connection', async (socket: Socket) => {
    const principal = (socket.data as { principal: Principal }).principal
    const { leagueId } = principal
    const room = await deps.rooms.getOrLoad(leagueId)
    if (!room) {
      socket.disconnect(true)
      return
    }
    await socket.join(`league:${leagueId}`)
    if (!connected.has(leagueId)) connected.set(leagueId, new Map())
    connected.get(leagueId)!.set(socket.id, principal)
    socket.emit('snapshot', {
      seq: room.lastSeq,
      state: room.state,
      role: principal.role,
      ...(principal.role === 'manager' ? { teamId: principal.teamId } : {}),
    })
    presence(leagueId)

    socket.on('command', async (payload: unknown, ack: Ack) => {
      if (typeof ack !== 'function') return
      let cmd: WireCommand
      try {
        cmd = parseWireCommand(payload)
      } catch (err) {
        return deny(ack, 'INVALID_COMMAND', err instanceof ZodError ? err.issues.map(i => i.message).join('; ') : 'invalid command')
      }
      if (!authorized(principal, cmd)) return deny(ack, 'FORBIDDEN', 'not allowed for your role')

      let target = await deps.rooms.getOrLoad(leagueId)
      if (!target) return deny(ack, 'NO_LEAGUE', 'league not found')

      if (cmd.type === 'START_DRAFT' && !(await deps.leagues.frozenConfig(leagueId))) {
        const pool = await deps.playerRepo.listForDraft()
        if (pool.length === 0) return deny(ack, 'NO_PLAYERS', 'player pool is empty — refresh players first')
        await deps.leagues.freeze(leagueId, pool)
        target = await deps.rooms.reload(leagueId)
        if (!target) return deny(ack, 'NO_LEAGUE', 'league not found')
      }

      try {
        const result = await target.dispatch(cmd)
        if (result.ok) return ack({ ok: true })
        return ack({ ok: false, error: { code: result.error.code, message: result.error.message } })
      } catch {
        // Store/infra failure: the command was NOT applied. Client keeps its state; commissioner pauses.
        return deny(ack, 'INTERNAL', 'server error — command not applied')
      }
    })

    socket.on('disconnect', () => {
      connected.get(leagueId)?.delete(socket.id)
      presence(leagueId)
    })
  })
}
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(server): socket gateway with capability auth and role matrix

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Boot wiring — main.ts

**Files:**
- Create: `packages/server/src/main.ts`
- Modify: root `package.json` (start script)
- Test: `packages/server/tests/boot.test.ts`

**Interfaces:**
- Produces: `buildServer(env: Env, pool: Pool): Promise<{ http: HttpServer; io: Server; rooms: RoomManager; close(): Promise<void> }>` — composes migrate → repos/services → RoomManager (broadcast/notify wired to io, clock = `Date.now`) → Express app → Socket.IO. `main.ts` calls it with real env, schedules the daily player sync (`node-cron`, `0 9 * * *`, guarded by `SLEEPER_SYNC === '1'`), runs an immediate sync when the players table is empty and `SLEEPER_SYNC === '1'`, and listens on `PORT`. Root `package.json` gains `"start": "tsx packages/server/src/main.ts"`.

- [ ] **Step 1: Failing test**

`packages/server/tests/boot.test.ts`:
```ts
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
```

Run: `npx vitest run packages/server/tests/boot.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`packages/server/src/main.ts`:
```ts
import { createServer, type Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import cron from 'node-cron'
import type { Pool } from 'pg'
import { createApp } from './app.js'
import { createPool } from './db.js'
import { loadEnv, type Env } from './env.js'
import { LeagueService } from './league.js'
import { migrate } from './migrations.js'
import { fetchSleeperPlayers, PlayerRepo, toPlayerRows } from './players.js'
import { RoomManager } from './rooms.js'
import { attachSockets } from './sockets.js'
import { PgEventStore } from './store.js'

export async function buildServer(env: Env, pool: Pool): Promise<{ http: HttpServer; io: Server; rooms: RoomManager; close(): Promise<void> }> {
  await migrate(pool)
  const leagues = new LeagueService(pool, env.BASE_URL)
  const playerRepo = new PlayerRepo(pool)
  const sync = async () => playerRepo.upsertAll(toPlayerRows(await fetchSleeperPlayers()))
  const app = createApp({ leagues, players: { repo: playerRepo, sync }, createKey: env.CREATE_KEY })
  const http = createServer(app)
  const io = new Server(http)
  const rooms = new RoomManager(
    {
      store: new PgEventStore(pool),
      broadcast: (id, seq, events) => io.to(`league:${id}`).emit('events', { seq, events }),
      notify: (id, notice) => io.to(`league:${id}`).emit('notice', notice),
      clock: () => Date.now(),
    },
    leagues,
  )
  attachSockets(io, { leagues, rooms, playerRepo })
  return {
    http,
    io,
    rooms,
    async close() {
      await rooms.closeAll()
      io.close()
      await new Promise<void>((resolve, reject) => http.close(err => (err ? reject(err) : resolve())))
    },
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const env = loadEnv()
  const pool = createPool(env.DATABASE_URL)
  const server = await buildServer(env, pool)
  if (env.SLEEPER_SYNC === '1') {
    const count = await pool.query('SELECT count(*)::int AS n FROM players')
    if (count.rows[0].n === 0) {
      const sync = async () => new PlayerRepo(pool).upsertAll(toPlayerRows(await fetchSleeperPlayers()))
      console.log(`seeded players: ${await sync()}`)
    }
    cron.schedule('0 9 * * *', async () => {
      const n = await new PlayerRepo(pool).upsertAll(toPlayerRows(await fetchSleeperPlayers()))
      console.log(`daily player sync: ${n}`)
    })
  }
  server.http.listen(env.PORT, () => console.log(`auction-draft server on :${env.PORT}`))
}
```

Root `package.json` — add to `"scripts"`:
```json
    "start": "tsx packages/server/src/main.ts"
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(server): boot wiring with daily player sync

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Bot simulator + full-draft integration test

**Files:**
- Create: `packages/server/tests/helpers/bots.ts`, `packages/server/tests/integration.test.ts`

**Interfaces:**
- Consumes: the full stack from Task 10's `buildServer` (pg-mem pool, real sockets on an ephemeral port).
- Produces: spec §11's bot simulator — `runBot(url, token, opts): BotHandle` where each bot keeps a local state view from `snapshot` + `events`, nominates a random affordable player after 10–40ms when on the clock, and bids (probability 0.4, +$1..3, 5–30ms delay) while eligible. Deterministic via a seeded PRNG per bot. Also the plan's **acceptance test**: a full 10-team draft over real sockets completes, and the DB event log replays to exactly the server's final state (spec §13 criteria 3's server-side counterpart).

- [ ] **Step 1: Write the bot helper**

`packages/server/tests/helpers/bots.ts`:
```ts
import { io as client, type Socket } from 'socket.io-client'
import { apply, maxBid, firstOpenSlotFor } from '@auction/engine'
import type { DraftEvent, DraftState } from '@auction/engine'

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface BotHandle {
  socket: Socket
  done: Promise<DraftState>
}

export function runBot(url: string, token: string, teamId: string, seed: number): BotHandle {
  const rand = mulberry32(seed)
  const socket = client(url, { auth: { token }, transports: ['websocket'] })
  let state: DraftState | null = null
  let acting = false

  const send = (cmd: unknown) => new Promise(res => socket.emit('command', cmd, res))
  const later = (fn: () => void, ms: number) => setTimeout(fn, ms)

  let resolveDone: (s: DraftState) => void
  const done = new Promise<DraftState>(r => (resolveDone = r))

  const maybeAct = () => {
    if (!state || acting) return
    const s = state
    if (s.phase.type === 'complete') return resolveDone(s)
    const me = s.teams[teamId]
    if (!me) return
    if (s.phase.type === 'awaiting_nomination' && s.phase.teamId === teamId) {
      acting = true
      later(async () => {
        const cur = state
        if (cur && cur.phase.type === 'awaiting_nomination' && cur.phase.teamId === teamId) {
          const legal = cur.available.filter(id => {
            const p = cur.config.players.find(x => x.id === id)!
            return firstOpenSlotFor(cur.teams[teamId]!, p.position, cur.config) !== null
          })
          const pick = legal[Math.floor(rand() * legal.length)]
          if (pick) await send({ type: 'NOMINATE', teamId, playerId: pick, openingBid: 1 })
        }
        acting = false
        maybeAct()
      }, 10 + Math.floor(rand() * 30))
      return
    }
    if (s.phase.type === 'bidding' && s.phase.highBidderId !== teamId && rand() < 0.4) {
      const phase = s.phase
      const p = s.config.players.find(x => x.id === phase.playerId)!
      const amount = phase.price + 1 + Math.floor(rand() * 3)
      if (amount <= maxBid(me, s.config) && firstOpenSlotFor(me, p.position, s.config) !== null) {
        acting = true
        later(async () => {
          const cur = state
          if (cur && cur.phase.type === 'bidding' && cur.phase.playerId === phase.playerId && cur.phase.highBidderId !== teamId) {
            await send({ type: 'BID', teamId, amount: Math.max(amount, cur.phase.price + 1) })
          }
          acting = false
          maybeAct()
        }, 5 + Math.floor(rand() * 25))
      }
    }
  }

  socket.on('snapshot', (snap: { state: DraftState }) => {
    state = snap.state
    maybeAct()
  })
  socket.on('events', (batch: { events: DraftEvent[] }) => {
    if (!state) return
    for (const e of batch.events) state = apply(state, e)
    maybeAct()
  })

  return { socket, done }
}
```

- [ ] **Step 2: Write the integration test**

`packages/server/tests/integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { replay, rosterCapacity, openSlotCount } from '@auction/engine'
import type { Position } from '@auction/engine'
import { newTestPool } from './helpers/testDb.js'
import { buildServer } from '../src/main.js'
import { LeagueService } from '../src/league.js'
import { PgEventStore } from '../src/store.js'
import { PlayerRepo } from '../src/players.js'
import { runBot } from './helpers/bots.js'
import { io as client } from 'socket.io-client'

const ALL: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']
// Capacity 5 -> 50 total picks. With 1s clocks each pick resolves in ~1.1-1.5s
// (auto-nomination backstop guarantees progress even with silent bots), so the
// full draft lands around 60-80s against the 120s timeout. Pool sizing follows
// the engine fuzz suite's exhaustion-proof rule (supply > slots-elsewhere +
// FLEX + bench for each position).
const TEMPLATE = [
  { name: 'QB', eligible: ['QB' as const], count: 1 },
  { name: 'RB', eligible: ['RB' as const], count: 1 },
  { name: 'WR', eligible: ['WR' as const], count: 1 },
  { name: 'FLEX', eligible: ['RB', 'WR', 'TE'] as Position[], count: 1 },
  { name: 'BENCH', eligible: ['QB', 'RB', 'WR', 'TE'] as Position[], count: 1 },
]

function playerRows() {
  const per: Record<string, number> = { QB: 30, RB: 40, WR: 40, TE: 20, K: 0, DST: 0 }
  const rows = []
  let rank = 1
  for (const pos of ALL) {
    for (let i = 1; i <= (per[pos] ?? 0); i++) {
      rows.push({ sleeperId: `${pos}${i}`, name: `${pos} ${i}`, position: pos as Position, nflTeam: 'FA', status: 'Active', searchRank: rank++ })
    }
  }
  return rows
}

describe('full draft over real sockets', () => {
  it('10 bots complete an auction; DB log replays to the exact server state', { timeout: 120_000 }, async () => {
    const pool = newTestPool()
    const env = { DATABASE_URL: 'unused', PORT: 0, BASE_URL: 'http://localhost', CREATE_KEY: 'k', SLEEPER_SYNC: '0' as const }
    const server = await buildServer(env, pool)
    await new Promise<void>(r => server.http.listen(0, r))
    const port = (server.http.address() as { port: number }).port
    const url = `http://localhost:${port}`

    await new PlayerRepo(pool).upsertAll(playerRows())
    const leagues = new LeagueService(pool, url)
    const teams = Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
    const created = await leagues.create('Sim', {
      teams,
      budget: 200,
      rosterTemplate: TEMPLATE,
      bidClockMs: 1_000,
      nominationClockMs: 1_000,
      nominationOrder: teams.map(t => t.id),
      nominationExpiryPolicy: 'auto_nominate',
    })

    const bots = created.links.teams.map((t, i) => runBot(url, t.url.split('#')[1]!, t.teamId, 1000 + i))
    const commish = client(url, { auth: { token: created.links.commissioner.split('#')[1]! }, transports: ['websocket'] })
    await new Promise(r => commish.on('snapshot', r))
    const started = await new Promise<any>(r => commish.emit('command', { type: 'START_DRAFT' }, r))
    expect(started.ok).toBe(true)

    const finals = await Promise.all(bots.map(b => b.done))
    const final = finals[0]!
    expect(final.phase.type).toBe('complete')

    // every roster full and legal
    for (const team of Object.values(final.teams)) {
      expect(team.roster).toHaveLength(rosterCapacity(final.config.rosterTemplate))
      expect(team.budget).toBeGreaterThanOrEqual(openSlotCount(team, final.config))
    }

    // the DB event log is a complete, replayable record equal to the live server state
    const room = await server.rooms.getOrLoad(created.id)
    const frozen = (await leagues.frozenConfig(created.id))!
    const { events } = await new PgEventStore(pool).load(created.id)
    expect(replay(frozen, events)).toStrictEqual(room!.state)
    expect(room!.state.phase.type).toBe('complete')

    for (const b of bots) b.socket.disconnect()
    commish.disconnect()
    await server.close()
  })
})
```

- [ ] **Step 3: Run it (this is the acceptance gate)**

Run: `npx vitest run packages/server/tests/integration.test.ts`
Expected: PASS in roughly 60-90s (1s clocks; the auto-nomination backstop guarantees forward progress even if every bot stays silent). If it fails or times out, that is a real server bug — diagnose, do not weaken the test.

- [ ] **Step 4: Full suite + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "test(server): 10-bot full-draft integration with replay equivalence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Deploy readiness (Railway)

**Files:**
- Modify: root `package.json` (engines), `packages/engine/package.json` (version)
- Create: `.env.example`, `docs/DEPLOY.md`

**Interfaces:**
- Produces: a repo Railway can run as-is (backlog items: engines/version fields, build story = tsx runtime — recorded decision). The actual Railway account/project creation is **interactive with the user** and happens after this plan's execution, following `docs/DEPLOY.md`.

- [ ] **Step 1: Package fields**

Root `package.json` — add:
```json
  "engines": { "node": ">=22" }
```
`packages/engine/package.json` — add `"version": "0.1.0"`.

- [ ] **Step 2: `.env.example`**

```
# Postgres connection string (Railway provides this as DATABASE_URL)
DATABASE_URL=postgres://user:pass@localhost:5432/auction
# Public URL used in invite links
BASE_URL=http://localhost:3000
# Shared secret required to create leagues (any long random string)
CREATE_KEY=change-me
# 1 = fetch Sleeper players on boot (if empty) and daily at 09:00
SLEEPER_SYNC=1
PORT=3000
```

- [ ] **Step 3: `docs/DEPLOY.md`** — step-by-step Railway guide (the user drives; each step waits for their confirmation):

```markdown
# Deploying to Railway

Runtime decision (recorded): the server runs under `tsx` (no build step). Revisit if/when this becomes a multi-tenant product.

1. railway.com → New Project → "Deploy from GitHub repo" → select `slickbets/auction-draft` (grant repo access if prompted).
2. In the new project: **+ New → Database → PostgreSQL.**
3. On the app service → Variables:
   - `DATABASE_URL` → Add Reference → select the Postgres service's `DATABASE_URL`.
   - `BASE_URL` → the app service's public domain (Settings → Networking → Generate Domain, then paste `https://<domain>`).
   - `CREATE_KEY` → a long random string (`openssl rand -base64 24`).
   - `SLEEPER_SYNC` → `1`.
4. Settings → Deploy: start command is auto-detected from root `npm start`; healthcheck path `/healthz`.
5. Deploy. Verify: `curl https://<domain>/healthz` → `{"ok":true}`; logs show `seeded players: <n>` on first boot.
6. Create the league:
   `curl -X POST https://<domain>/api/leagues -H 'content-type: application/json' -H "x-create-key: $CREATE_KEY" -d @league.json`
   → the response contains the commissioner link, board link, and all ten invite links.
```

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run typecheck` → green (fields/docs only; nothing behavioral).

```bash
git add -A
git commit -m "chore: deploy readiness for railway (engines, env example, guide)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec coverage map (self-check)

| Spec / backlog item | Covered by |
|---|---|
| §4 server owns state/clock/bid serialization | Task 6 (Room pipeline + promise queue + timer) |
| §4 auth: invite links, re-issuable, board read-only | Task 4 (tokens) + Task 9 (matrix); re-issue = Plan 3 admin UI over `LeagueService` |
| §4 data model | Task 2 (schema) |
| §8 player data (daily sync + refresh button) | Task 5 + Task 8 (endpoint) + Task 10 (cron) |
| §10 reconnect = snapshot resync | Task 9 (`snapshot` on every connect) |
| §10 server crash = replay, restore paused | Task 7 (boot-pause at last event's `at`) |
| §10 clock authority / presence | Task 6 (timer) / Task 9 (presence) |
| §10 Postgres failure → pause | Store throws → dispatch rejects → clients see error; full auto-pause banner is Plan 3 UI polish |
| §11 bot simulator | Task 11 |
| §13 crit. 3 (server-side) | Task 11 replay-equivalence + Task 7 watchdog (skip-loop auto-pause) |
| Backlog: config validation at lobby boundary | Task 4 (Zod + refinements) |
| Backlog: ADD_TIME/SET_TIMERS bounds at API boundary | Task 9 (`wire.ts`) |
| Backlog: skip-loop detection → auto-pause | Tasks 6–7 (watchdog) |
| Backlog: recovery PAUSE at last event `at` | Task 7 |
| Backlog: engines/version fields, build story | Task 12 (tsx decision recorded) |
| Backlog: frozen player pool for replay determinism | Task 4 (freeze) + Task 9 (START_DRAFT interception) |

Out of scope (Plan 3): all UI, ESPN export screens, mock-draft mode, invite re-issue UI, Postgres-outage banner.

