# Draft Room Client Implementation Plan (Plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The draft room people actually use — phone-first bidding, a TV board, and the commissioner controls needed to run a real draft — served same-origin by the Plan 2 server.

**Architecture:** A Vite/React SPA in `packages/web`, built into `dist/` and served as static files by the existing Express app with a SPA fallback on `/draft/:id`. The client is split so the hard part is testable without a DOM: `draftClient.ts` owns the socket, holds authoritative state by folding server events through the **engine's own `apply()`** (identical code to the server, so client and server state cannot drift), and exposes a subscribe/command API. React components are thin renderers over that client.

**Tech Stack:** React 18, TypeScript 5 strict ESM, Vite 5, socket.io-client, Vitest + @testing-library/react + jsdom (component tests) and plain Vitest/node (client-module and end-to-end tests).

**Prereqs:** Plans 1–2 merged. 113 tests green. Server exposes: handshake `auth.token` → snapshot `{ seq, state, role, teamId?, now }`, `events` `{ seq, events }`, `presence`, `notice`, and a `command` event taking `(payload, ack)` with ack `{ok:true} | {ok:false, error:{code,message}}`.

**Deadline context:** real draft Sunday 2026-09-06 1pm; full-league practice draft ~2026-08-30. Plan 4 (commissioner corrections panel, ESPN entry screen, CSV exports, invite-link management) follows this one.

---

## Design Direction

Binding for every task. Do not substitute defaults.

**Concept.** A betting board's density and tabular precision, borrowing the auction house's vocabulary — *on the block, going once, hammer price*. The characteristic moment of this product is not a roster: it is the few seconds where money and a draining clock are in tension. Every screen is built around that moment.

**Palette** (CSS custom properties, defined once in `tokens.css`):

| Token | Value | Use |
|---|---|---|
| `--pitch` | `#0B0F14` | page background — near-black with a blue-green cast |
| `--surface` | `#131A22` | cards, sheets |
| `--line` | `#1F2A35` | hairlines, dividers |
| `--ink` | `#E8EDF2` | primary text |
| `--muted` | `#8A9AAA` | labels, secondary text |
| `--brass` | `#E0A32E` | **money** — prices, budgets, the accent |
| `--siren` | `#FF4D2E` | **final seconds only** — clock urgency |
| `--sold` | `#2ED47A` | **the SOLD stamp and nothing else** |

Position chips: QB `#F0526B`, RB `#22C3A6`, WR `#3B9DFF`, TE `#F5883C`, DST `#9B8CFF`.

Green appears exactly once in the product — the moment a player sells. That scarcity is the point; do not reuse `--sold` for success toasts, valid states, or connection status.

**Type.** One variable family, **Archivo** (wght 100–900, wdth 62–125), self-hosted as a single woff2 — one file keeps a phone on bad wifi fast, and its two axes give the full range without a second face.
- Price readout: `wdth 75, wght 800`, `font-variant-numeric: tabular-nums`, clamped 4–6rem on phone.
- Player names / headings: `wdth 88, wght 700`.
- Body/UI: `wdth 100, wght 400–500`.
- Data columns on the board: `wdth 70, wght 500, tabular-nums`.
- Timestamps/log: system monospace stack; no extra font file.

**Signature.** The price readout. On every accepted bid it ticks: the number swaps with a short vertical roll, flashes `--brass`, and a `+$3` delta rises and fades beside it. Inside the final 3 seconds the block card's edge pulses `--siren` and the label reads GOING ONCE then GOING TWICE. On sale, a `--sold` stamp lands with the winning team.

**Restraint.** Those three moments (tick, urgency pulse, sold stamp) are the only animation in the product. No page transitions, no hover flourishes, no ambient motion. Everything honors `prefers-reduced-motion: reduce` by dropping to instant state changes with no movement.

**Copy.** Plain and active, in the room's own language: "On the block", "Cook leading", "You're up — nominate a player", "Max bid $131", "Sold to Cook — $47". Errors say what happened and what to do: "Someone bid $48 first. Bid again to stay in." Never "Submit", never "Error occurred".

---

## Global Constraints

