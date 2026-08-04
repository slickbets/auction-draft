# Fantasy Football Auction Draft Tool — Design Spec

**Date:** 2026-08-04
**Status:** Approved design, pending implementation plan
**Deadline:** Live and rehearsed before the league's draft in early September 2026

## 1. Overview

A web-based live auction draft room for a 10-team fantasy football league, replacing FanDraft. Managers join from anywhere, nominate players, and bid in real time; a big-screen board view runs on a TV for the in-person crowd; the commissioner has full control over rules, timing, and corrections. After the draft, results export in formats optimized for manual entry into ESPN.

Built league-first: the primary success criterion is our own draft running flawlessly. Architecture choices keep a future commercial path open (multi-league, per-room scaling) but no commercial features ship in v1.

## 2. Background research (2026-08-04)

- **FanDraft** ($30–40/season): the incumbent. Browser-based since 2020; reviews cite lost customization and performance/display inconsistencies since that transition, matching our league's experience of freezing. Its marquee features: hybrid in-person/remote drafts, big-screen board, "Commish Mode."
- **Native platform rooms** (ESPN/Yahoo/Sleeper): free but rigid (fixed start times, inflexible timers, autopick-on-disconnect). Sleeper's is the best of them but only helps leagues hosted on Sleeper.
- **Hard constraint — ESPN ingestion:** ESPN has no write API and no file import. The only path is LM Tools → "Input Offline Draft Results," a manual, roster-slot-based form. It accepts players only — auction prices, rounds, and pick order cannot be entered into ESPN via the offline path. (Prices in ESPN exist only for drafts run live in ESPN's own room.)
- **Solved constraint — player data:** Sleeper's free, keyless `/players/nfl` endpoint provides all NFL players with team/position/status. Intended usage: cache and refresh at most daily.

## 3. Requirements

### Functional
1. Online platform; league members join from anywhere via a link.
2. Real-time competitive bidding: multiple managers bid on the nominated player simultaneously.
3. Manager-driven nominations in a rotating order.
4. Commissioner admin: rule/timing configuration, pause, undo, edit, proxy actions.
5. Up-to-date NFL player pool at draft time.
6. Post-draft export optimized for ESPN manual entry, plus a complete draft record (nomination order, round/pick, price, timestamp).
7. Big-screen board view for the in-person room (hybrid draft).

### League parameters (v1 defaults, all configurable)
- 10 teams, $200 auction budget each.
- Custom roster slot template (exact slots/counts entered by the commissioner in the lobby; slots define eligible positions, e.g. FLEX accepts RB/WR/TE).
- Redraft league: no keepers, no divisions.
- Bid clock: 10s, reset on every valid bid. Nomination clock: 30s.

### Non-functional
- Must not freeze: server-authoritative state, crash-recoverable, safe to refresh any client at any time.
- Fully cloud-hosted; no local machine in the loop on draft night.
- Phone-friendly bidding UI; TV-readable board.

## 4. Architecture

**Approach B (chosen): single stateful deployable.**

- **Server:** Node 22 + TypeScript on Railway (~$5–10/mo). Owns the authoritative auction state in memory, the countdown clocks, and bid serialization. Serves the built React app as static files. Runs the daily player sync.
- **Transport:** Socket.IO (auto-reconnect, rooms) over WebSockets.
- **Database:** Railway Postgres. Append-only `draft_events` log plus reference tables. State is rebuilt by replaying events.
- **Front end:** React + Vite + Tailwind. Three views (manager, board, commissioner) rendering the same broadcast state.
- **Auction engine:** a pure TypeScript module — `(state, event) → (state, effects)` — with no network, timer, or database code. The server hosts it; tests exercise it directly; a future port to Cloudflare Durable Objects (commercial scaling) moves this module unchanged.

Alternatives considered: Supabase-serverless (rejected: no home for an authoritative ticking clock — the SOLD moment becomes the system's cleverest code) and Cloudflare Durable Objects (deferred: best commercial architecture, but unfamiliar debugging under a 5-week deadline; kept open as the port target).

### Data model (sketch)

- `leagues` — config: budget, roster template (JSON), timers, nomination policy/order, invite tokens.
- `teams` — name, manager name, invite token, join state.
- `players` — Sleeper feed cache: sleeper_id, name, team, position, status, search_rank; refreshed daily + on-demand.
- `draft_events` — append-only: seq, league_id, type, payload (JSON), created_at. Only state-changing events are logged.
- `sessions` — claimed team ↔ cookie mapping.

### Auth

Invite links, not accounts. The commissioner creates the league and receives per-team invite links (signed tokens). Opening a link claims that team on that device via session cookie; links are re-issuable (re-claiming from a new device invalidates the old session). The commissioner link carries admin rights. The board view is a separate unguessable read-only URL with no controls.

## 5. Auction engine specification

### Lifecycle

`Lobby → Active → Complete`, with `Paused` reachable from Active. Active alternates between **AwaitingNomination** and **Bidding**.

### Events (append-only log)

`LEAGUE_CONFIGURED`, `TEAM_JOINED`, `DRAFT_STARTED`, `NOMINATION_STARTED`, `PLAYER_NOMINATED`, `BID_PLACED`, `SOLD`, `NOMINATION_SKIPPED`, `TIME_ADDED`, `TIMER_CONFIG_CHANGED`, `DRAFT_PAUSED`, `DRAFT_RESUMED`, `SALE_UNDONE`, `PICK_EDITED`, `BUDGET_ADJUSTED`, `DRAFT_COMPLETED`.

Rejected actions (invalid bids, unauthorized commands) are not state events; they return an error to the caller and may be audit-logged separately.

### Nomination rules

- Round-robin in lobby-configured order (randomizable). Teams with full rosters are auto-skipped. (Budget exhaustion cannot strand a team — see max-bid invariant.)
- The nominating manager selects any available player and an opening bid ≥ $1 (opening high is allowed and counts as their bid).
- Nomination clock: 30s default. On expiry, lobby-configured policy: **auto-nominate** best available player by rank at $1 on the team's behalf (default), or **skip** the team.

### Bidding rules

- A valid bid is an absolute amount ≥ current price + $1, ≤ the bidder's max bid, from a team that (a) isn't the current high bidder and (b) has an open slot the player fits.
- **Max-bid invariant:** `maxBid = budget − (openRosterSlots − 1)`. Enforced in the engine; guarantees every team can always fill every remaining slot at $1, so the draft can always complete legally.
- Every valid bid resets the bid clock (10s default; the commissioner can change the default mid-draft for subsequent players, and add time to the live countdown via `TIME_ADDED`). UI offers +$1, +$5, and custom amounts (sent as absolute values).
- **Races:** server socket-arrival order decides; first valid bid at a price wins. A bid computed against a stale price (≤ current) is rejected with an immediate "outbid" response so the manager can re-raise. Losing a race never silently misapplies a bid.
- Clock at zero → `SOLD` to the high bidder at the current price. If nobody outbids the opener, the nominator wins at the opening price.
- On SOLD, the player is assigned to the first eligible open slot in template order, falling back to bench; the engine advances to the next nomination.
- Draft completes when all teams' rosters are full.

### Clock authority

Deadlines are server state (`biddingDeadline` timestamp). Clients render countdowns from the deadline plus a measured server-time offset; only the server's timer decides expiry. On replay/restart, timers do not refire — the engine restores as `Paused` at the recovered state and the commissioner resumes.

## 6. Commissioner controls

- **Clock:** pause/resume the draft; change bid/nomination timer defaults live (applies from the next phase); add seconds to the current countdown.
- **Undo:** roll back the most recent sale, repeatable sequentially (`SALE_UNDONE` events; replay recomputes budgets/rosters exactly).
- **Edit:** reassign a sold player to another team/slot, correct a sale price, adjust a team budget (each a logged event).
- **Proxy:** nominate or bid on behalf of any team.
- **Setup (lobby):** budget, roster template, timers, nomination order and expiry policy; re-issue any invite link.

## 7. Views

1. **Manager** (phone-first): player on the block with live price/high bidder/clock, large bid buttons, own budget/max-bid/open slots always visible, nomination flow with player search when on the clock, own roster.
2. **Board** (TV): all teams' rosters and remaining budgets; spotlight panel for the current auction (player, price, high bidder, countdown); "going once / going twice" visual+audio callouts in the clock's final thirds; sold-price ticker. Sportsbook-broadcast aesthetic.
3. **Commissioner:** manager view plus admin panel.

All views are renderings of the same broadcast state; the board is a render mode, not a separate system.

## 8. Player data

- Daily job upserts Sleeper `/players/nfl` into `players`; commissioner has a "Refresh players now" button for draft day.
- Available-player search and "best available" ordering use Sleeper's search rank.
- Post-MVP: commissioner CSV upload of custom rankings/values to reorder the pool.

## 9. Exports

1. **ESPN entry screen (MVP):** results by team in roster-slot order, mirroring ESPN's "Input Offline Draft Results" form for fast phone-beside-laptop manual entry (~10 minutes; ESPN accepts players only — prices/rounds cannot enter ESPN).
2. **Draft record CSV (MVP):** one row per sale — overall nomination number, round and pick (derived: round = ⌈overall ÷ teamCount⌉), player, position, NFL team, price, winning team, timestamp. Full bid history exportable as a second CSV (the audit log).
3. **Auto-entry helper (post-MVP, explicitly deferred):** Playwright script auto-filling ESPN's form from the CSV. Brittle and ToS-gray; revisit only if manual entry proves annoying.

## 10. Resilience & error handling

- **Reconnect = resync:** every socket connection receives a full state snapshot (with latest event seq); subsequent broadcasts apply in seq order. Refreshing any client at any time is safe; no client holds authoritative state.
- **Server crash:** restart replays `draft_events`; draft restores Paused at the exact pre-crash state; commissioner resumes. Worst case ≈ a short intermission, zero lost picks.
- **Slow/lagging clients** see a late countdown but can never cause a wrong SOLD (server clock authority).
- **Presence:** connected/disconnected indicators per team; commissioner pauses or proxies for dropped managers. No autopick of players during mere disconnection (nomination expiry policy is the only automatic action, and it's configured).
- **Postgres failure:** event writes retry with backoff; if persistently unreachable, the draft auto-pauses with a clear banner rather than running without durability.

## 11. Testing

- **Engine unit tests (TDD):** every rule in §5–6 as cases — max-bid enforcement, stale-bid rejection, race ordering, auto-skip, undo/edit replay correctness, timer policies, completion. The engine's purity (no I/O) makes this exhaustive and fast.
- **Bot draft simulator:** 10 scripted clients over real sockets running full-speed drafts — simultaneous bids within tens of ms, disconnects mid-bid, reconnects mid-sale — to surface race conditions humans can't produce. Reused as the opponent pool for mock mode.
- **Mock-draft mode:** the league runs a short practice auction the week before draft night — the true dress rehearsal and UI onboarding.

## 12. Non-goals (v1)

No billing or self-serve multi-league signup; no chat; no projections/dollar-value analytics; no native apps; no ESPN browser automation. Architecture (pure engine, per-league rooms, event log) deliberately leaves the commercial path open.

## 13. Success criteria

1. The league's early-September 2026 draft runs start-to-finish with zero freezes and no lost state, with in-room TV board plus remote managers.
2. A full mock draft with the league completes at least one week prior.
3. Bot simulator completes 100 consecutive full drafts without an illegal state or stuck clock.
4. Commissioner completes ESPN entry from the export screen in ≤ 15 minutes.
