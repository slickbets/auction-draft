# Deploying to Railway

Runtime decision (recorded): the server runs under `tsx` (no build step). Revisit if/when this becomes a multi-tenant product.

1. railway.com → New Project → "Deploy from GitHub repo" → select `slickbets/auction-draft` (grant repo access if prompted).
2. In the new project: **+ New → Database → PostgreSQL.**
3. On the app service → Variables:
   - `DATABASE_URL` → Add Reference → select the Postgres service's `DATABASE_URL`.
   - `BASE_URL` → the app service's public domain (Settings → Networking → Generate Domain, then paste `https://<domain>`).
   - `CREATE_KEY` → a long random string (`openssl rand -base64 24`).
   - `SLEEPER_SYNC` → `1`.
   - `WEB_DIST` → `packages/web/dist` (the client build output; serves the SPA same-origin so invite links resolve).
4. Settings → Deploy: start command is auto-detected from root `npm start`; healthcheck path `/healthz`.
5. Deploy. Verify: `curl https://<domain>/healthz` → `{"ok":true}`; logs show `seeded players: <n>` on first boot.
6. Create the league:
   `curl -X POST https://<domain>/api/leagues -H 'content-type: application/json' -H "x-create-key: $CREATE_KEY" -d @league.json`
   → the response contains the commissioner link, board link, and all ten invite links.

## Before Starting a Draft

After first boot (or at any time), hit the refresh-players endpoint to ensure the Sleeper pool is populated. This route requires the commissioner token from that league's invite link (the fragment after `#`), not the create key:

```bash
curl -X POST "https://<domain>/api/leagues/<leagueId>/refresh-players" \
  -H "authorization: Bearer <commissioner-token-from-the-invite-link-fragment>"
```

Check that the response contains an `updated` count. **Do not start a draft until the players table has enough players to fill every roster** — if the pool is too small, `START_DRAFT` will be rejected with error code `NO_PLAYERS`.

`SLEEPER_SYNC` must be set to `1` for the boot seed and the daily 09:00 UTC cron to run — it is **not** on by default (`env.ts` defaults it to `'0'`). Set it explicitly in Railway's Variables if you want either.

## Verifying a Real Draft

After creating a league, test the draft experience end-to-end:

1. Open the commissioner link in one browser tab.
2. Open any team's invite link in a second browser window.
3. Confirm **both windows receive a snapshot** (each shows the full game state).
4. Press Start Draft in the commissioner view.
5. Confirm **the player pool appears in both windows** — not just the commissioner.

This verifies the critical handoff: early-joining clients now receive the full pool state on connect, rather than joining an empty pool. The integration test catches this failure mode.
