import { createServer, type Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import cron from 'node-cron'
import type { Pool } from 'pg'
import { createApp } from './app.js'
import { createPool } from './db.js'
import { loadEnv, type Env } from './env.js'
import { LeagueService } from './league.js'
import { migrate } from './migrations.js'
import { fetchSleeperPlayers, PlayerRepo, toPlayerRows } from './players.js'
import { RoomManager } from './rooms.js'
import { attachSockets } from './sockets.js'
import { PgEventStore } from './store.js'

export async function buildServer(env: Env, pool: Pool): Promise<{ http: HttpServer; io: Server; rooms: RoomManager; close(): Promise<void> }> {
  await migrate(pool)
  const leagues = new LeagueService(pool, env.BASE_URL)
  const playerRepo = new PlayerRepo(pool)
  const sync = async () => playerRepo.upsertAll(toPlayerRows(await fetchSleeperPlayers()))
  const app = createApp({ leagues, players: { repo: playerRepo, sync }, createKey: env.CREATE_KEY })
  const http = createServer(app)
  const io = new Server(http)
  const rooms = new RoomManager(
    {
      store: new PgEventStore(pool),
      broadcast: (id, seq, events) => io.to(`league:${id}`).emit('events', { seq, events }),
      notify: (id, notice) => io.to(`league:${id}`).emit('notice', notice),
      clock: () => Date.now(),
    },
    leagues,
  )
  attachSockets(io, { leagues, rooms, playerRepo })
  return {
    http,
    io,
    rooms,
    async close() {
      await rooms.closeAll()
      io.close()
      await new Promise<void>((resolve, reject) => http.close(err => (err ? reject(err) : resolve())))
    },
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const env = loadEnv()
  const pool = createPool(env.DATABASE_URL)
  const server = await buildServer(env, pool)
  if (env.SLEEPER_SYNC === '1') {
    const count = await pool.query('SELECT count(*)::int AS n FROM players')
    if (count.rows[0].n === 0) {
      const sync = async () => new PlayerRepo(pool).upsertAll(toPlayerRows(await fetchSleeperPlayers()))
      console.log(`seeded players: ${await sync()}`)
    }
    cron.schedule('0 9 * * *', async () => {
      const n = await new PlayerRepo(pool).upsertAll(toPlayerRows(await fetchSleeperPlayers()))
      console.log(`daily player sync: ${n}`)
    })
  }
  server.http.listen(env.PORT, () => console.log(`auction-draft server on :${env.PORT}`))
}
