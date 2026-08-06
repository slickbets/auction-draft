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
  // Tracks an in-flight reload() per league so concurrent callers coalesce onto the
  // SAME outcome. Without this, installing the loading promise synchronously (below)
  // still lets a second concurrent reload capture the first's promise as its own
  // "prev", chaining a third build on top — which fixes the double-live-room bug but
  // leaves the first caller holding a reference to a Room that gets retired out from
  // under it the instant the second caller's build finishes. A stale-but-not-yet-GC'd
  // Room has no `closed` guard on dispatch/append, so a caller that dispatches through
  // it after that point would append into the wrong seq stream. Coalescing means every
  // concurrent caller gets the identical Room, so no one is ever holding a stale one.
  private reloading = new Map<string, Promise<Room | null>>()

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

  /** Close and re-create (after config freeze). A concurrent reload for the same
   *  league piggybacks on this call's in-flight promise (see `reloading` above)
   *  instead of starting its own retire+rebuild — so every caller resolves to the
   *  exact same Room, and exactly one live Room ever exists for the league. */
  reload(leagueId: string): Promise<Room | null> {
    const already = this.reloading.get(leagueId)
    if (already) return already

    const prev = this.rooms.get(leagueId)
    // The loading promise is installed SYNCHRONOUSLY (before any await below) so a
    // concurrent getOrLoad or reload sees it as the current cache entry immediately,
    // rather than racing it into a second live Room for the same league.
    const loading = (async () => {
      await retire(prev ? await prev.catch(() => null) : null)
      const config = await this.resolveConfig(leagueId)
      if (!config) throw new Error(`no league ${leagueId}`)
      return Room.create(leagueId, config, this.deps)
    })()
    this.rooms.set(leagueId, loading)
    loading.catch(() => {
      if (this.rooms.get(leagueId) === loading) this.rooms.delete(leagueId)
    })

    const result = loading.then(
      r => r,
      () => null,
    )
    this.reloading.set(leagueId, result)
    void result.finally(() => {
      if (this.reloading.get(leagueId) === result) this.reloading.delete(leagueId)
    })
    return result
  }

  async closeAll(): Promise<void> {
    for (const p of this.rooms.values()) await retire(await p.catch(() => null))
    this.rooms.clear()
    this.reloading.clear()
  }
}
