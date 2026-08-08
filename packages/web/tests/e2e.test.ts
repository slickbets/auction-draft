import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import { buildServer } from '../../server/src/main.js'
import { LeagueService } from '../../server/src/league.js'
import { PlayerRepo } from '../../server/src/players.js'
import { createDraftClient, type DraftClient, type DraftView, type Ack } from '../src/client/draftClient.js'
import type { CreatedLeague } from '../../server/src/league.js'

// Three teams, but only two managers ever connect a client (T1, T2) — the acceptance
// gate for the scenario described in the task. T3 exists purely so the "on the clock"
// slot ahead of the contested auction can be filled by the server's own auto-nominate
// clock-expiry backstop (already a real, separately-tested server behavior) instead of
// by either racing manager. That matters: if the pre-race high bidder were T1 or T2
// themselves, whichever of their two simultaneous same-amount bids the server happens
// to process first would hit ALREADY_HIGH_BIDDER instead of STALE_PRICE (see the
// engine's check order in BID) — an artifact of test setup, not a protocol property.
// Routing the opening bid through silent T3 makes "loser gets STALE_PRICE" true
// regardless of which of T1/T2's packets the server happens to process first.
const CONFIG = {
  teams: [
    { id: 'T1', name: 'Cook' },
    { id: 'T2', name: 'Dave' },
    { id: 'T3', name: 'Ref' },
  ],
  budget: 200,
  rosterTemplate: [
    { name: 'QB', eligible: ['QB' as const], count: 1 },
    { name: 'BENCH', eligible: ['QB' as const, 'RB' as const], count: 1 },
  ],
  bidClockMs: 1_500,
  nominationClockMs: 1_500,
  nominationOrder: ['T1', 'T3', 'T2'],
  nominationExpiryPolicy: 'auto_nominate' as const,
}
// 8 players for 3 teams * 2-slot rosters (needs >= 6) with headroom to spare.
const PLAYERS = [
  { sleeperId: 'q1', name: 'QB One', position: 'QB' as const, nflTeam: 'SF', status: 'Active', searchRank: 1 },
  { sleeperId: 'q2', name: 'QB Two', position: 'QB' as const, nflTeam: 'KC', status: 'Active', searchRank: 2 },
  { sleeperId: 'q3', name: 'QB Three', position: 'QB' as const, nflTeam: 'NYJ', status: 'Active', searchRank: 3 },
  { sleeperId: 'q4', name: 'QB Four', position: 'QB' as const, nflTeam: 'MIA', status: 'Active', searchRank: 4 },
  { sleeperId: 'r1', name: 'RB One', position: 'RB' as const, nflTeam: 'ATL', status: 'Active', searchRank: 5 },
  { sleeperId: 'r2', name: 'RB Two', position: 'RB' as const, nflTeam: 'DAL', status: 'Active', searchRank: 6 },
  { sleeperId: 'r3', name: 'RB Three', position: 'RB' as const, nflTeam: 'GB', status: 'Active', searchRank: 7 },
  { sleeperId: 'r4', name: 'RB Four', position: 'RB' as const, nflTeam: 'LAR', status: 'Active', searchRank: 8 },
]

function memPool() {
  const db = newDb()
  const { Pool } = db.adapters.createPg()
  return new Pool() as any
}

const settled = (c: DraftClient, p: (v: DraftView) => boolean, ms = 6_000) =>
  new Promise<void>((resolve, reject) => {
    if (p(c.view)) return resolve()
    const t = setTimeout(
      () => reject(new Error(`condition not met; status=${c.view.status} phase=${JSON.stringify(c.view.state?.phase)}`)),
      ms,
    )
    const un = c.subscribe(v => {
      if (p(v)) {
        clearTimeout(t)
        un()
        resolve()
      }
    })
  })

