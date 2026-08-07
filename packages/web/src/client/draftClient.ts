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
  /**
   * Server-corrected clock: on every snapshot we anchor the server's `now` to a
   * monotonic timestamp (`performance.now()`), then measure elapsed time off that
   * monotonic clock instead of re-reading `Date.now()`. A device's wall clock can
   * jump or drift after the anchor is captured (NTP correction, manual change,
   * timezone weirdness) — the monotonic delta is immune to that, so the server
   * correction isn't undone by a device clock that misbehaves after we've synced.
   */
  let anchorServerNow = Date.now()
  let anchorPerfNow = performance.now()
  const correctedNow = () => anchorServerNow + (performance.now() - anchorPerfNow)

  const set = (patch: Partial<DraftView>) => {
    view = { ...view, ...patch }
    for (const fn of subs) fn(view)
  }

  const socket = factory(url, { auth: { token: opts.token } })

  socket.on('connect_error', () => set({ status: 'rejected', state: null }))
  socket.on('disconnect', () => set({ status: 'reconnecting' }))

  socket.on('snapshot', (s: { seq: number; state: DraftState; role: Role; teamId?: string; now?: number }) => {
    if (typeof s.now === 'number') {
      anchorServerNow = s.now
      anchorPerfNow = performance.now()
    }
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
      // Quantized to 100ms: `correctedNow()` is anchored to a server timestamp that
      // is always slightly stale by the one-way socket transit time (sub-millisecond
      // on localhost, but nonzero and unmeasured — the protocol has no round-trip
      // compensation). Returning raw sub-millisecond precision would leak that jitter
      // into the UI for no benefit — no countdown needs finer than 100ms — so we floor
      // to the nearest 100ms, which also keeps this safely on the "never overstates
      // remaining time" side.
      const raw = Math.max(0, deadline - correctedNow())
      return Math.floor(raw / 100) * 100
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
