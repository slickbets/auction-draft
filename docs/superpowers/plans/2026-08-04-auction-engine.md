# Auction Engine Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, exhaustively-tested TypeScript auction engine — every draft rule from spec §5–6 as a side-effect-free state machine.

**Architecture:** Command/event split. `execute(state, command)` validates and returns events (or a typed error); `apply(state, event)` is a pure fold that advances state; `replay(config, events)` rebuilds state from the log. No I/O, no timers, no `Date.now()` — time arrives inside commands as `now`. The server (Plan 2) hosts this module; the UI (Plan 3) renders its broadcast state.

**Tech Stack:** Node 22, TypeScript 5 (strict, ESM), npm workspaces, Vitest.

**Roadmap context:** Plan 2 (server: Socket.IO transport, Postgres event log, player sync, bot simulator) and Plan 3 (React views, exports, mock mode) are written after this plan completes. Spec: `docs/superpowers/specs/2026-08-04-auction-draft-tool-design.md`.

## Global Constraints

- Node 22.x, TypeScript 5.x with `"strict": true`, ESM (`"type": "module"`).
- Monorepo via npm workspaces; this plan only creates `packages/engine`.
- **Engine purity:** nothing in `packages/engine/src` may import Node built-ins, call `Date.now()`/`Math.random()`, or perform I/O. Current time is always `command.now` (epoch ms).
- All money values are integer whole dollars.
- League defaults (from spec): 10 teams, $200 budget, 10_000ms bid clock, 30_000ms nomination clock.
- **Max-bid invariant (spec §5):** `maxBid = budget − (openSlots − 1)`; a team's `budget ≥ openSlots` must hold after every event.
- Test runner: Vitest. `npm test` from repo root must pass at the end of every task.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Monorepo scaffold + engine package

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`
- Test: `packages/engine/tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo where `npm test` runs Vitest across workspaces and `npm run typecheck` runs `tsc --noEmit` for the engine.

- [ ] **Step 1: Write root config files**

`package.json`:
```json
{
  "name": "auction-draft",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.env
```

- [ ] **Step 2: Write engine package config**

`packages/engine/package.json`:
```json
{
  "name": "@auction/engine",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" }
}
```

`packages/engine/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write a failing smoke test**

`packages/engine/tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { ENGINE_VERSION } from '../src/index.js'

