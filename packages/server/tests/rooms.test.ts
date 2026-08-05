import { describe, it, expect, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { newTestPool } from './helpers/testDb.js'
import { migrate } from '../src/migrations.js'
import { MemEventStore } from './helpers/memStore.js'
import { LeagueService } from '../src/league.js'
import { RoomManager } from '../src/rooms.js'
import type { RoomDeps } from '../src/room.js'
import type { PlayerInfo } from '@auction/engine'

const TEMPLATE = [{ name: 'QB', eligible: ['QB'], count: 1 }]
const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}` }))
const goodConfig = () => ({
  teams: teams(2),
  budget: 200,
  rosterTemplate: TEMPLATE,
  bidClockMs: 10_000,
  nominationClockMs: 30_000,
  nominationOrder: teams(2).map(t => t.id),
  nominationExpiryPolicy: 'auto_nominate',
})
const POOL: PlayerInfo[] = [{ id: 'p1', name: 'QB One', position: 'QB', nflTeam: 'SF', rank: 1 }]

describe('RoomManager', () => {
  let pool: Pool
  let leagues: LeagueService
  let deps: RoomDeps
  let manager: RoomManager

  beforeEach(async () => {
    pool = newTestPool()
    await migrate(pool)
    leagues = new LeagueService(pool, 'http://localhost:3000')
    deps = {
      store: new MemEventStore(),
      broadcast: () => {},
      notify: () => {},
      clock: () => Date.now(),
    }
    manager = new RoomManager(deps, leagues)
  })

  it('returns null for an unknown league', async () => {
    expect(await manager.getOrLoad('nope')).toBeNull()
    // A failed load must not wedge the cache: a second call tries again and still fails cleanly.
    expect(await manager.getOrLoad('nope')).toBeNull()
  })

  it('loads lazily and caches: repeated getOrLoad returns the same Room', async () => {
    const created = await leagues.create('My League', goodConfig())
    const a = await manager.getOrLoad(created.id)
    const b = await manager.getOrLoad(created.id)
    expect(a).not.toBeNull()
    expect(b).toBe(a)
  })

  it('resolves an unfrozen league to the stored config with an empty player pool (lobby)', async () => {
    const created = await leagues.create('My League', goodConfig())
    const room = await manager.getOrLoad(created.id)
    expect(room!.state.config.players).toEqual([])
    expect(room!.state.phase).toEqual({ type: 'lobby' })
  })

  it('resolves a frozen league to the frozen config, including its player pool', async () => {
    const created = await leagues.create('My League', goodConfig())
    await leagues.freeze(created.id, POOL)
    const room = await manager.getOrLoad(created.id)
    expect(room!.state.config.players).toEqual(POOL)
  })

  it('reload closes the existing room and re-creates it with the current (post-freeze) config', async () => {
    const created = await leagues.create('My League', goodConfig())
    const before = await manager.getOrLoad(created.id)
    expect(before!.state.config.players).toEqual([])
    await leagues.freeze(created.id, POOL)
    const after = await manager.reload(created.id)
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
    expect(after!.state.config.players).toEqual(POOL)
    expect(await manager.getOrLoad(created.id)).toBe(after)
  })

  it('closeAll clears every room so the next getOrLoad reloads fresh', async () => {
    const created = await leagues.create('My League', goodConfig())
    const a = await manager.getOrLoad(created.id)
    await manager.closeAll()
    const b = await manager.getOrLoad(created.id)
    expect(b).not.toBeNull()
    expect(b).not.toBe(a)
  })
})
