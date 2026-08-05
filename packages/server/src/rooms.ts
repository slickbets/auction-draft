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