- Node 22, TypeScript 5 `"strict": true`, ESM. New workspace package `packages/web` only; `packages/engine` is frozen again (no edits) and `packages/server` changes are limited to static-file serving (Task 1).
- **The client never computes draft rules itself.** Legality, prices, and roster assignment come from the engine via `apply()` or from server acks. The UI may *disable* a control it believes is illegal, but the server's ack is the truth and its rejection must always surface.
- **Never trust the device clock.** All countdowns derive from `deadline - (Date.now() + offset)` where `offset = snapshot.now - Date.now()` captured on each snapshot.
- The capability token is read from `location.hash` and never written to a path, query string, `document.title`, or any log/analytics call.
- Every interactive control is keyboard reachable with a visible focus ring; bid buttons are ≥ 44px tall and sit in the bottom third on phones.
- `npm test` from the repo root passes at the end of every task (engine fuzz ~160s and the server socket integration ~63s are normal).
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Web package, design tokens, and same-origin serving

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/ui/tokens.css`
- Modify: `packages/server/src/app.ts` (serve the built SPA), root `package.json` (scripts)
- Test: `packages/server/tests/spa.test.ts`

**Interfaces:**
- Produces: `npm run build:web` emits `packages/web/dist`. `createApp` gains optional `webDist?: string`; when set it serves those files and falls back to `index.html` for `/draft/*` so invite links resolve. `/healthz` and `/api/*` keep priority over the fallback.

- [ ] **Step 1: Package config**

`packages/web/package.json`:
```json
{
  "name": "@auction/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@auction/engine": "*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "socket.io-client": "^4.7.0"
  }
}
```

`packages/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vite/client"] },
  "include": ["src", "tests"]
}
```

`packages/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
})
```

`packages/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <title>Draft Room</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Install from the repo root: `npm install -D @vitejs/plugin-react vite @testing-library/react @testing-library/user-event jsdom @types/react @types/react-dom`

- [ ] **Step 2: Design tokens**

`packages/web/src/ui/tokens.css` — the palette, type scale, and the three permitted animations:
```css
:root {
  --pitch: #0B0F14;
  --surface: #131A22;
  --line: #1F2A35;
  --ink: #E8EDF2;
  --muted: #8A9AAA;
  --brass: #E0A32E;
  --siren: #FF4D2E;
  --sold: #2ED47A;

  --pos-qb: #F0526B;
  --pos-rb: #22C3A6;
  --pos-wr: #3B9DFF;
  --pos-te: #F5883C;
  --pos-dst: #9B8CFF;

  --step: 8px;
  --radius: 10px;
  --font: 'Archivo', system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

* { box-sizing: border-box; }

html, body, #root { height: 100%; }

body {
  margin: 0;
  background: var(--pitch);
  color: var(--ink);
  font-family: var(--font);
  font-variation-settings: 'wdth' 100, 'wght' 400;
  -webkit-text-size-adjust: 100%;
}

.numerals { font-variant-numeric: tabular-nums; font-variation-settings: 'wdth' 75, 'wght' 800; }
.label { color: var(--muted); font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; }
.name { font-variation-settings: 'wdth' 88, 'wght' 700; }

:where(button, a, input, [tabindex]):focus-visible {
  outline: 2px solid var(--brass);
  outline-offset: 2px;
}

@keyframes tick-roll { from { transform: translateY(0.25em); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes delta-rise { from { transform: none; opacity: 1; } to { transform: translateY(-1.2em); opacity: 0; } }
@keyframes urgency { 50% { box-shadow: 0 0 0 2px var(--siren) inset; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
}
```

`packages/web/src/main.tsx` (placeholder until Task 3):
```tsx
import { createRoot } from 'react-dom/client'
import './ui/tokens.css'

createRoot(document.getElementById('root')!).render(<div className="label">Draft room</div>)
```

- [ ] **Step 3: Failing server test**

`packages/server/tests/spa.test.ts`:
```ts
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
```

Run: `npx vitest run packages/server/tests/spa.test.ts` → FAIL.

- [ ] **Step 4: Implement serving**

In `packages/server/src/app.ts`: add `webDist?: string` to `AppDeps`, and AFTER the `/healthz` and `/api/*` routes are registered:
```ts
  if (deps.webDist) {
    app.use(express.static(deps.webDist))
    app.get('/draft/*', (_req, res) => {
      res.sendFile('index.html', { root: deps.webDist! })
    })
  }
```

In `packages/server/src/main.ts`'s `buildServer`, pass `webDist` through from an env var. Add to `env.ts`: `WEB_DIST: z.string().optional()`, and in `buildServer`: `createApp({ ..., webDist: env.WEB_DIST })`.

Root `package.json` scripts: add `"build": "npm run build --workspace @auction/web"` and leave `"start"` as `"tsx packages/server/src/main.ts"`.

**Do not move the build into `start`.** Railway/Nixpacks runs `npm run build` at build time and `npm start` at boot; building on boot would delay the healthcheck on every restart — including a mid-draft crash recovery, which is the worst possible moment to spend time bundling. `WEB_DIST` then points at `packages/web/dist` (add it to `.env.example` and to `docs/DEPLOY.md`'s variable list in Task 1).

- [ ] **Step 5: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(web): scaffold client package, design tokens, same-origin serving

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: draftClient — socket, state, and the server clock

**Files:**
- Create: `packages/web/src/client/draftClient.ts`
- Test: `packages/web/tests/draftClient.test.ts`

**Interfaces:**
- Consumes: engine `apply`, `initialState`-free (state always arrives from a snapshot).
- Produces (every view depends on this exact surface):
  ```ts
  export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'rejected'
  export interface DraftView {
    status: ConnectionStatus
    seq: number
    state: DraftState | null
    role: 'commissioner' | 'board' | 'manager' | null
    teamId: string | null
    presence: { role: string; teamId?: string }[]
    notice: { type: 'skip_loop' | 'clock_stalled' } | null
    lastError: { code: string; message: string } | null
  }
  export interface DraftClient {
    subscribe(fn: (v: DraftView) => void): () => void
    get view(): DraftView
    send(cmd: WireCommand): Promise<Ack>
    msLeft(deadline: number): number   // server-corrected
    dismissError(): void
    close(): void
  }
  export function createDraftClient(opts: { url?: string; token: string; io?: SocketFactory }): DraftClient
  ```
- Behavior: applies `events` in `seq` order and **ignores a batch whose seq is not `view.seq + n`** — a gap means the socket missed something, so the client requests nothing and waits for the next snapshot (reconnect always sends one). `snapshot` replaces state wholesale and recomputes the clock offset. A `command` ack that fails sets `lastError` (cleared by `dismissError` or the next successful command).

- [ ] **Step 1: Failing test (real server, no DOM)**

`packages/web/tests/draftClient.test.ts` — drives the actual server, so the protocol is verified end to end.

**Resolution note:** this test imports server sources across packages by relative path (`../../server/src/main.js`). Confirm that resolves under the web package's own vitest config before writing the rest of the file; if it does not, add `"@auction/server": "*"` to `packages/web`'s `devDependencies`, run `npm install`, and import via the package name. Do not work around it by duplicating server code into the web package.
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import { buildServer } from '../../server/src/main.js'
import { LeagueService } from '../../server/src/league.js'
import { PlayerRepo } from '../../server/src/players.js'
import { createDraftClient, type DraftClient } from '../src/client/draftClient.js'

const CONFIG = {
  teams: [{ id: 'T1', name: 'Cook' }, { id: 'T2', name: 'Dave' }],
  budget: 200,
  rosterTemplate: [{ name: 'QB', eligible: ['QB'], count: 1 }, { name: 'BENCH', eligible: ['QB', 'RB'], count: 1 }],
  bidClockMs: 60_000,
  nominationClockMs: 60_000,
  nominationOrder: ['T1', 'T2'],
  nominationExpiryPolicy: 'auto_nominate',
}
const PLAYERS = [
  { sleeperId: 'q1', name: 'QB One', position: 'QB' as const, nflTeam: 'SF', status: 'Active', searchRank: 1 },
  { sleeperId: 'q2', name: 'QB Two', position: 'QB' as const, nflTeam: 'KC', status: 'Active', searchRank: 2 },
  { sleeperId: 'r1', name: 'RB One', position: 'RB' as const, nflTeam: 'ATL', status: 'Active', searchRank: 3 },
  { sleeperId: 'r2', name: 'RB Two', position: 'RB' as const, nflTeam: 'DAL', status: 'Active', searchRank: 4 },
]

function memPool() {
  const db = newDb()
  const { Pool } = db.adapters.createPg()
  return new Pool() as any
}
const settled = (c: DraftClient, p: (v: any) => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    if (p(c.view)) return resolve()
    const t = setTimeout(() => reject(new Error(`condition not met; view=${JSON.stringify(c.view.status)}`)), ms)
    const un = c.subscribe(v => { if (p(v)) { clearTimeout(t); un(); resolve() } })
  })

describe('draftClient', () => {
  let server: Awaited<ReturnType<typeof buildServer>>
  let url: string
  let links: any
  const clients: DraftClient[] = []

  beforeEach(async () => {
    const pool = memPool()
    server = await buildServer(
      { DATABASE_URL: 'unused', PORT: 0, BASE_URL: 'http://localhost', CREATE_KEY: 'k', SLEEPER_SYNC: '0' } as any,
      pool,
    )
    await new Promise<void>(r => server.http.listen(0, r))
    url = `http://localhost:${(server.http.address() as any).port}`
    await new PlayerRepo(pool).upsertAll(PLAYERS)
    links = (await new LeagueService(pool, url).create('Sim', CONFIG)).links
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close()
    await server.close()
  })

  const open = (link: string) => {
    const c = createDraftClient({ url, token: link.split('#')[1]! })
    clients.push(c)
    return c
  }

  it('connects, snapshots, and reports role and team', async () => {
    const c = open(links.teams[0].url)
    await settled(c, v => v.status === 'live')
    expect(c.view.role).toBe('manager')
    expect(c.view.teamId).toBe('T1')
    expect(c.view.state!.phase.type).toBe('lobby')
  })

  it('rejects a bad token instead of hanging', async () => {
    const c = createDraftClient({ url, token: 'garbage' })
    clients.push(c)
    await settled(c, v => v.status === 'rejected')
    expect(c.view.state).toBeNull()
  })

  it('folds broadcast events so every client converges on identical state', async () => {
    const commish = open(links.commissioner)
    const mgr = open(links.teams[0].url)
    await settled(commish, v => v.status === 'live')
    await settled(mgr, v => v.status === 'live')
    expect((await commish.send({ type: 'START_DRAFT' })).ok).toBe(true)
    await settled(mgr, v => v.state?.phase.type === 'awaiting_nomination')
    expect(mgr.view.state).toStrictEqual(commish.view.state)
    expect(mgr.view.seq).toBe(commish.view.seq)
  })

  it('surfaces a rejected command without corrupting state', async () => {
    const mgr = open(links.teams[0].url)
    await settled(mgr, v => v.status === 'live')
    const before = mgr.view.state
    const ack = await mgr.send({ type: 'NOMINATE', teamId: 'T1', playerId: 'q1', openingBid: 5 })
    expect(ack.ok).toBe(false)
    expect(mgr.view.lastError?.code).toBeTruthy()
    expect(mgr.view.state).toStrictEqual(before)
    mgr.dismissError()
    expect(mgr.view.lastError).toBeNull()
  })

  it('corrects for a skewed device clock', async () => {
    const c = open(links.teams[0].url)
    await settled(c, v => v.status === 'live')
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 60_000 // device runs a minute fast
      const deadline = realNow() + 10_000
      expect(c.msLeft(deadline)).toBeGreaterThan(8_000)
      expect(c.msLeft(deadline)).toBeLessThanOrEqual(10_000)
    } finally {
      Date.now = realNow
    }
  })

  it('reports presence for connected seats', async () => {
    const a = open(links.teams[0].url)
    const b = open(links.teams[1].url)
    await settled(a, v => v.status === 'live')
    await settled(b, v => v.status === 'live')
    await settled(a, v => v.presence.some(p => p.teamId === 'T2'))
    expect(a.view.presence.filter(p => p.teamId === 'T1')).toHaveLength(1)
  })
})
```

Run: `npx vitest run packages/web` → FAIL (module missing).

- [ ] **Step 2: Implement**

`packages/web/src/client/draftClient.ts`:
```ts
import { io as ioClient, type Socket } from 'socket.io-client'
import { apply } from '@auction/engine'
import type { DraftEvent, DraftState } from '@auction/engine'

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'rejected'
export type Role = 'commissioner' | 'board' | 'manager'
export type Ack = { ok: true } | { ok: false; error: { code: string; message: string } }
export type WireCommand = Record<string, unknown> & { type: string }

export interface DraftView {
  status: ConnectionStatus
  seq: number
  state: DraftState | null
  role: Role | null
  teamId: string | null
  presence: { role: string; teamId?: string }[]
  notice: { type: 'skip_loop' | 'clock_stalled' } | null
  lastError: { code: string; message: string } | null
}

export interface DraftClient {
  subscribe(fn: (v: DraftView) => void): () => void
  readonly view: DraftView
  send(cmd: WireCommand): Promise<Ack>
  msLeft(deadline: number): number
  dismissError(): void
  close(): void
}

export type SocketFactory = (url: string, opts: { auth: { token: string } }) => Socket

export function createDraftClient(opts: { url?: string; token: string; io?: SocketFactory }): DraftClient {
  const url = opts.url ?? window.location.origin
  const factory: SocketFactory = opts.io ?? ((u, o) => ioClient(u, { ...o, transports: ['websocket'] }))

  let view: DraftView = {
    status: 'connecting', seq: 0, state: null, role: null, teamId: null,
    presence: [], notice: null, lastError: null,
  }
  const subs = new Set<(v: DraftView) => void>()
  /** serverNow - deviceNow, captured on every snapshot. Never trust the device clock. */
  let offset = 0

  const set = (patch: Partial<DraftView>) => {
    view = { ...view, ...patch }
    for (const fn of subs) fn(view)
  }

  const socket = factory(url, { auth: { token: opts.token } })

  socket.on('connect_error', () => set({ status: 'rejected', state: null }))
  socket.on('disconnect', () => set({ status: 'reconnecting' }))

  socket.on('snapshot', (s: { seq: number; state: DraftState; role: Role; teamId?: string; now?: number }) => {
    if (typeof s.now === 'number') offset = s.now - Date.now()
    set({
      status: 'live', seq: s.seq, state: s.state, role: s.role,
      teamId: s.teamId ?? null, lastError: null,
    })
  })

  socket.on('events', (batch: { seq: number; events: DraftEvent[] }) => {
    if (!view.state) return
    // A gap means we missed a broadcast; discard rather than apply out of order.
    // Any reconnect delivers a fresh snapshot, which is the recovery path.
    if (batch.seq - batch.events.length !== view.seq) return
    let next = view.state
    for (const e of batch.events) next = apply(next, e)
    set({ state: next, seq: batch.seq })
  })

  socket.on('presence', (p: { connected: { role: string; teamId?: string }[] }) => set({ presence: p.connected }))
  socket.on('notice', (n: { type: 'skip_loop' | 'clock_stalled' }) => set({ notice: n }))

  return {
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    get view() {
      return view
    },
    send(cmd) {
      return new Promise<Ack>(resolve => {
        socket.emit('command', cmd, (ack: Ack) => {
          set(ack.ok ? { lastError: null } : { lastError: ack.error })
          resolve(ack)
        })
      })
    },
    msLeft(deadline) {
      return Math.max(0, deadline - (Date.now() + offset))
    },
    dismissError() {
      set({ lastError: null })
    },
    close() {
      socket.close()
      subs.clear()
    },
  }
}
```

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(web): draft client with event folding and server-corrected clock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: App shell — token, hook, connection states, role routing

**Files:**
- Create: `packages/web/src/App.tsx`, `packages/web/src/useDraft.ts`, `packages/web/src/ui/Screen.tsx`, `packages/web/tests/helpers/fakeClient.ts`, `packages/web/tests/App.test.tsx`
- Modify: `packages/web/src/main.tsx`
- Create: `packages/web/vitest.config.ts` (jsdom for `tests/*.test.tsx` only)

**Interfaces:**
- Produces:
  - `readToken(): string | null` — from `location.hash`, stripping `#`. Returns null when absent.
  - `useDraft(client: DraftClient): DraftView` — subscribes via `useSyncExternalStore`.
  - `<App client={client} />` — renders by `view.status` then `view.role`: `rejected` → a plain "this link isn't valid" screen; `connecting` → "Joining the draft room…"; `reconnecting` → the last known screen with a persistent reconnect banner (never a blank screen — losing wifi mid-auction must not wipe the board); `live` → `BoardView` when role is `board`, else `ManagerView` (with `CommissionerBar` when role is commissioner).
  - `tests/helpers/fakeClient.ts` exports `makeFakeClient(initial?: Partial<DraftView>)` → `{ client, push(patch), sent: WireCommand[], ack: (a: Ack) => void }` so component tests drive states without a socket.

- [ ] **Step 1: Vitest config for DOM tests**

`packages/web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [['tests/**/*.test.tsx', 'jsdom']],
  },
})
```

- [ ] **Step 2: Failing tests**

`packages/web/tests/helpers/fakeClient.ts`:
```ts
import type { Ack, DraftClient, DraftView, WireCommand } from '../../src/client/draftClient.js'