describe('engine package', () => {
  it('exports a version marker', () => {
    expect(ENGINE_VERSION).toBe(1)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm install && npm test`
Expected: FAIL — `Cannot find module '../src/index.js'` (or unresolved import).

- [ ] **Step 5: Create the module**

`packages/engine/src/index.ts`:
```ts
export const ENGINE_VERSION = 1
```

- [ ] **Step 6: Verify pass**

Run: `npm test && npm run typecheck`
Expected: 1 test PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm-workspaces monorepo with engine package

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Domain types, initial state, roster math

**Files:**
- Create: `packages/engine/src/types.ts`, `packages/engine/src/roster.ts`
- Modify: `packages/engine/src/index.ts` (re-export everything)
- Test: `packages/engine/tests/fixtures.ts`, `packages/engine/tests/roster.test.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces (used by every later task):
  - All types below, exactly as written.
  - `initialState(config: LeagueConfig): DraftState`
  - `rosterCapacity(template: SlotDef[]): number`
  - `openSlotCount(team: TeamState, cfg: LeagueConfig): number`
  - `maxBid(team: TeamState, cfg: LeagueConfig): number`
  - `firstOpenSlotFor(team: TeamState, position: Position, cfg: LeagueConfig): string | null`
  - Test fixture: `testConfig(overrides?: Partial<LeagueConfig>): LeagueConfig` and `makePlayers(perPosition: Partial<Record<Position, number>>): PlayerInfo[]`

- [ ] **Step 1: Write the types file (this is the contract for the whole engine — copy exactly)**

`packages/engine/src/types.ts`:
```ts
export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST'

export interface PlayerInfo {
  id: string
  name: string
  position: Position
  nflTeam: string
  rank: number // lower = better; drives search order and auto-nomination
}

export interface SlotDef {
  name: string // e.g. 'QB', 'FLEX', 'BENCH'
  eligible: Position[]
  count: number
}

export interface TeamConfig { id: string; name: string }

export interface LeagueConfig {
  teams: TeamConfig[]
  budget: number
  rosterTemplate: SlotDef[] // ordered; SOLD assigns to first eligible open slot
  bidClockMs: number
  nominationClockMs: number
  nominationOrder: string[] // team ids, rotation order
  nominationExpiryPolicy: 'auto_nominate' | 'skip'
  players: PlayerInfo[]
}

export interface RosterEntry { playerId: string; price: number; slot: string }

export interface TeamState { id: string; name: string; budget: number; roster: RosterEntry[] }

export interface SaleRecord {
  playerId: string
  teamId: string
  price: number
  nominatorId: string
  pointerBefore: number // nomination-order index when this auction began
  overall: number // 1-based nomination number
}

export type TimedPhase =
  | { type: 'awaiting_nomination'; teamId: string; deadline: number }
  | { type: 'bidding'; playerId: string; price: number; highBidderId: string; nominatorId: string; deadline: number }

export type Phase =
  | { type: 'lobby' }
  | TimedPhase
  | { type: 'paused'; inner: TimedPhase; remainingMs: number }
  | { type: 'complete' }

export interface DraftState {
  config: LeagueConfig
  phase: Phase
  teams: Record<string, TeamState>
  available: string[] // player ids still in the pool
  pointer: number // index into nominationOrder for the current/next nominator
  sales: SaleRecord[]
  seq: number // count of applied events
}

export type Command =
  | { type: 'START_DRAFT'; now: number }
  | { type: 'NOMINATE'; teamId: string; playerId: string; openingBid: number; now: number }
  | { type: 'BID'; teamId: string; amount: number; now: number }
  | { type: 'CLOCK_EXPIRED'; now: number }
  | { type: 'PAUSE'; now: number }
  | { type: 'RESUME'; now: number }
  | { type: 'ADD_TIME'; ms: number; now: number }
  | { type: 'SET_TIMERS'; bidClockMs?: number; nominationClockMs?: number; now: number }
  | { type: 'UNDO_SALE'; now: number }
  | { type: 'EDIT_PICK'; overall: number; newTeamId?: string; newPrice?: number; now: number }
  | { type: 'ADJUST_BUDGET'; teamId: string; delta: number; now: number }

export type DraftEvent =
  | { type: 'DRAFT_STARTED'; at: number }
  | { type: 'NOMINATION_STARTED'; teamId: string; deadline: number; at: number }
  | { type: 'PLAYER_NOMINATED'; teamId: string; playerId: string; openingBid: number; deadline: number; at: number }
  | { type: 'BID_PLACED'; teamId: string; amount: number; deadline: number; at: number }
  | { type: 'SOLD'; playerId: string; teamId: string; price: number; slot: string; nominatorId: string; pointerBefore: number; overall: number; at: number }
  | { type: 'NOMINATION_SKIPPED'; teamId: string; at: number }
  | { type: 'DRAFT_PAUSED'; remainingMs: number; at: number }
  | { type: 'DRAFT_RESUMED'; deadline: number; at: number }
  | { type: 'TIME_ADDED'; ms: number; at: number }
  | { type: 'TIMER_CONFIG_CHANGED'; bidClockMs?: number; nominationClockMs?: number; at: number }
  | { type: 'SALE_UNDONE'; sale: SaleRecord; canceledInFlightPlayerId: string | null; nominationDeadline: number; at: number }
  | { type: 'PICK_EDITED'; overall: number; fromTeamId: string; toTeamId: string; oldPrice: number; newPrice: number; newSlot: string; at: number }
  | { type: 'BUDGET_ADJUSTED'; teamId: string; delta: number; at: number }
  | { type: 'DRAFT_COMPLETED'; at: number }

export type EngineErrorCode =
  | 'NOT_IN_LOBBY'
  | 'WRONG_PHASE'
  | 'NOT_YOUR_NOMINATION'
  | 'PLAYER_NOT_AVAILABLE'
  | 'INVALID_AMOUNT'
  | 'STALE_PRICE'
  | 'EXCEEDS_MAX_BID'
  | 'ALREADY_HIGH_BIDDER'
  | 'NO_ELIGIBLE_SLOT'
  | 'CLOCK_NOT_EXPIRED'
  | 'NOTHING_TO_UNDO'
  | 'UNKNOWN_TEAM'
  | 'INVALID_EDIT'
  | 'INVALID_ADJUSTMENT'

export interface EngineError { code: EngineErrorCode; message: string }

export type ExecuteResult =
  | { ok: true; events: DraftEvent[] }
  | { ok: false; error: EngineError }
```

- [ ] **Step 2: Write the test fixture (shared by all later tasks)**

`packages/engine/tests/fixtures.ts`:
```ts
import type { LeagueConfig, PlayerInfo, Position, SlotDef } from '../src/types.js'

const ALL: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']

export const STANDARD_TEMPLATE: SlotDef[] = [
  { name: 'QB', eligible: ['QB'], count: 1 },
  { name: 'RB', eligible: ['RB'], count: 2 },
  { name: 'WR', eligible: ['WR'], count: 2 },
  { name: 'TE', eligible: ['TE'], count: 1 },
  { name: 'FLEX', eligible: ['RB', 'WR', 'TE'], count: 1 },
  { name: 'DST', eligible: ['DST'], count: 1 },
  { name: 'K', eligible: ['K'], count: 1 },
  { name: 'BENCH', eligible: ALL, count: 7 },
] // capacity 16

export function makePlayers(perPosition: Partial<Record<Position, number>>): PlayerInfo[] {
  const players: PlayerInfo[] = []
  let rank = 1
  for (const pos of ALL) {
    const n = perPosition[pos] ?? 0
    for (let i = 1; i <= n; i++) {
      players.push({ id: `${pos}${i}`, name: `${pos} Player ${i}`, position: pos, nflTeam: 'FA', rank: rank++ })
    }
  }
  return players
}

export function testConfig(overrides: Partial<LeagueConfig> = {}): LeagueConfig {
  const teams = Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
  return {
    teams,
    budget: 200,
    rosterTemplate: STANDARD_TEMPLATE,
    bidClockMs: 10_000,
    nominationClockMs: 30_000,
    nominationOrder: teams.map(t => t.id),
    nominationExpiryPolicy: 'auto_nominate',
    players: makePlayers({ QB: 25, RB: 60, WR: 60, TE: 25, K: 15, DST: 15 }),
    ...overrides,
  }
}
```

- [ ] **Step 3: Write failing tests for roster math and initial state**

`packages/engine/tests/roster.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { initialState, rosterCapacity, openSlotCount, maxBid, firstOpenSlotFor } from '../src/index.js'
import { testConfig, STANDARD_TEMPLATE } from './fixtures.js'

describe('roster math', () => {
  const cfg = testConfig()

  it('capacity sums slot counts', () => {
    expect(rosterCapacity(STANDARD_TEMPLATE)).toBe(16)
  })

  it('initialState gives every team full budget and empty roster', () => {
    const s = initialState(cfg)
    expect(Object.keys(s.teams)).toHaveLength(10)
    expect(s.teams['T1']!.budget).toBe(200)
    expect(s.teams['T1']!.roster).toEqual([])
    expect(s.phase).toEqual({ type: 'lobby' })
    expect(s.available).toHaveLength(cfg.players.length)
    expect(s.pointer).toBe(0)
    expect(s.seq).toBe(0)
  })

  it('maxBid = budget - (openSlots - 1)', () => {
    const s = initialState(cfg)
    const t1 = s.teams['T1']!
    expect(openSlotCount(t1, cfg)).toBe(16)
    expect(maxBid(t1, cfg)).toBe(185) // 200 - 15
  })

  it('assigns first eligible open slot in template order, FLEX after positional, bench last', () => {
    const s = initialState(cfg)
    const t1 = s.teams['T1']!
    expect(firstOpenSlotFor(t1, 'RB', cfg)).toBe('RB')
    t1.roster.push({ playerId: 'RB1', price: 1, slot: 'RB' }, { playerId: 'RB2', price: 1, slot: 'RB' })
    expect(firstOpenSlotFor(t1, 'RB', cfg)).toBe('FLEX')
    t1.roster.push({ playerId: 'RB3', price: 1, slot: 'FLEX' })
    expect(firstOpenSlotFor(t1, 'RB', cfg)).toBe('BENCH')
    expect(firstOpenSlotFor(t1, 'QB', cfg)).toBe('QB')
  })

  it('returns null when no slot fits', () => {
    const cfg2 = testConfig({ rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }] })
    const s = initialState(cfg2)
    expect(firstOpenSlotFor(s.teams['T1']!, 'RB', cfg2)).toBeNull()
  })
})
```

- [ ] **Step 4: Run to verify failure**

Run: `npm test`
Expected: FAIL — `initialState` (etc.) not exported.

- [ ] **Step 5: Implement**

`packages/engine/src/roster.ts`:
```ts
import type { LeagueConfig, Position, SlotDef, TeamState } from './types.js'

export function rosterCapacity(template: SlotDef[]): number {
  return template.reduce((n, s) => n + s.count, 0)
}

export function openSlotCount(team: TeamState, cfg: LeagueConfig): number {
  return rosterCapacity(cfg.rosterTemplate) - team.roster.length
}

export function maxBid(team: TeamState, cfg: LeagueConfig): number {
  return team.budget - (openSlotCount(team, cfg) - 1)
}

export function firstOpenSlotFor(team: TeamState, position: Position, cfg: LeagueConfig): string | null {
  for (const slot of cfg.rosterTemplate) {
    if (!slot.eligible.includes(position)) continue
    const used = team.roster.filter(r => r.slot === slot.name).length
    if (used < slot.count) return slot.name
  }
  return null
}
```

Add to `packages/engine/src/index.ts` (replacing its content):
```ts
export const ENGINE_VERSION = 1
export * from './types.js'
export * from './roster.js'
export * from './engine.js'
```

`packages/engine/src/engine.ts` (starts here; grows in later tasks):
```ts
import type { DraftState, LeagueConfig, TeamState } from './types.js'

export function initialState(config: LeagueConfig): DraftState {
  const teams: Record<string, TeamState> = {}
  for (const t of config.teams) {
    teams[t.id] = { id: t.id, name: t.name, budget: config.budget, roster: [] }
  }
  return {
    config,
    phase: { type: 'lobby' },
    teams,
    available: config.players.map(p => p.id),
    pointer: 0,
    sales: [],
    seq: 0,
  }
}
```

- [ ] **Step 6: Verify pass**

Run: `npm test && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(engine): domain types, initial state, roster math

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: execute/apply core + START_DRAFT + nomination rotation

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/tests/start.test.ts`

**Interfaces:**
- Consumes: Task 2 types/helpers.
- Produces:
  - `execute(state: DraftState, cmd: Command): ExecuteResult`
  - `apply(state: DraftState, event: DraftEvent): DraftState` (pure; returns new state)
  - `run(state: DraftState, cmd: Command): { ok: true; state: DraftState; events: DraftEvent[] } | { ok: false; error: EngineError }` — convenience used by tests and by the server.
  - Internal helper `nextNominationEvents(state, fromPointer, now)` reused by Tasks 6–7.

- [ ] **Step 1: Write failing tests**

`packages/engine/tests/start.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { initialState, run } from '../src/index.js'
import { testConfig } from './fixtures.js'

describe('START_DRAFT', () => {
  it('moves lobby -> awaiting_nomination for first team in order, with deadline', () => {
    const s0 = initialState(testConfig())
    const r = run(s0, { type: 'START_DRAFT', now: 1000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['DRAFT_STARTED', 'NOMINATION_STARTED'])
    expect(r.state.phase).toEqual({ type: 'awaiting_nomination', teamId: 'T1', deadline: 1000 + 30_000 })
    expect(r.state.seq).toBe(2)
  })

  it('rejects when not in lobby', () => {
    const s0 = initialState(testConfig())
    const r1 = run(s0, { type: 'START_DRAFT', now: 1000 })
    if (!r1.ok) throw new Error('setup')
    const r2 = run(r1.state, { type: 'START_DRAFT', now: 2000 })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.code).toBe('NOT_IN_LOBBY')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `run` not exported.

- [ ] **Step 3: Implement execute/apply/run skeleton**

Append to `packages/engine/src/engine.ts`:
```ts
import type { Command, DraftEvent, EngineError, ExecuteResult } from './types.js'
import { openSlotCount, rosterCapacity } from './roster.js'

function err(code: EngineError['code'], message: string): ExecuteResult {
  return { ok: false, error: { code, message } }
}

function teamIsFull(state: DraftState, teamId: string): boolean {
  const t = state.teams[teamId]
  if (!t) return true
  return openSlotCount(t, state.config) <= 0
}

/** NOMINATION_STARTED for next non-full team at/after fromPointer, or DRAFT_COMPLETED. */
export function nextNominationEvents(state: DraftState, fromPointer: number, now: number): DraftEvent[] {
  const order = state.config.nominationOrder
  const n = order.length
  for (let i = 0; i < n; i++) {
    const idx = (fromPointer + i) % n
    const teamId = order[idx]!
    if (!teamIsFull(state, teamId)) {
      return [{ type: 'NOMINATION_STARTED', teamId, deadline: now + state.config.nominationClockMs, at: now }]
    }
  }
  return [{ type: 'DRAFT_COMPLETED', at: now }]
}

export function execute(state: DraftState, cmd: Command): ExecuteResult {
  switch (cmd.type) {
    case 'START_DRAFT': {
      if (state.phase.type !== 'lobby') return err('NOT_IN_LOBBY', 'Draft already started')
      const events: DraftEvent[] = [{ type: 'DRAFT_STARTED', at: cmd.now }]
      events.push(...nextNominationEvents(state, 0, cmd.now))
      return { ok: true, events }
    }
    default:
      return err('WRONG_PHASE', `Unhandled command ${cmd.type}`)
  }
}

export function apply(state: DraftState, event: DraftEvent): DraftState {
  const s: DraftState = structuredClone(state)
  s.seq += 1
  switch (event.type) {
    case 'DRAFT_STARTED':
      return s
    case 'NOMINATION_STARTED':
      s.phase = { type: 'awaiting_nomination', teamId: event.teamId, deadline: event.deadline }
      s.pointer = s.config.nominationOrder.indexOf(event.teamId)
      return s
    case 'DRAFT_COMPLETED':
      s.phase = { type: 'complete' }
      return s
    default:
      return s
  }
}

export function run(state: DraftState, cmd: Command):
  | { ok: true; state: DraftState; events: DraftEvent[] }
  | { ok: false; error: EngineError } {
  const r = execute(state, cmd)
  if (!r.ok) return r
  let s = state
  for (const e of r.events) s = apply(s, e)
  return { ok: true, state: s, events: r.events }
}
```

Note: `structuredClone` keeps `apply` pure without an immutability library — draft state is small (KBs), and clones happen at most a few times per second. YAGNI on anything fancier.

- [ ] **Step 4: Verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(engine): execute/apply core with START_DRAFT and rotation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: NOMINATE command

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/tests/nominate.test.ts`

**Interfaces:**
- Consumes: Task 3 `run`/`nextNominationEvents`; Task 2 helpers.
- Produces: `NOMINATE` handling in `execute` + `PLAYER_NOMINATED` in `apply`. Test helper `startedDraft()` exported from `tests/helpers.ts` for later tasks.

- [ ] **Step 1: Write shared test helper**

`packages/engine/tests/helpers.ts`:
```ts
import { initialState, run, type DraftState, type Command } from '../src/index.js'
import { testConfig } from './fixtures.js'
import type { LeagueConfig } from '../src/types.js'

export function startedDraft(overrides: Partial<LeagueConfig> = {}, now = 1000): DraftState {
  const r = run(initialState(testConfig(overrides)), { type: 'START_DRAFT', now })
  if (!r.ok) throw new Error('failed to start draft')
  return r.state
}

/** Run a command that must succeed; throws (failing the test) otherwise. */
export function mustRun(s: DraftState, cmd: Command): DraftState {
  const r = run(s, cmd)
  if (!r.ok) throw new Error(`${cmd.type} failed: ${r.error.code}`)
  return r.state
}
```

- [ ] **Step 2: Write failing tests**

`packages/engine/tests/nominate.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft } from './helpers.js'

describe('NOMINATE', () => {
  it('moves to bidding with nominator as high bidder at opening price', () => {
    const s = startedDraft()
    const r = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 23, now: 2000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.phase).toEqual({
      type: 'bidding', playerId: 'RB1', price: 23, highBidderId: 'T1', nominatorId: 'T1', deadline: 2000 + 10_000,
    })
  })

  it('rejects nomination from a team not on the clock', () => {
    const s = startedDraft()
    const r = run(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'RB1', openingBid: 1, now: 2000 })
    expect(!r.ok && r.error.code).toBe('NOT_YOUR_NOMINATION')
  })

  it('rejects unavailable player, sub-$1 and non-integer bids, and bids over max', () => {
    const s = startedDraft()
    expect(!run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'NOPE', openingBid: 1, now: 2000 }).ok).toBe(true)
    const low = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 0, now: 2000 })
    expect(!low.ok && low.error.code).toBe('INVALID_AMOUNT')
    const frac = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 1.5, now: 2000 })
    expect(!frac.ok && frac.error.code).toBe('INVALID_AMOUNT')
    const high = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 186, now: 2000 })
    expect(!high.ok && high.error.code).toBe('EXCEEDS_MAX_BID') // maxBid is 185 (Task 2)
  })

  it('rejects nominating a player the team has no slot for', () => {
    const s = startedDraft({ rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }] })
    const r = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 1, now: 2000 })
    expect(!r.ok && r.error.code).toBe('NO_ELIGIBLE_SLOT')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test`
Expected: nominate tests FAIL (`WRONG_PHASE` from the default branch).

- [ ] **Step 4: Implement**

Add to the `switch` in `execute`:
```ts
    case 'NOMINATE': {
      if (state.phase.type !== 'awaiting_nomination') return err('WRONG_PHASE', 'Not awaiting a nomination')
      if (state.phase.teamId !== cmd.teamId) return err('NOT_YOUR_NOMINATION', `${state.phase.teamId} is on the clock`)
      const team = state.teams[cmd.teamId]
      if (!team) return err('UNKNOWN_TEAM', cmd.teamId)
      if (!state.available.includes(cmd.playerId)) return err('PLAYER_NOT_AVAILABLE', cmd.playerId)
      if (!Number.isInteger(cmd.openingBid) || cmd.openingBid < 1) return err('INVALID_AMOUNT', 'Opening bid must be an integer ≥ $1')
      if (cmd.openingBid > maxBid(team, state.config)) return err('EXCEEDS_MAX_BID', `Max bid ${maxBid(team, state.config)}`)
      const player = state.config.players.find(p => p.id === cmd.playerId)
      if (!player) return err('PLAYER_NOT_AVAILABLE', cmd.playerId)
      if (firstOpenSlotFor(team, player.position, state.config) === null) return err('NO_ELIGIBLE_SLOT', `No open slot for ${player.position}`)
      return {
        ok: true,
        events: [{
          type: 'PLAYER_NOMINATED', teamId: cmd.teamId, playerId: cmd.playerId,
          openingBid: cmd.openingBid, deadline: cmd.now + state.config.bidClockMs, at: cmd.now,
        }],
      }
    }
```

Add the imports `maxBid, firstOpenSlotFor` to the existing `./roster.js` import in `engine.ts`. Add to the `switch` in `apply`:
```ts
    case 'PLAYER_NOMINATED':
      s.phase = {
        type: 'bidding', playerId: event.playerId, price: event.openingBid,
        highBidderId: event.teamId, nominatorId: event.teamId, deadline: event.deadline,
      }
      return s
```

- [ ] **Step 5: Verify pass, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(engine): NOMINATE with full validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: BID command

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/tests/bid.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `BID` in `execute`, `BID_PLACED` in `apply`. Spec §5 bid rules, exactly: integer amount ≥ price+1 (`STALE_PRICE` if ≤ price), ≤ bidder's maxBid, bidder ≠ high bidder, bidder has an open eligible slot; every valid bid resets the deadline.

- [ ] **Step 1: Write failing tests**

`packages/engine/tests/bid.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

function bidding(now = 2000) {
  return mustRun(startedDraft(), { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now })
}

describe('BID', () => {
  it('valid bid raises price, sets high bidder, resets deadline', () => {
    const s = bidding()
    const r = run(s, { type: 'BID', teamId: 'T2', amount: 11, now: 5000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.phase).toMatchObject({ type: 'bidding', price: 11, highBidderId: 'T2', deadline: 15_000 })
  })

  it('rejects stale price (amount <= current)', () => {
    const s = bidding()
    const r = run(s, { type: 'BID', teamId: 'T2', amount: 10, now: 5000 })
    expect(!r.ok && r.error.code).toBe('STALE_PRICE')
  })

  it('rejects the current high bidder raising themselves', () => {
    const s = bidding()
    const r = run(s, { type: 'BID', teamId: 'T1', amount: 12, now: 5000 })
    expect(!r.ok && r.error.code).toBe('ALREADY_HIGH_BIDDER')
  })

  it('rejects bids over maxBid and non-integers', () => {
    const s = bidding()
    const over = run(s, { type: 'BID', teamId: 'T2', amount: 186, now: 5000 })
    expect(!over.ok && over.error.code).toBe('EXCEEDS_MAX_BID')
    const frac = run(s, { type: 'BID', teamId: 'T2', amount: 11.5, now: 5000 })
    expect(!frac.ok && frac.error.code).toBe('INVALID_AMOUNT')
  })

  it('rejects a bidder with no eligible open slot for the player', () => {
    const s = bidding()
    // Fill T2's only RB-capable slots so an RB no longer fits.
    const s2 = structuredClone(s)
    const t2 = s2.teams['T2']!
    t2.roster = [
      { playerId: 'RB2', price: 1, slot: 'RB' }, { playerId: 'RB3', price: 1, slot: 'RB' },
      { playerId: 'RB4', price: 1, slot: 'FLEX' },
      ...Array.from({ length: 7 }, (_, i) => ({ playerId: `WR${i + 1}`, price: 1, slot: 'BENCH' })),
    ]
    t2.budget = 190
    const r = run(s2, { type: 'BID', teamId: 'T2', amount: 11, now: 5000 })
    expect(!r.ok && r.error.code).toBe('NO_ELIGIBLE_SLOT')
  })

  it('race semantics: two bids at same amount — first wins, second gets STALE_PRICE', () => {
    const s = bidding()
    const first = run(s, { type: 'BID', teamId: 'T2', amount: 11, now: 5000 })
    if (!first.ok) throw new Error('first bid should win')
    const second = run(first.state, { type: 'BID', teamId: 'T3', amount: 11, now: 5001 })
    expect(!second.ok && second.error.code).toBe('STALE_PRICE')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: bid tests FAIL.

- [ ] **Step 3: Implement**

Add to `execute`:
```ts
    case 'BID': {
      if (state.phase.type !== 'bidding') return err('WRONG_PHASE', 'No player on the block')
      const team = state.teams[cmd.teamId]
      if (!team) return err('UNKNOWN_TEAM', cmd.teamId)
      if (!Number.isInteger(cmd.amount)) return err('INVALID_AMOUNT', 'Bids are whole dollars')
      if (cmd.amount <= state.phase.price) return err('STALE_PRICE', `Price is already $${state.phase.price}`)
      if (cmd.teamId === state.phase.highBidderId) return err('ALREADY_HIGH_BIDDER', 'You are already winning')
      if (cmd.amount > maxBid(team, state.config)) return err('EXCEEDS_MAX_BID', `Max bid ${maxBid(team, state.config)}`)
      const player = state.config.players.find(p => p.id === state.phase.playerId)!
      if (firstOpenSlotFor(team, player.position, state.config) === null) return err('NO_ELIGIBLE_SLOT', `No open slot for ${player.position}`)
      return {
        ok: true,
        events: [{ type: 'BID_PLACED', teamId: cmd.teamId, amount: cmd.amount, deadline: cmd.now + state.config.bidClockMs, at: cmd.now }],
      }
    }
```

Add to `apply`:
```ts
    case 'BID_PLACED': {
      if (s.phase.type !== 'bidding') return s
      s.phase = { ...s.phase, price: event.amount, highBidderId: event.teamId, deadline: event.deadline }
      return s
    }
```

- [ ] **Step 4: Verify pass, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(engine): BID with stale-price race semantics and eligibility

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: CLOCK_EXPIRED → SOLD, slot assignment, completion

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/tests/sold.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5; `nextNominationEvents` from Task 3.
- Produces: `CLOCK_EXPIRED` (bidding branch) in `execute`; `SOLD` in `apply`. SOLD carries `pointerBefore` and 1-based `overall`; the sale is pushed onto `state.sales` (consumed by undo/edit in Tasks 9–10 and by exports in Plan 3).

- [ ] **Step 1: Write failing tests**

`packages/engine/tests/sold.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

describe('CLOCK_EXPIRED during bidding', () => {
  it('sells to high bidder, deducts budget, assigns slot, advances nomination to T2', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now: 2000 })
    s = mustRun(s, { type: 'BID', teamId: 'T5', amount: 42, now: 4000 })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 14_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['SOLD', 'NOMINATION_STARTED'])
    const sold = r.events[0]!
    expect(sold).toMatchObject({ type: 'SOLD', playerId: 'RB1', teamId: 'T5', price: 42, slot: 'RB', overall: 1 })
    expect(r.state.teams['T5']!.budget).toBe(158)
    expect(r.state.teams['T5']!.roster).toEqual([{ playerId: 'RB1', price: 42, slot: 'RB' }])
    expect(r.state.available).not.toContain('RB1')
    expect(r.state.sales).toHaveLength(1)
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
  })

  it('unopposed nomination sells to the nominator at opening price', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 7, now: 2000 })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 12_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events[0]).toMatchObject({ type: 'SOLD', teamId: 'T1', price: 7 })
  })

  it('rejects expiry before the deadline', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 7, now: 2000 })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 11_999 })
    expect(!r.ok && r.error.code).toBe('CLOCK_NOT_EXPIRED')
  })

  it('completes the draft when the last roster spot fills', () => {
    // 2-team league with 1 QB slot each: two sales end the draft.
    const tiny = { rosterTemplate: [{ name: 'QB', eligible: ['QB' as const], count: 1 }] }
    let s = startedDraft({
      ...tiny,
      teams: [{ id: 'T1', name: 'A' }, { id: 'T2', name: 'B' }],
      nominationOrder: ['T1', 'T2'],
    })
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 1, now: 2000 })
    s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 12_000 }) // T1 full; next nominator is T2
    expect(s.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'QB2', openingBid: 1, now: 13_000 })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 23_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['SOLD', 'DRAFT_COMPLETED'])
    expect(r.state.phase).toEqual({ type: 'complete' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: sold tests FAIL.

- [ ] **Step 3: Implement**

Add to `execute` (this case also gains a nomination branch in Task 7 — the structure below anticipates it):
```ts
    case 'CLOCK_EXPIRED': {
      if (state.phase.type === 'bidding') {
        if (cmd.now < state.phase.deadline) return err('CLOCK_NOT_EXPIRED', 'Deadline not reached')
        const winner = state.teams[state.phase.highBidderId]!
        const player = state.config.players.find(p => p.id === state.phase.playerId)!
        const slot = firstOpenSlotFor(winner, player.position, state.config)!
        const sold: DraftEvent = {
          type: 'SOLD', playerId: player.id, teamId: winner.id, price: state.phase.price, slot,
          nominatorId: state.phase.nominatorId, pointerBefore: state.pointer,
          overall: state.sales.length + 1, at: cmd.now,
        }
        const after = apply(state, sold)
        return { ok: true, events: [sold, ...nextNominationEvents(after, state.pointer + 1, cmd.now)] }
      }
      if (state.phase.type === 'awaiting_nomination') {
        return err('WRONG_PHASE', 'Nomination expiry arrives in Task 7')
      }
      return err('WRONG_PHASE', 'No clock running')
    }
```

Add to `apply`:
```ts
    case 'SOLD': {
      const team = s.teams[event.teamId]!
      team.roster.push({ playerId: event.playerId, price: event.price, slot: event.slot })
      team.budget -= event.price
      s.available = s.available.filter(id => id !== event.playerId)
      s.sales.push({
        playerId: event.playerId, teamId: event.teamId, price: event.price,
        nominatorId: event.nominatorId, pointerBefore: event.pointerBefore, overall: event.overall,
      })
      return s
    }
```

- [ ] **Step 4: Verify pass, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(engine): SOLD resolution, slot assignment, draft completion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Nomination-clock expiry policy

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/tests/nomination-expiry.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces: the `awaiting_nomination` branch of `CLOCK_EXPIRED`: policy `auto_nominate` emits `PLAYER_NOMINATED` (best-ranked legal player, $1); policy `skip` emits `NOMINATION_SKIPPED` + next `NOMINATION_STARTED`. `NOMINATION_SKIPPED` handled in `apply` (no state change beyond seq). If `auto_nominate` finds no legal player for that team, it falls back to skip behavior.

- [ ] **Step 1: Write failing tests**

`packages/engine/tests/nomination-expiry.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft } from './helpers.js'

describe('nomination clock expiry', () => {
  it('auto_nominate puts the best-ranked player up at $1 for the team on the clock', () => {
    const s = startedDraft() // policy auto_nominate; best rank is QB1 (rank 1)
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 31_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events[0]).toMatchObject({ type: 'PLAYER_NOMINATED', teamId: 'T1', playerId: 'QB1', openingBid: 1 })
    expect(r.state.phase).toMatchObject({ type: 'bidding', playerId: 'QB1', price: 1, highBidderId: 'T1' })
  })

  it('skip policy passes to the next team', () => {
    const s = startedDraft({ nominationExpiryPolicy: 'skip' })
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 31_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.events.map(e => e.type)).toEqual(['NOMINATION_SKIPPED', 'NOMINATION_STARTED'])
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2', deadline: 31_000 + 30_000 })
  })

  it('rejects expiry before the nomination deadline', () => {
    const s = startedDraft()
    const r = run(s, { type: 'CLOCK_EXPIRED', now: 30_999 })
    expect(!r.ok && r.error.code).toBe('CLOCK_NOT_EXPIRED')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL (the Task 6 placeholder branch returns `WRONG_PHASE`).

- [ ] **Step 3: Implement — replace the `awaiting_nomination` branch from Task 6**

```ts
      if (state.phase.type === 'awaiting_nomination') {
        if (cmd.now < state.phase.deadline) return err('CLOCK_NOT_EXPIRED', 'Deadline not reached')
        const teamId = state.phase.teamId
        const team = state.teams[teamId]!
        if (state.config.nominationExpiryPolicy === 'auto_nominate') {
          const best = state.config.players
            .filter(p => state.available.includes(p.id) && firstOpenSlotFor(team, p.position, state.config) !== null)
            .sort((a, b) => a.rank - b.rank)[0]
          if (best) {
            return {
              ok: true,
              events: [{
                type: 'PLAYER_NOMINATED', teamId, playerId: best.id, openingBid: 1,
                deadline: cmd.now + state.config.bidClockMs, at: cmd.now,
              }],
            }
          }
          // No legal player for this team: fall through to skip.
        }
        const skipped: DraftEvent = { type: 'NOMINATION_SKIPPED', teamId, at: cmd.now }
        return { ok: true, events: [skipped, ...nextNominationEvents(state, state.pointer + 1, cmd.now)] }
      }
```

Add to `apply`:
```ts
    case 'NOMINATION_SKIPPED':
      return s
```

- [ ] **Step 4: Verify pass, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(engine): nomination expiry policies (auto-nominate / skip)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: PAUSE / RESUME / ADD_TIME / SET_TIMERS

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/tests/clock-control.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces: four commissioner clock commands and their events. Semantics (spec §6): PAUSE freezes a timed phase storing `remainingMs`; RESUME re-arms `deadline = now + remainingMs`; ADD_TIME extends the live deadline (or `remainingMs` while paused); SET_TIMERS changes config defaults used by *future* phases only.

- [ ] **Step 1: Write failing tests**

`packages/engine/tests/clock-control.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

describe('clock control', () => {
  it('pause stores remaining time; resume re-arms the deadline from now', () => {
    let s = startedDraft() // awaiting_nomination, deadline 31_000
    s = mustRun(s, { type: 'PAUSE', now: 11_000 }) // 20_000 remaining
    expect(s.phase).toMatchObject({ type: 'paused', remainingMs: 20_000 })
    const bid = run(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 1, now: 12_000 })
    expect(!bid.ok && bid.error.code).toBe('WRONG_PHASE') // nothing happens while paused
    s = mustRun(s, { type: 'RESUME', now: 60_000 })
    expect(s.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1', deadline: 80_000 })
  })

  it('ADD_TIME extends a live bidding countdown', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 5, now: 2000 }) // deadline 12_000
    s = mustRun(s, { type: 'ADD_TIME', ms: 15_000, now: 5000 })
    expect(s.phase).toMatchObject({ type: 'bidding', deadline: 27_000 })
  })

  it('ADD_TIME while paused extends remainingMs', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'PAUSE', now: 11_000 })
    s = mustRun(s, { type: 'ADD_TIME', ms: 5000, now: 12_000 })
    expect(s.phase).toMatchObject({ type: 'paused', remainingMs: 25_000 })
  })

  it('SET_TIMERS affects future phases, not the live countdown', () => {
    let s = startedDraft()
    s = mustRun(s, { type: 'SET_TIMERS', bidClockMs: 5000, now: 3000 })
    expect(s.phase).toMatchObject({ type: 'awaiting_nomination', deadline: 31_000 }) // unchanged
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 1, now: 4000 })
    expect(s.phase).toMatchObject({ type: 'bidding', deadline: 9000 }) // new 5s clock
  })

  it('cannot pause the lobby or resume a running draft', () => {
    const lobby = run(startedDraft(), { type: 'RESUME', now: 5000 })
    expect(!lobby.ok && lobby.error.code).toBe('WRONG_PHASE')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `execute`:
```ts
    case 'PAUSE': {
      if (state.phase.type !== 'awaiting_nomination' && state.phase.type !== 'bidding')
        return err('WRONG_PHASE', 'Nothing to pause')
      return { ok: true, events: [{ type: 'DRAFT_PAUSED', remainingMs: state.phase.deadline - cmd.now, at: cmd.now }] }
    }
    case 'RESUME': {
      if (state.phase.type !== 'paused') return err('WRONG_PHASE', 'Not paused')
      return { ok: true, events: [{ type: 'DRAFT_RESUMED', deadline: cmd.now + state.phase.remainingMs, at: cmd.now }] }
    }
    case 'ADD_TIME': {
      if (state.phase.type !== 'awaiting_nomination' && state.phase.type !== 'bidding' && state.phase.type !== 'paused')
        return err('WRONG_PHASE', 'No clock to extend')
      return { ok: true, events: [{ type: 'TIME_ADDED', ms: cmd.ms, at: cmd.now }] }
    }
    case 'SET_TIMERS':
      return { ok: true, events: [{ type: 'TIMER_CONFIG_CHANGED', bidClockMs: cmd.bidClockMs, nominationClockMs: cmd.nominationClockMs, at: cmd.now }] }
```

Add to `apply`:
```ts
    case 'DRAFT_PAUSED': {
      if (s.phase.type === 'awaiting_nomination' || s.phase.type === 'bidding')
        s.phase = { type: 'paused', inner: s.phase, remainingMs: event.remainingMs }
      return s
    }
    case 'DRAFT_RESUMED': {
      if (s.phase.type === 'paused') s.phase = { ...s.phase.inner, deadline: event.deadline }
      return s
    }
    case 'TIME_ADDED': {
      if (s.phase.type === 'awaiting_nomination' || s.phase.type === 'bidding')
        s.phase = { ...s.phase, deadline: s.phase.deadline + event.ms }
      else if (s.phase.type === 'paused')
        s.phase = { ...s.phase, remainingMs: s.phase.remainingMs + event.ms }
      return s
    }
    case 'TIMER_CONFIG_CHANGED': {
      if (event.bidClockMs !== undefined) s.config.bidClockMs = event.bidClockMs
      if (event.nominationClockMs !== undefined) s.config.nominationClockMs = event.nominationClockMs
      return s
    }
```

Also guard every phase-dependent command against `paused`: `NOMINATE`, `BID`, and `CLOCK_EXPIRED` already require specific phase types, so paused is rejected by their existing checks — verify the first test's `WRONG_PHASE` assertion passes.

- [ ] **Step 4: Verify pass, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(engine): pause/resume, add-time, live timer config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: UNDO_SALE

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/tests/undo.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8; `state.sales` stack from Task 6.
- Produces: `UNDO_SALE` in `execute`, `SALE_UNDONE` in `apply`. Semantics (spec §6): reverses the most recent sale — refund budget, remove roster entry, return the player (and any in-flight nominated player) to the pool, and put the undone sale's nominator back on the clock. Repeatable sequentially. Works from timed phases, paused (draft stays paused? No — undo implies re-opening; it returns to awaiting_nomination live), and `complete`.

- [ ] **Step 1: Write failing tests**

`packages/engine/tests/undo.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

function afterOneSale() {
  let s = startedDraft()
  s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now: 2000 })
  s = mustRun(s, { type: 'BID', teamId: 'T5', amount: 42, now: 4000 })
  s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 14_000 }) // sold to T5, T2 on the clock
  return s
}

describe('UNDO_SALE', () => {
  it('reverses the sale: refund, roster removal, player back in pool, nominator back on the clock', () => {
    const s = afterOneSale()
    const r = run(s, { type: 'UNDO_SALE', now: 20_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.teams['T5']!.budget).toBe(200)
    expect(r.state.teams['T5']!.roster).toEqual([])
    expect(r.state.available).toContain('RB1')
    expect(r.state.sales).toHaveLength(0)
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1', deadline: 50_000 })
  })

  it('cancels an in-flight auction too, returning that player to the pool', () => {
    let s = afterOneSale() // T2 on the clock
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'WR1', openingBid: 3, now: 16_000 })
    const r = run(s, { type: 'UNDO_SALE', now: 17_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.available).toContain('WR1')
    expect(r.state.available).toContain('RB1')
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1' })
  })

  it('rejects when there is nothing to undo', () => {
    const s = startedDraft()
    const r = run(s, { type: 'UNDO_SALE', now: 5000 })
    expect(!r.ok && r.error.code).toBe('NOTHING_TO_UNDO')
  })

  it('reopens a completed draft', () => {
    const tiny = { rosterTemplate: [{ name: 'QB', eligible: ['QB' as const], count: 1 }] }
    let s = startedDraft({ ...tiny, teams: [{ id: 'T1', name: 'A' }, { id: 'T2', name: 'B' }], nominationOrder: ['T1', 'T2'] })
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'QB1', openingBid: 1, now: 2000 })
    s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 12_000 })
    s = mustRun(s, { type: 'NOMINATE', teamId: 'T2', playerId: 'QB2', openingBid: 1, now: 13_000 })
    s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 23_000 }) // complete
    expect(s.phase.type).toBe('complete')
    const r = run(s, { type: 'UNDO_SALE', now: 30_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T2' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `execute`:
```ts
    case 'UNDO_SALE': {
      const sale = state.sales[state.sales.length - 1]
      if (!sale) return err('NOTHING_TO_UNDO', 'No sales yet')
      const canceled = state.phase.type === 'bidding' ? state.phase.playerId
        : state.phase.type === 'paused' && state.phase.inner.type === 'bidding' ? state.phase.inner.playerId
        : null
      return {
        ok: true,
        events: [{
          type: 'SALE_UNDONE', sale, canceledInFlightPlayerId: canceled,
          nominationDeadline: cmd.now + state.config.nominationClockMs, at: cmd.now,
        }],
      }
    }
```

Add to `apply`:
```ts
    case 'SALE_UNDONE': {
      const { sale } = event
      const team = s.teams[sale.teamId]!
      team.roster = team.roster.filter(r => r.playerId !== sale.playerId)
      team.budget += sale.price
      s.available.push(sale.playerId)
      if (event.canceledInFlightPlayerId) s.available.push(event.canceledInFlightPlayerId)
      s.sales = s.sales.filter(r => r.overall !== sale.overall)
      s.pointer = sale.pointerBefore
      s.phase = { type: 'awaiting_nomination', teamId: sale.nominatorId, deadline: event.nominationDeadline }
      return s
    }
```

- [ ] **Step 4: Verify pass, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(engine): undo most recent sale with full state reversal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: EDIT_PICK + ADJUST_BUDGET

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/tests/edits.test.ts`

**Interfaces:**
- Consumes: Tasks 2–9.
- Produces: `EDIT_PICK` (reassign a sale's team and/or price) and `ADJUST_BUDGET` in `execute`/`apply`. Validation rule for both: **no event may leave any team with `budget < openSlotCount`** (the Global Constraints invariant). EDIT_PICK re-slots the player on the destination team via `firstOpenSlotFor`; INVALID_EDIT if the destination has no eligible open slot or the sale doesn't exist.

- [ ] **Step 1: Write failing tests**

`packages/engine/tests/edits.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { run } from '../src/index.js'
import { startedDraft, mustRun } from './helpers.js'

function afterOneSale() {
  let s = startedDraft()
  s = mustRun(s, { type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now: 2000 })
  s = mustRun(s, { type: 'BID', teamId: 'T5', amount: 42, now: 4000 })
  s = mustRun(s, { type: 'CLOCK_EXPIRED', now: 14_000 })
  return s
}

describe('EDIT_PICK', () => {
  it('moves a sold player to another team with budget transfer and re-slotting', () => {
    const s = afterOneSale()
    const r = run(s, { type: 'EDIT_PICK', overall: 1, newTeamId: 'T3', now: 20_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.teams['T5']!.budget).toBe(200)
    expect(r.state.teams['T5']!.roster).toEqual([])
    expect(r.state.teams['T3']!.budget).toBe(158)
    expect(r.state.teams['T3']!.roster).toEqual([{ playerId: 'RB1', price: 42, slot: 'RB' }])
    expect(r.state.sales[0]).toMatchObject({ teamId: 'T3', price: 42 })
  })

  it('corrects a price in place', () => {
    const s = afterOneSale()
    const r = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 40, now: 20_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.state.teams['T5']!.budget).toBe(160)
    expect(r.state.teams['T5']!.roster[0]).toMatchObject({ price: 40 })
  })

  it('rejects unknown sales and edits that break the budget invariant', () => {
    const s = afterOneSale()
    const missing = run(s, { type: 'EDIT_PICK', overall: 99, newPrice: 5, now: 20_000 })
    expect(!missing.ok && missing.error.code).toBe('INVALID_EDIT')
    const broke = run(s, { type: 'EDIT_PICK', overall: 1, newPrice: 186, now: 20_000 })
    expect(!broke.ok && broke.error.code).toBe('INVALID_EDIT') // T5 would have budget 14 < 15 open slots
  })
})

describe('ADJUST_BUDGET', () => {
  it('applies a delta and rejects one that breaks the invariant', () => {
    const s = afterOneSale()
    const up = run(s, { type: 'ADJUST_BUDGET', teamId: 'T2', delta: 50, now: 20_000 })
    if (!up.ok) throw new Error(up.error.code)
    expect(up.state.teams['T2']!.budget).toBe(250)
    const down = run(s, { type: 'ADJUST_BUDGET', teamId: 'T2', delta: -185, now: 20_000 })
    expect(!down.ok && down.error.code).toBe('INVALID_ADJUSTMENT') // 15 < 16 open slots
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `execute`:
```ts
    case 'EDIT_PICK': {
      const sale = state.sales.find(x => x.overall === cmd.overall)
      if (!sale) return err('INVALID_EDIT', `No sale #${cmd.overall}`)
      const toId = cmd.newTeamId ?? sale.teamId
      const price = cmd.newPrice ?? sale.price
      if (!Number.isInteger(price) || price < 1) return err('INVALID_EDIT', 'Price must be an integer ≥ $1')
      const from = state.teams[sale.teamId]!
      const to = state.teams[toId]
      if (!to) return err('UNKNOWN_TEAM', toId)
      const player = state.config.players.find(p => p.id === sale.playerId)!
      // Simulate: remove from `from`, then slot on `to`.
      const fromAfter: TeamState = {
        ...from, budget: from.budget + sale.price,
        roster: from.roster.filter(r => r.playerId !== sale.playerId),
      }
      const toBase = toId === sale.teamId ? fromAfter : to
      const newSlot = firstOpenSlotFor(toBase, player.position, state.config)
      if (newSlot === null) return err('INVALID_EDIT', `${toId} has no open slot for ${player.position}`)
      const toBudgetAfter = toBase.budget - price
      const toOpenAfter = openSlotCount(toBase, state.config) - 1
      if (toBudgetAfter < toOpenAfter) return err('INVALID_EDIT', 'Edit would break the budget invariant')
      if (toId !== sale.teamId && fromAfter.budget < openSlotCount(fromAfter, state.config)) {
        return err('INVALID_EDIT', 'Edit would break the budget invariant')
      }
      return {
        ok: true,
        events: [{
          type: 'PICK_EDITED', overall: cmd.overall, fromTeamId: sale.teamId, toTeamId: toId,
          oldPrice: sale.price, newPrice: price, newSlot, at: cmd.now,
        }],
      }
    }
    case 'ADJUST_BUDGET': {
      const team = state.teams[cmd.teamId]
      if (!team) return err('UNKNOWN_TEAM', cmd.teamId)
      if (!Number.isInteger(cmd.delta)) return err('INVALID_ADJUSTMENT', 'Whole dollars only')
      if (team.budget + cmd.delta < openSlotCount(team, state.config))
        return err('INVALID_ADJUSTMENT', 'Would break the budget invariant')
      return { ok: true, events: [{ type: 'BUDGET_ADJUSTED', teamId: cmd.teamId, delta: cmd.delta, at: cmd.now }] }
    }
```

Import `TeamState` in the type-only import at the top of `engine.ts`. Add to `apply`:
```ts
    case 'PICK_EDITED': {
      const sale = s.sales.find(x => x.overall === event.overall)!
      const from = s.teams[event.fromTeamId]!
      from.roster = from.roster.filter(r => r.playerId !== sale.playerId)
      from.budget += event.oldPrice
      const to = s.teams[event.toTeamId]!
      to.roster.push({ playerId: sale.playerId, price: event.newPrice, slot: event.newSlot })
      to.budget -= event.newPrice
      sale.teamId = event.toTeamId
      sale.price = event.newPrice
      return s
    }
    case 'BUDGET_ADJUSTED': {
      s.teams[event.teamId]!.budget += event.delta
      return s
    }
```

- [ ] **Step 4: Verify pass, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(engine): commissioner pick edits and budget adjustments

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: replay() + invariant fuzz suite

**Files:**
- Modify: `packages/engine/src/engine.ts` (add `replay`)
- Test: `packages/engine/tests/replay.test.ts`, `packages/engine/tests/fuzz.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `replay(config: LeagueConfig, events: DraftEvent[]): DraftState` — the crash-recovery entry point Plan 2's server calls on boot. Plus the invariant suite: spec §13 criterion 3 ("100 consecutive full drafts without an illegal state").

- [ ] **Step 1: Write failing replay test**

`packages/engine/tests/replay.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { initialState, run, replay, type DraftEvent } from '../src/index.js'
import { testConfig } from './fixtures.js'

describe('replay', () => {
  it('rebuilds identical state from the event log', () => {
    const cfg = testConfig()
    let s = initialState(cfg)
    const log: DraftEvent[] = []
    const step = (cmd: Parameters<typeof run>[1]) => {
      const r = run(s, cmd)
      if (!r.ok) throw new Error(r.error.code)
      log.push(...r.events)
      s = r.state
    }
    step({ type: 'START_DRAFT', now: 1000 })
    step({ type: 'NOMINATE', teamId: 'T1', playerId: 'RB1', openingBid: 10, now: 2000 })
    step({ type: 'BID', teamId: 'T5', amount: 42, now: 4000 })
    step({ type: 'CLOCK_EXPIRED', now: 14_000 })
    step({ type: 'UNDO_SALE', now: 20_000 })
    step({ type: 'NOMINATE', teamId: 'T1', playerId: 'WR1', openingBid: 2, now: 25_000 })
    expect(replay(cfg, log)).toEqual(s)
  })
})
```

- [ ] **Step 2: Run to verify failure, implement, verify pass**

Run: `npm test` → FAIL (`replay` missing). Then append to `engine.ts`:
```ts
export function replay(config: LeagueConfig, events: DraftEvent[]): DraftState {
  return events.reduce(apply, initialState(config))
}
```
Run: `npm test` → PASS.

- [ ] **Step 3: Write the fuzz suite (failing only if invariants break)**

`packages/engine/tests/fuzz.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { initialState, run, openSlotCount, rosterCapacity, type DraftState, type Command } from '../src/index.js'
import { testConfig, makePlayers } from './fixtures.js'

/** Deterministic PRNG — no Math.random in tests either. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function assertInvariants(s: DraftState) {
  const cap = rosterCapacity(s.config.rosterTemplate)
  const seen = new Set<string>()
  for (const team of Object.values(s.teams)) {
    expect(team.roster.length).toBeLessThanOrEqual(cap)
    if (s.phase.type !== 'lobby') expect(team.budget).toBeGreaterThanOrEqual(openSlotCount(team, s.config))
    for (const r of team.roster) {
      expect(seen.has(r.playerId), `player ${r.playerId} on two rosters`).toBe(false)
      seen.add(r.playerId)
      expect(s.available.includes(r.playerId), `player ${r.playerId} rostered AND available`).toBe(false)
    }
  }
}

describe('fuzz: random drafts preserve invariants', () => {
  it('runs 100 seeded random drafts to completion legally', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rand = mulberry32(seed)
      // Realistic K/DST supply (NFL has 32 of each). With scarce counts, random
      // bench-hoarding can strand a K/DST starting slot with an empty pool — a real
      // edge the commissioner resolves via EDIT_PICK, but noise for this suite.
      const cfg = testConfig({ players: makePlayers({ QB: 30, RB: 60, WR: 60, TE: 30, K: 30, DST: 30 }) })
      let s = initialState(cfg)
      let now = 1000
      let r = run(s, { type: 'START_DRAFT', now })
      if (!r.ok) throw new Error('start failed')
      s = r.state
      let guard = 0
      while (s.phase.type !== 'complete' && guard++ < 20_000) {
        now += 500 + Math.floor(rand() * 2000)
        const cmd = pickCommand(s, rand, now)
        const res = run(s, cmd)
        if (res.ok) s = res.state // invalid commands are expected; engine must just reject them
        assertInvariants(s)
      }
      expect(s.phase.type).toBe('complete')
    }
  })
})

function pickCommand(s: DraftState, rand: () => number, now: number): Command {
  const teams = s.config.nominationOrder
  const teamId = teams[Math.floor(rand() * teams.length)]!
  if (s.phase.type === 'awaiting_nomination') {
    if (rand() < 0.3) return { type: 'CLOCK_EXPIRED', now: s.phase.deadline + 1 }
    const playerId = s.available[Math.floor(rand() * s.available.length)] ?? 'NONE'
    return { type: 'NOMINATE', teamId: rand() < 0.8 ? s.phase.teamId : teamId, playerId, openingBid: 1 + Math.floor(rand() * 5), now }
  }
  if (s.phase.type === 'bidding') {
    const roll = rand()
    if (roll < 0.4) return { type: 'CLOCK_EXPIRED', now: s.phase.deadline + 1 }
    if (roll < 0.45 && s.sales.length > 0) return { type: 'UNDO_SALE', now }
    return { type: 'BID', teamId, amount: s.phase.price + 1 + Math.floor(rand() * 3), now }
  }
  if (s.phase.type === 'paused') return { type: 'RESUME', now }
  return { type: 'CLOCK_EXPIRED', now }
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all PASS, including 100 fuzz drafts (runtime target: under ~30s; if slower, reduce `structuredClone` pressure by noting it as a Plan 2 perf follow-up, do not optimize now).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(engine): replay from event log + 100-draft invariant fuzz suite

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec coverage map (self-check)

| Spec section | Covered by |
|---|---|
| §5 lifecycle & phases | Tasks 3, 8 |
| §5 nomination rules | Tasks 4, 7 |
| §5 bidding rules, max-bid invariant, races | Task 5 |
| §5 SOLD, slot assignment, completion | Task 6 |
| §5 clock authority (deadlines in state, `now` in commands) | All tasks; Global Constraints |
| §6 clock control | Task 8 |
| §6 undo | Task 9 |
| §6 edit/budget | Task 10 |
| §6 proxy | Server concern (Plan 2): commissioner sends NOMINATE/BID with the target `teamId`; engine validates the team, not the sender |
| §10 replay recovery | Task 11 (`replay`); server pauses on boot (Plan 2) |
| §11 engine unit tests | Every task; fuzz in Task 11 |
| §11 bot simulator, §8 player sync, §9 exports, §7 views | Plans 2–3 (not this plan) |
