import type { Server, Socket } from 'socket.io'
import { ZodError } from 'zod'
import type { LeagueService, Principal } from './league.js'
import type { PlayerRepo } from './players.js'
import type { RoomManager } from './rooms.js'
import { parseWireCommand } from './wire.js'
import type { WireCommand } from './room.js'

export interface SocketDeps {
  leagues: LeagueService
  rooms: RoomManager
  playerRepo: PlayerRepo
}

type Ack = (result: { ok: true } | { ok: false; error: { code: string; message: string } }) => void
const deny = (ack: Ack, code: string, message: string) => ack({ ok: false, error: { code, message } })

const MANAGER_COMMANDS = new Set<WireCommand['type']>(['NOMINATE', 'BID'])

function authorized(principal: Principal, cmd: WireCommand): boolean {
  if (principal.role === 'commissioner') return cmd.type !== 'CLOCK_EXPIRED' // clock is server-internal
  if (principal.role === 'board') return false
  if (!MANAGER_COMMANDS.has(cmd.type)) return false
  return (cmd as { teamId?: string }).teamId === principal.teamId
}

export function attachSockets(io: Server, deps: SocketDeps): void {
  const connected = new Map<string, Map<string, Principal>>() // leagueId -> socketId -> principal

  const presence = (leagueId: string) => {
    const list = [...(connected.get(leagueId)?.values() ?? [])].map(p =>
      p.role === 'manager' ? { role: p.role, teamId: p.teamId } : { role: p.role },
    )
    io.to(`league:${leagueId}`).emit('presence', { connected: list })
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token
    const principal = typeof token === 'string' ? await deps.leagues.resolveToken(token) : null
    if (!principal) return next(new Error('unauthorized'))
    ;(socket.data as { principal: Principal }).principal = principal
    next()
  })

  io.on('connection', async (socket: Socket) => {
    const principal = (socket.data as { principal: Principal }).principal
    const { leagueId } = principal
    const room = await deps.rooms.getOrLoad(leagueId)
    if (!room) {
      socket.disconnect(true)
      return
    }
    await socket.join(`league:${leagueId}`)
    if (!connected.has(leagueId)) connected.set(leagueId, new Map())
    connected.get(leagueId)!.set(socket.id, principal)
    socket.emit('snapshot', {
      seq: room.lastSeq,
      state: room.state,
      role: principal.role,
      ...(principal.role === 'manager' ? { teamId: principal.teamId } : {}),
    })
    presence(leagueId)

    socket.on('command', async (payload: unknown, ack: Ack) => {
      if (typeof ack !== 'function') return
      let cmd: WireCommand
      try {
        cmd = parseWireCommand(payload)
      } catch (err) {
        return deny(ack, 'INVALID_COMMAND', err instanceof ZodError ? err.issues.map(i => i.message).join('; ') : 'invalid command')
      }
      if (!authorized(principal, cmd)) return deny(ack, 'FORBIDDEN', 'not allowed for your role')

      let target = await deps.rooms.getOrLoad(leagueId)
      if (!target) return deny(ack, 'NO_LEAGUE', 'league not found')

      if (cmd.type === 'START_DRAFT' && !(await deps.leagues.frozenConfig(leagueId))) {
        const pool = await deps.playerRepo.listForDraft()
        if (pool.length === 0) return deny(ack, 'NO_PLAYERS', 'player pool is empty — refresh players first')
        await deps.leagues.freeze(leagueId, pool)
        target = await deps.rooms.reload(leagueId)
        if (!target) return deny(ack, 'NO_LEAGUE', 'league not found')
      }

      try {
        const result = await target.dispatch(cmd)
        if (result.ok) return ack({ ok: true })
        return ack({ ok: false, error: { code: result.error.code, message: result.error.message } })
      } catch {
        // Store/infra failure: the command was NOT applied. Client keeps its state; commissioner pauses.
        return deny(ack, 'INTERNAL', 'server error — command not applied')
      }
    })

    socket.on('disconnect', () => {
      connected.get(leagueId)?.delete(socket.id)
      presence(leagueId)
    })
  })
}