describe('end-to-end auction through the real server', () => {
  let server: Awaited<ReturnType<typeof buildServer>>
  let url: string
  let links: CreatedLeague['links']
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

  it(
    'drives a real auction through four real clients: nominate, race, guardrails, pause/resume, sale, reconnect',
    { timeout: 30_000 },
    async () => {
      const t1Link = links.teams.find(t => t.teamId === 'T1')!.url
      const t2Link = links.teams.find(t => t.teamId === 'T2')!.url

      // --- Step 1: everyone connects and receives a snapshot -----------------------
      const commish = open(links.commissioner)
      const mgr1 = open(t1Link)
      const mgr2 = open(t2Link)
      const board = open(links.board)
      const all = [commish, mgr1, mgr2, board]

      await Promise.all(all.map(c => settled(c, v => v.status === 'live')))
      expect(commish.view.role).toBe('commissioner')
      expect(mgr1.view.role).toBe('manager')
      expect(mgr1.view.teamId).toBe('T1')
      expect(mgr2.view.role).toBe('manager')
      expect(mgr2.view.teamId).toBe('T2')
      expect(board.view.role).toBe('board')
      for (const c of all) expect(c.view.state!.phase.type).toBe('lobby')
      // Pre-freeze pool is empty by design (config.players is [] until START_DRAFT
      // freezes it) — this is the "before" half of the regression guard below.
      for (const c of all) expect(c.view.state!.available).toEqual([])

      // --- Step 2: commissioner starts the draft; every already-connected client ---
      // --- (including the board) must see the player pool arrive -------------------
      const startAck = await commish.send({ type: 'START_DRAFT' })
      expect(startAck.ok).toBe(true)
      await Promise.all(all.map(c => settled(c, v => v.state?.phase.type === 'awaiting_nomination')))
      for (const c of all) {
        expect(c.view.state!.available).toHaveLength(PLAYERS.length)
        expect(c.view.state!.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T1' })
      }
      expect(mgr1.view.state).toStrictEqual(commish.view.state)
      expect(mgr2.view.state).toStrictEqual(commish.view.state)
      expect(board.view.state).toStrictEqual(commish.view.state)

      // --- Step 3: the on-the-clock manager (T1) nominates explicitly --------------
      const nomAck = await mgr1.send({ type: 'NOMINATE', teamId: 'T1', playerId: 'q1', openingBid: 3 })
      expect(nomAck.ok).toBe(true)
      await Promise.all(all.map(c => settled(c, v => v.state?.phase.type === 'bidding')))
      for (const c of all) {
        expect(c.view.state!.phase).toMatchObject({
          type: 'bidding', playerId: 'q1', price: 3, highBidderId: 'T1', nominatorId: 'T1',
        })
      }
      expect(mgr1.view.state).toStrictEqual(commish.view.state)
      expect(mgr2.view.state).toStrictEqual(commish.view.state)
      expect(board.view.state).toStrictEqual(commish.view.state)

      // Nobody contests q1; let its bid clock run out uncontested so it sells to T1
      // and the nomination pointer advances to T3 — the silent seat that will hold
      // the next auction's opening bid (see the file-level comment on CONFIG).
      await Promise.all(
        all.map(c =>
          settled(c, v => !!v.state?.sales.some(s => s.playerId === 'q1') && v.state?.phase.type === 'awaiting_nomination'),
        ),
      )
      for (const c of all) {
        expect(c.view.state!.sales.find(s => s.playerId === 'q1')).toMatchObject({ teamId: 'T1', price: 3 })
        expect(c.view.state!.available).not.toContain('q1')
        expect(c.view.state!.phase).toMatchObject({ type: 'awaiting_nomination', teamId: 'T3' })
      }

      // T3 has no connected client, so its nomination clock expires and the server's
      // auto_nominate backstop nominates the best-ranked remaining player (q2) for it
      // at the $1 default opening bid, making T3 — not T1 or T2 — the pre-race holder.
      await Promise.all(all.map(c => settled(c, v => v.state?.phase.type === 'bidding')))
      for (const c of all) {
        expect(c.view.state!.phase).toMatchObject({
          type: 'bidding', playerId: 'q2', price: 1, highBidderId: 'T3', nominatorId: 'T3',
        })
      }
      expect(mgr1.view.state).toStrictEqual(commish.view.state)
      expect(mgr2.view.state).toStrictEqual(commish.view.state)
      expect(board.view.state).toStrictEqual(commish.view.state)

      // --- Step 4: both managers bid the same amount at the same instant -----------
      const [ackA, ackB] = await Promise.all([
        mgr1.send({ type: 'BID', teamId: 'T1', amount: 5 }),
        mgr2.send({ type: 'BID', teamId: 'T2', amount: 5 }),
      ])
      const pair: { team: 'T1' | 'T2'; ack: Ack }[] = [{ team: 'T1', ack: ackA }, { team: 'T2', ack: ackB }]
      const winner = pair.find(p => p.ack.ok)
      const loser = pair.find(p => !p.ack.ok)
      if (!winner || !loser) throw new Error(`expected exactly one winner and one loser, got ${JSON.stringify(pair)}`)
      expect(loser.ack.ok).toBe(false)
      if (!loser.ack.ok) expect(loser.ack.error.code).toBe('STALE_PRICE')
      const loserClient = loser.team === 'T1' ? mgr1 : mgr2

      await Promise.all(
        all.map(c =>
          settled(c, v => {
            const phase = v.state?.phase
            return phase?.type === 'bidding' && phase.highBidderId === winner.team
          }),
        ),
      )
      for (const c of all) {
        expect(c.view.state!.phase).toMatchObject({ type: 'bidding', playerId: 'q2', price: 5, highBidderId: winner.team })
      }
      expect(mgr1.view.state).toStrictEqual(commish.view.state)
      expect(mgr2.view.state).toStrictEqual(commish.view.state)
      expect(board.view.state).toStrictEqual(commish.view.state)

      // --- Step 5: the loser tries to bid over their own max -----------------------
      const beforeOverbid = commish.view.state
      const overAck = await loserClient.send({ type: 'BID', teamId: loser.team, amount: 9_999 })
      expect(overAck.ok).toBe(false)
      if (!overAck.ok) expect(overAck.error.code).toBe('EXCEEDS_MAX_BID')
      for (const c of all) expect(c.view.state).toStrictEqual(beforeOverbid)

      // --- Step 6: commissioner pauses; a bid is refused; resume restores bidding --
      const pauseAck = await commish.send({ type: 'PAUSE' })
      expect(pauseAck.ok).toBe(true)
      await Promise.all(all.map(c => settled(c, v => v.state?.phase.type === 'paused')))
      for (const c of all) expect(c.view.state!.phase).toMatchObject({ type: 'paused' })

      const refusedAck = await loserClient.send({ type: 'BID', teamId: loser.team, amount: 6 })
      expect(refusedAck.ok).toBe(false)
      if (!refusedAck.ok) expect(refusedAck.error.code).toBe('WRONG_PHASE')
      for (const c of all) expect(c.view.state!.phase.type).toBe('paused')

      const resumeAck = await commish.send({ type: 'RESUME' })
      expect(resumeAck.ok).toBe(true)
      await Promise.all(all.map(c => settled(c, v => v.state?.phase.type === 'bidding')))
      for (const c of all) {
        expect(c.view.state!.phase).toMatchObject({ type: 'bidding', playerId: 'q2', price: 5, highBidderId: winner.team })
      }
      expect(mgr1.view.state).toStrictEqual(commish.view.state)
      expect(mgr2.view.state).toStrictEqual(commish.view.state)
      expect(board.view.state).toStrictEqual(commish.view.state)

      // --- Step 7: the bid clock runs out and the player sells ---------------------
      await Promise.all(
        all.map(c =>
          settled(c, v => !!v.state?.sales.some(s => s.playerId === 'q2') && v.state?.phase.type === 'awaiting_nomination'),
        ),
      )
      for (const c of all) {
        expect(c.view.state!.sales.find(s => s.playerId === 'q2')).toMatchObject({ teamId: winner.team, price: 5 })
        expect(c.view.state!.available).not.toContain('q2')
      }
      expect(mgr1.view.state).toStrictEqual(commish.view.state)
      expect(mgr2.view.state).toStrictEqual(commish.view.state)
      expect(board.view.state).toStrictEqual(commish.view.state)

      // Freeze the clock before the reconnect check: the sale just started T2's
      // nomination clock (nominationClockMs = 1.5s), and we don't want that racing
      // against the close/reopen dance below.
      const safetyPause = await commish.send({ type: 'PAUSE' })
      expect(safetyPause.ok).toBe(true)
      await Promise.all(all.map(c => settled(c, v => v.state?.phase.type === 'paused')))
      expect(mgr1.view.state).toStrictEqual(commish.view.state)
      expect(mgr2.view.state).toStrictEqual(commish.view.state)
      expect(board.view.state).toStrictEqual(commish.view.state)

      // --- Step 8: a manager's client closes and a fresh one reconnects mid-draft --
      const reconnectingTeam = loser.team
      const reconnectingLink = reconnectingTeam === 'T1' ? t1Link : t2Link
      const staleClient = reconnectingTeam === 'T1' ? mgr1 : mgr2
      staleClient.close()

      const fresh = open(reconnectingLink)
      await settled(fresh, v => v.status === 'live')
      expect(fresh.view.role).toBe('manager')
      expect(fresh.view.teamId).toBe(reconnectingTeam)
      expect(fresh.view.state).toStrictEqual(commish.view.state)
      expect(fresh.view.state).toStrictEqual(board.view.state)
    },
  )
})
