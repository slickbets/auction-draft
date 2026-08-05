import { apply, execute, replay } from '@auction/engine'
import type { Command, DraftEvent, DraftState, ExecuteResult, LeagueConfig } from '@auction/engine'
import type { EventStore } from './store.js'

export type WireCommand = { [K in Command['type']]: Omit<Extract<Command, { type: K }>, 'now'> }[Command['type']]

export interface RoomDeps {
  store: EventStore
  broadcast: (leagueId: string, seq: number, events: DraftEvent[]) => void
  notify: (leagueId: string, notice: { type: 'skip_loop' }) => void
  clock: () => number
}

export class Room {
  private chain: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private skipStreak = 0
  private closed = false

  protected constructor(
    readonly leagueId: string,
    private st: DraftState,
    private seq: number,
    private deps: RoomDeps,
  ) {}

  static async create(leagueId: string, config: LeagueConfig, deps: RoomDeps): Promise<Room> {
    const { seq, events } = await deps.store.load(leagueId)
    const state = replay(config, events)
    const room = new this(leagueId, state, seq, deps)
    if (state.phase.type === 'awaiting_nomination' || state.phase.type === 'bidding') {
      const last = events[events.length - 1]!
      await room.dispatch({ type: 'PAUSE' }, last.at)
    }
    room.armTimer()
    return room
  }

  get state(): DraftState {
    return this.st
  }
  get lastSeq(): number {
    return this.seq
  }

  dispatch(cmd: WireCommand, nowOverride?: number): Promise<ExecuteResult> {
    const run = this.chain.then(() => this.exec(cmd, nowOverride))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async exec(cmd: WireCommand, nowOverride?: number): Promise<ExecuteResult> {
    const now = nowOverride ?? this.deps.clock()
    const r = execute(this.st, { ...cmd, now } as Command)
    if (!r.ok) return r
    this.seq = await this.deps.store.append(this.leagueId, this.seq, r.events)
    for (const e of r.events) this.st = apply(this.st, e)
    try {
      this.deps.broadcast(this.leagueId, this.seq, r.events)
    } catch {
      /* a subscriber must not stall the draft clock */
    }
    this.watchdog(r.events)
    this.armTimer()
    return r
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.closed) return
    const phase = this.st.phase
    if (phase.type !== 'awaiting_nomination' && phase.type !== 'bidding') return
    const delay = Math.max(0, phase.deadline - this.deps.clock())
    this.timer = setTimeout(() => {
      // CLOCK_NOT_EXPIRED here means a bid raced in and re-armed; benign.
      // The catch prevents an unhandled rejection if the store is down; the
      // draft simply stalls until a client command surfaces the error.
      void this.dispatch({ type: 'CLOCK_EXPIRED' }).catch(() => {})
    }, delay)
  }

  private watchdog(events: DraftEvent[]): void {
    for (const e of events) {
      if (e.type === 'NOMINATION_SKIPPED') this.skipStreak += 1
      else if (e.type !== 'NOMINATION_STARTED') this.skipStreak = 0
    }
    if (this.skipStreak >= 2 * this.st.config.teams.length) {
      this.skipStreak = 0
      try {
        this.deps.notify(this.leagueId, { type: 'skip_loop' })
      } catch {
        /* a subscriber must not stall the draft clock */
      }
      void this.dispatch({ type: 'PAUSE' }).catch(() => {})
    }
  }

  /** Resolves when every queued command has settled (tests, shutdown). */
  idle(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
