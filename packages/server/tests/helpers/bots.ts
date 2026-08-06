import { io as client, type Socket } from 'socket.io-client'
import { apply, maxBid, firstOpenSlotFor } from '@auction/engine'
import type { DraftEvent, DraftState } from '@auction/engine'

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface BotHandle {
  socket: Socket
  done: Promise<DraftState>
  sent: () => number
}

export function runBot(url: string, token: string, teamId: string, seed: number): BotHandle {
  const rand = mulberry32(seed)
  const socket = client(url, { auth: { token }, transports: ['websocket'] })
  let state: DraftState | null = null
  let acting = false
  let accepted = 0

  const send = (cmd: unknown) =>
    new Promise(res =>
      socket.emit('command', cmd, (r: any) => {
        if (r?.ok) accepted += 1
        res(r)
      }),
    )
  const later = (fn: () => void, ms: number) => setTimeout(fn, ms)

  let resolveDone: (s: DraftState) => void
  const done = new Promise<DraftState>(r => (resolveDone = r))

  const maybeAct = () => {
    try {
      if (!state || acting) return
      const s = state
      if (s.phase.type === 'complete') return resolveDone(s)
      const me = s.teams[teamId]
      if (!me) return
      if (s.phase.type === 'awaiting_nomination' && s.phase.teamId === teamId) {
        acting = true
        later(async () => {
          const cur = state
          if (cur && cur.phase.type === 'awaiting_nomination' && cur.phase.teamId === teamId) {
            const legal = cur.available.filter(id => {
              const p = cur.config.players.find(x => x.id === id)!
              return firstOpenSlotFor(cur.teams[teamId]!, p.position, cur.config) !== null
            })
            const pick = legal[Math.floor(rand() * legal.length)]
            if (pick) await send({ type: 'NOMINATE', teamId, playerId: pick, openingBid: 1 })
          }
          acting = false
          maybeAct()
        }, 10 + Math.floor(rand() * 30))
        return
      }
      if (s.phase.type === 'bidding' && s.phase.highBidderId !== teamId && rand() < 0.4) {
        const phase = s.phase
        const p = s.config.players.find(x => x.id === phase.playerId)
        if (!p) return
        const amount = phase.price + 1 + Math.floor(rand() * 3)
        if (amount <= maxBid(me, s.config) && firstOpenSlotFor(me, p.position, s.config) !== null) {
          acting = true
          later(async () => {
            const cur = state
            if (cur && cur.phase.type === 'bidding' && cur.phase.playerId === phase.playerId && cur.phase.highBidderId !== teamId) {
              await send({ type: 'BID', teamId, amount: Math.max(amount, cur.phase.price + 1) })
            }
            acting = false
            maybeAct()
          }, 5 + Math.floor(rand() * 25))
        }
      }
    } catch {
      /* a misbehaving bot must not abort the draft or the test process */
    }
  }

  socket.on('snapshot', (snap: { state: DraftState }) => {
    state = snap.state
    maybeAct()
  })
  socket.on('events', (batch: { events: DraftEvent[] }) => {
    if (!state) return
    for (const e of batch.events) state = apply(state, e)
    maybeAct()
  })

  return { socket, done, sent: () => accepted }
}