export function makeFakeClient(initial: Partial<DraftView> = {}) {
  let view: DraftView = {
    status: 'live', seq: 0, state: null, role: 'manager', teamId: 'T1',
    presence: [], notice: null, lastError: null, ...initial,
  }
  const subs = new Set<(v: DraftView) => void>()
  const sent: WireCommand[] = []
  let nextAck: Ack = { ok: true }
  const client: DraftClient = {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
    get view() { return view },
    async send(cmd) { sent.push(cmd); return nextAck },
    msLeft(deadline) { return Math.max(0, deadline - Date.now()) },
    dismissError() { push({ lastError: null }) },
    close() { subs.clear() },
  }
  function push(patch: Partial<DraftView>) {
    view = { ...view, ...patch }
    for (const fn of [...subs]) fn(view)
  }
  return { client, push, sent, ack: (a: Ack) => { nextAck = a } }
}
```

`packages/web/tests/App.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { App } from '../src/App.js'
import { readToken } from '../src/useDraft.js'
import { makeFakeClient } from './helpers/fakeClient.js'

describe('readToken', () => {
  it('reads the capability token from the URL fragment', () => {
    window.location.hash = '#abc123'
    expect(readToken()).toBe('abc123')
    window.location.hash = ''
    expect(readToken()).toBeNull()
  })
})

