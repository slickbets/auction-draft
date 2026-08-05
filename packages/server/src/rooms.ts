import type { LeagueConfig } from '@auction/engine'
import { Room, type RoomDeps } from './room.js'
import type { LeagueService } from './league.js'

/** Drain queued commands before closing, so an in-flight append can't land after a
 *  replacement Room has already read the stream (which would wedge it on a seq conflict). */
async function retire(room: Room | null): Promise<void> {
  if (!room) return
  await room.idle()
  room.close()
}

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
    // Evict only if this failed load is still the current entry: a reload may have
    // already replaced it, and deleting that would let a second Room be created for
    // a league that already has a live one (double timers, double writes).
    loading.catch(() => {
      if (this.rooms.get(leagueId) === loading) this.rooms.delete(leagueId)
    })
    return loading.then(
      r => r,
      () => null,
    )
  }

  /** Close and re-create (after config freeze). */
  async reload(leagueId: string): Promise<Room | null> {
    const existing = this.rooms.get(leagueId)
    if (existing) await retire(await existing.catch(() => null))
    this.rooms.delete(leagueId)
    return this.getOrLoad(leagueId)
  }

  async closeAll(): Promise<void> {
    for (const p of this.rooms.values()) await retire(await p.catch(() => null))
    this.rooms.clear()
  }
}
