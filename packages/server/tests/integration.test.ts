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

    // bots must have actually driven the draft, not just ridden the auto-nominate backstop
    const botCommands = bots.reduce((n, b) => n + b.sent(), 0)
    expect(botCommands).toBeGreaterThan(20) // bots nominated/bid for real, not just the auto-nominate backstop
    const contested = final.sales.filter(s => s.price > 1).length
    expect(contested).toBeGreaterThan(0) // at least some players were actually bid up

    for (const b of bots) b.socket.disconnect()
    commish.disconnect()
    await server.close()
  })
})