describe('App', () => {
  it('explains an invalid link instead of hanging', () => {
    const { client } = makeFakeClient({ status: 'rejected', state: null })
    render(<App client={client} />)
    expect(screen.getByText(/link/i)).toBeTruthy()
  })

  it('keeps the last screen visible while reconnecting', () => {
    const { client, push } = makeFakeClient({ state: { phase: { type: 'lobby' } } as any })
    render(<App client={client} />)
    act(() => push({ status: 'reconnecting' }))
    expect(screen.getByText(/reconnecting/i)).toBeTruthy()
    // the draft screen is still mounted underneath, not replaced by a spinner
    expect(screen.queryByText(/joining the draft room/i)).toBeNull()
  })
})
```

Run: `npx vitest run packages/web` → FAIL.

- [ ] **Step 3: Implement**

`packages/web/src/useDraft.ts`:
```ts
import { useSyncExternalStore } from 'react'
import type { DraftClient, DraftView } from './client/draftClient.js'

export function readToken(): string | null {
  const raw = window.location.hash.replace(/^#/, '').trim()
  return raw.length > 0 ? raw : null
}

export function useDraft(client: DraftClient): DraftView {
  return useSyncExternalStore(
    cb => client.subscribe(cb),
    () => client.view,
  )
}
```

`packages/web/src/ui/Screen.tsx` — the shared frame plus the reconnect banner:
```tsx
import type { ReactNode } from 'react'

export function Screen({ banner, children }: { banner?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      {banner}
      {children}
    </div>
  )
}

export function Banner({ tone, children }: { tone: 'warn' | 'info'; children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: 'calc(var(--step) * 1.5)',
        background: tone === 'warn' ? 'var(--siren)' : 'var(--surface)',
        color: tone === 'warn' ? '#1A0A06' : 'var(--ink)',
        fontWeight: 600,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  )
}
```

`packages/web/src/App.tsx`:
```tsx
import type { DraftClient } from './client/draftClient.js'
import { useDraft } from './useDraft.js'
import { Screen, Banner } from './ui/Screen.js'
import { ManagerView } from './views/ManagerView.js'
import { BoardView } from './views/BoardView.js'

export function App({ client }: { client: DraftClient }) {
  const view = useDraft(client)

  if (view.status === 'rejected') {
    return (
      <Screen>
        <div style={{ padding: 'calc(var(--step) * 3)' }}>
          <h1 className="name">This link isn't valid</h1>
          <p style={{ color: 'var(--muted)' }}>
            Ask the commissioner to re-send your invite link. Open it exactly as sent — the part after the # is what
            identifies your team.
          </p>
        </div>
      </Screen>
    )
  }

  if (!view.state) {
    return (
      <Screen>
        <div style={{ padding: 'calc(var(--step) * 3)' }} className="label">
          Joining the draft room…
        </div>
      </Screen>
    )
  }

  const banner = view.status === 'reconnecting' ? <Banner tone="warn">Reconnecting — your bids are safe</Banner> : undefined

  return (
    <Screen banner={banner}>
      {view.role === 'board' ? <BoardView view={view} /> : <ManagerView client={client} view={view} />}
    </Screen>
  )
}
```

`packages/web/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import './ui/tokens.css'
import { App } from './App.js'
import { createDraftClient } from './client/draftClient.js'
import { readToken } from './useDraft.js'

const token = readToken()
const root = createRoot(document.getElementById('root')!)
if (!token) {
  root.render(<div style={{ padding: 24 }}>Open the invite link you were sent — it ends in a # and a code.</div>)
} else {
  root.render(<App client={createDraftClient({ token })} />)
}
```

Create minimal placeholder `views/ManagerView.tsx` and `views/BoardView.tsx` exporting components that render their role name, to be filled in by later tasks.

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run typecheck` → green.

```bash
git add -A
git commit -m "feat(web): app shell with token handling and connection states

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Primitives — money, position, countdown, sheet

**Files:**
- Create: `packages/web/src/ui/Money.tsx`, `packages/web/src/ui/PositionChip.tsx`, `packages/web/src/ui/Countdown.tsx`, `packages/web/src/ui/Sheet.tsx`, `packages/web/src/ui/Button.tsx`
- Test: `packages/web/tests/primitives.test.tsx`

**Interfaces:**
- `<Money value={47} size="hero" | "row" | "inline" />` — tabular numerals, `--brass`, `$` prefix rendered at 0.5em and `--muted`.
- `<PositionChip position="RB" />` — the position color set; text is the position abbreviation.
- `<Countdown msLeft={n} totalMs={m} />` — a draining bar plus whole seconds. Phases: normal; `urgent` under 3s (bar and digits `--siren`, `urgency` animation on the parent card via a returned `phase`); expired shows `0`. Exposes `phaseFor(msLeft)` as a pure exported function so tests and cards share one definition.
- `<Sheet open onClose title>` — bottom sheet for roster/all-teams; focus-trapped, Escape closes, `aria-modal`.
- `<Button variant="bid" | "ghost" | "danger" disabled reason>` — when `disabled` and `reason` is set, the reason renders beneath in `--muted` (never a bare disabled control).

- [ ] **Step 1: Failing tests**

`packages/web/tests/primitives.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Money } from '../src/ui/Money.js'
import { Countdown, phaseFor } from '../src/ui/Countdown.js'
import { Button } from '../src/ui/Button.js'

describe('Money', () => {
  it('renders whole dollars with tabular numerals', () => {
    const { container } = render(<Money value={47} size="hero" />)
    expect(screen.getByText('47')).toBeTruthy()
    expect(container.querySelector('.numerals')).toBeTruthy()
  })
})

describe('Countdown', () => {
  it('classifies urgency by remaining time', () => {
    expect(phaseFor(9_000)).toBe('normal')
    expect(phaseFor(2_900)).toBe('urgent')
    expect(phaseFor(0)).toBe('expired')
  })

  it('shows whole seconds remaining', () => {
    render(<Countdown msLeft={6_200} totalMs={10_000} />)
    expect(screen.getByText('7')).toBeTruthy() // ceil, so a live clock never shows 0 early
  })
})

describe('Button', () => {
  it('explains why it is disabled instead of going silently dead', () => {
    render(<Button variant="bid" disabled reason="Max bid $14">+$5</Button>)
    expect(screen.getByRole('button')).toHaveProperty('disabled', true)
    expect(screen.getByText('Max bid $14')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Implement**

`Countdown.tsx` (the shared phase definition matters — cards key their urgency animation off it):
```tsx
export type ClockPhase = 'normal' | 'urgent' | 'expired'

export function phaseFor(msLeft: number): ClockPhase {
  if (msLeft <= 0) return 'expired'
  return msLeft <= 3_000 ? 'urgent' : 'normal'
}

export function Countdown({ msLeft, totalMs }: { msLeft: number; totalMs: number }) {
  const phase = phaseFor(msLeft)
  const pct = totalMs > 0 ? Math.max(0, Math.min(1, msLeft / totalMs)) : 0
  const color = phase === 'normal' ? 'var(--brass)' : 'var(--siren)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--step)' }}>
      <div
        aria-hidden
        style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }}
      >
        <div style={{ width: `${pct * 100}%`, height: '100%', background: color, transition: 'width 120ms linear' }} />
      </div>
      <span className="numerals" style={{ fontSize: '1.25rem', color, minWidth: '2ch', textAlign: 'right' }}>
        {Math.ceil(msLeft / 1000)}
      </span>
      <span className="label" aria-live="off">sec</span>
    </div>
  )
}
```

Write the remaining primitives to the interface above, deriving every color and size from `tokens.css` custom properties — no hard-coded hex values in components.

- [ ] **Step 3: Verify + commit**

```bash
git add -A
git commit -m "feat(web): design primitives for money, position, clock, sheets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: ManagerView shell — lobby, your turn, waiting, complete

**Files:**
- Create: `packages/web/src/views/ManagerView.tsx`, `packages/web/src/views/StatusHeader.tsx`
- Test: `packages/web/tests/ManagerView.test.tsx`

**Interfaces:**
- `<ManagerView client view />` renders by `view.state.phase.type`:
  - `lobby` — "Waiting for the commissioner to start" plus the connected-seat list (deduped by teamId, per Plan 2's backlog).
  - `awaiting_nomination` — if it's your team: the nomination flow (Task 8). Otherwise: "Cook is picking someone to nominate" with the nomination countdown.
  - `bidding` — the block card (Task 6) plus bid controls (Task 7).
  - `paused` — "Draft paused by the commissioner", showing the frozen remaining time.
  - `complete` — "Draft complete" and the final roster.
- `<StatusHeader view />` is always mounted for managers: budget left, max bid, open slots — the three numbers a bidder needs without doing arithmetic. Uses engine `maxBid` and `openSlotCount` against the viewer's own team.

- [ ] **Step 1: Failing tests** covering each phase branch, that a manager sees their own max bid in the header, and that presence is deduped when the same team is open on two devices.

- [ ] **Step 2: Implement**, deriving all numbers from the engine (`maxBid`, `openSlotCount`, `rosterCapacity`) rather than recomputing them in the view.

- [ ] **Step 3: Verify + commit** — `feat(web): manager view phases and status header`.

---

### Task 6: The block card — the signature moment

**Files:**
- Create: `packages/web/src/views/BlockCard.tsx`, `packages/web/src/ui/useTick.ts`
- Test: `packages/web/tests/BlockCard.test.tsx`

**Interfaces:**
- `<BlockCard view msLeft totalMs />` renders the player on the block: position chip, name, NFL team, the hero price, who leads, and the countdown.
- `useTick(value: number)` returns `{ delta, key }` — the change since the previous render and a key that remounts the number so the roll animation replays. Delta clears after 900ms.
- Behavior:
  - Price change → number replays `tick-roll`, `+$N` delta rises and fades (`delta-rise`).
  - `phaseFor(msLeft) === 'urgent'` → card edge runs the `urgency` animation and the label reads **GOING ONCE** (≤3s) then **GOING TWICE** (≤1.5s).
  - When the viewer is the high bidder the leader line reads "You're leading" in `--brass`.
  - A live region announces price changes once per change for screen readers, not on every render.
  - All three animations must be inert under `prefers-reduced-motion` (already handled globally in tokens.css — verify with a test that asserts the class/state still changes so behavior does not depend on animation).

- [ ] **Step 1: Failing tests** — price tick shows the delta; urgency copy appears at the right thresholds; "You're leading" only for the high bidder; the announcement fires once per price change.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify + commit** — `feat(web): block card with price tick and closing-seconds urgency`.

---

### Task 7: Bid controls with guardrails

**Files:**
- Create: `packages/web/src/views/BidControls.tsx`, `packages/web/src/bidRules.ts`
- Test: `packages/web/tests/BidControls.test.tsx`

**Interfaces:**
- `bidRules.ts` exports `bidState(view, amount): { allowed: boolean; reason?: string }` — a pure function over engine helpers (`maxBid`, `firstOpenSlotFor`) that mirrors the server's rules for *display only*: already leading ("You're leading"), over max ("Max bid $131"), no slot for that position ("No open spot for a RB"), or draft not in bidding.
- `<BidControls client view />` — `+$1` and `+$5` buttons labelled with the resulting price (`+$1 → 48`), a custom-amount entry, all in the bottom third with ≥44px targets. Submitting sends `{ type: 'BID', teamId, amount }`.
- **Server truth:** a rejected ack surfaces as a short message tied to the code — `STALE_PRICE` → "Someone bid $48 first. Bid again to stay in." `EXCEEDS_MAX_BID` → "That's over your max bid." `NO_ELIGIBLE_SLOT` → "You have no open spot for a RB." Buttons re-enable immediately after a rejection so a manager can re-raise instantly.
- Never disable purely on local state where a race is possible: the +$1 button stays live when the price changes under the user; only structurally impossible bids (no slot, no money) are disabled.

- [ ] **Step 1: Failing tests** — each disabled reason renders; the buttons show resulting prices; a `STALE_PRICE` rejection shows the re-raise message and leaves the control usable; the sent command carries the viewer's own teamId.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify + commit** — `feat(web): bid controls with explained guardrails`.

---

### Task 8: Nomination flow

**Files:**
- Create: `packages/web/src/views/NominateSheet.tsx`, `packages/web/src/playerSearch.ts`
- Test: `packages/web/tests/NominateSheet.test.tsx`

**Interfaces:**
- `playerSearch.ts` exports `searchPlayers(state, viewerTeamId, query, limit = 40)`: available players only, filtered to those the viewer can actually roster (`firstOpenSlotFor !== null`, which is what keeps kickers and capped positions out), ranked by engine rank, name-matched case-insensitively on a substring.
- `<NominateSheet client view />` — search field, results as position-chipped rows, an opening-bid stepper defaulting to $1 with the viewer's max as ceiling, and a single "Nominate" action. Sends `{ type: 'NOMINATE', teamId, playerId, openingBid }`.
- The nomination countdown is visible throughout; at expiry the server auto-nominates, and the sheet closes on the resulting phase change rather than fighting it.

- [ ] **Step 1: Failing tests** — a capped position and kickers never appear in results; results are rank-ordered; the opening bid cannot exceed max; nominating sends the right command.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify + commit** — `feat(web): nomination search and opening bid`.

---

### Task 9: Roster and all-teams sheets

**Files:**
- Create: `packages/web/src/views/RosterSheet.tsx`, `packages/web/src/views/TeamsSheet.tsx`
- Test: `packages/web/tests/sheets.test.tsx`

**Interfaces:**
- `<RosterSheet view teamId />` — the viewer's roster grouped by slot in template order, each filled row showing player, position chip and price; empty slots shown as outlines so "what do I still need" is answerable at a glance. Footer: spent, remaining, max bid.
- `<TeamsSheet view />` — every team with remaining budget and open slots, sorted by budget descending (who can still outbid me is the question this answers).
- Both reachable from the persistent footer links under the bid controls; both are `Sheet`s, so Escape and a visible close control dismiss them.

- [ ] **Step 1: Failing tests** — empty slots render for an unfilled roster; prices show; teams sort by remaining budget.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify + commit** — `feat(web): roster and all-teams sheets`.

---

### Task 10: Board view for the TV

**Files:**
- Create: `packages/web/src/views/BoardView.tsx`, `packages/web/src/views/SoldTicker.tsx`
- Test: `packages/web/tests/BoardView.test.tsx`

**Interfaces:**
- Full-bleed dark layout, readable from across a room: three bands — the block spotlight (player, hero price at the largest scale in the product, leader, countdown), a 10-row team grid (name, remaining budget, filled/open slot pips by position), and a sold ticker of the most recent sales.
- `<SoldTicker sales players />` — newest first, "Bijan Robinson → Cook · $47", capped at the last 8.
- GOING ONCE / GOING TWICE render here at display scale — this is the callout the room reacts to.
- No interactivity at all: the board token cannot send commands, so the view must render no buttons.
- Scales by viewport: type sized in `clamp()` against `vmin` so a 55" TV and a laptop both work without configuration.

- [ ] **Step 1: Failing tests** — every team appears with its budget; the ticker shows the latest sale first; no `button` elements exist anywhere in the rendered board.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify + commit** — `feat(web): tv board view`.

---

### Task 11: Commissioner bar

**Files:**
- Create: `packages/web/src/views/CommissionerBar.tsx`
- Test: `packages/web/tests/CommissionerBar.test.tsx`

**Interfaces:**
- A compact bar pinned above the manager view when `role === 'commissioner'`, holding only what running the draft requires: **Start draft** (lobby only), **Pause/Resume**, **+30s**, and **Nominate for…/Bid for…** proxy controls that let the commissioner act as any team.
- Corrections (undo, edit pick, adjust budget) are deliberately **not** here — they land in Plan 4 with confirmation flows, because an accidental undo mid-draft is worse than a slow correction.
- Start draft surfaces `NO_PLAYERS` plainly: "The player pool is empty or too small. Refresh players before starting."
- Proxy actions require choosing the team first, and the chosen team is echoed in the confirmation so the commissioner cannot bid for the wrong person by muscle memory.

- [ ] **Step 1: Failing tests** — Start only in lobby; Pause becomes Resume when paused; +30s sends `ADD_TIME`; proxy bid sends the *selected* team's id, not the commissioner's; `NO_PLAYERS` renders the plain message.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify + commit** — `feat(web): commissioner controls for running the draft`.

---

### Task 12: End-to-end — a real auction through the real server

**Files:**
- Create: `packages/web/tests/e2e.test.ts`

**Interfaces:**
- Consumes: `buildServer` (pg-mem), `createDraftClient` — no DOM. This is the acceptance gate for Plan 3: it proves the client protocol against the real server, the same way Plan 2's bot test proved the server.

**Scenario, asserted end to end:**
1. Commissioner, two managers, and a board client all connect and receive snapshots.
2. Commissioner starts the draft; **every already-connected client** sees the player pool arrive (this is the regression guard for the bug Plan 2's integration test caught — clients joined before START_DRAFT must not keep an empty pool).
3. The on-the-clock manager nominates; both other clients see `bidding` with the right player and price.
4. Both managers bid the same amount at the same instant: exactly one ack succeeds, the loser gets `STALE_PRICE`, and all four clients converge on identical state.
5. A manager tries to bid over max: rejected with `EXCEEDS_MAX_BID`, and state is unchanged everywhere.
6. Commissioner pauses; a bid is refused while paused; resume restores bidding.
7. The clock runs out and the player sells; every client's state matches the server's and shows the sale.
8. A manager's client closes and reconnects mid-draft: its fresh snapshot equals the other clients' state exactly (`toStrictEqual`), proving reconnect resync.

- [ ] **Step 1: Write the test** using the `settled(client, predicate)` helper pattern from Task 2.
- [ ] **Step 2: Run it alone first:** `npx vitest run packages/web/tests/e2e.test.ts`. A failure here is a real protocol bug — diagnose it, do not weaken the assertions or add sleeps.
- [ ] **Step 3: Full suite + typecheck, then commit** — `test(web): end-to-end auction through the real server`.

---

## A note on task depth

Tasks 1–4 carry complete code because they establish contracts every later task builds on — the client's state/clock semantics and the token system are where a wrong guess is expensive and invisible. Tasks 5–11 specify exact files, exact interfaces, exact behaviors, the assertions their tests must make, and the binding design tokens and copy, but leave component composition to the implementer. That is deliberate: pixel-level component code in a plan goes stale the moment two components compose differently, while the interfaces and the design direction are what must not drift. An implementer who follows the Design Direction section and the per-task interface list has no meaningful latitude on look or behavior — only on arrangement.

If any task's behavior spec turns out to be ambiguous during implementation, that is a plan defect: report it rather than guessing, the way earlier plans' briefs were amended mid-execution.

## Spec coverage map (self-check)

| Spec / requirement | Covered by |
|---|---|
| §7 manager view (phone-first bidding, budget/max/slots visible, guardrails with reasons) | Tasks 5–9 |
| §7 board view (TV, rosters + budgets, spotlight, going once/twice, sold ticker) | Task 10 |
| §7 commissioner view (start, clock control, proxy) | Task 11 |
| §10 reconnect = full resync, never a blank screen | Tasks 2, 3, 12 |
| §10 clock authority (server-corrected countdown) | Tasks 2, 4 |
| §10 presence, deduped by team | Tasks 3, 5 |
| Plan 2 backlog: serve UI same-origin (no CORS needed) | Task 1 |
| Plan 2 backlog: render countdowns from snapshot `now`, not the device clock | Task 2 |
| Plan 2 backlog: `/draft/:id` route so invite links resolve | Task 1 |
| Plan 2 backlog: presence dedupe by teamId | Task 5 |

**Deferred to Plan 4:** commissioner corrections (undo sale, edit pick, adjust budget) with confirmations; the ESPN entry screen; draft-record and bid-log CSV exports; invite-link re-issue UI; mock-draft convenience tooling.

