import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { rosterCapacity } from '@auction/engine'
import type { DraftState, Phase, SaleRecord, TimedPhase } from '@auction/engine'
import type { DraftClient, DraftView } from '../client/draftClient.js'
import { Countdown, phaseFor } from '../ui/Countdown.js'
import { Money } from '../ui/Money.js'
import { PositionChip, POSITION_COLOR } from '../ui/PositionChip.js'
import { useTick } from '../ui/useTick.js'
import { SoldTicker } from './SoldTicker.js'

/** Mirrors ManagerView/NominateSheet's own live-clock hook: re-renders on an
 *  interval so a countdown driven by `client.msLeft` keeps counting down
 *  instead of freezing at whatever value was true when the phase last
 *  changed. A TV never trusts the device clock any more than a phone does. */
function useLiveMsLeft(client: DraftClient, deadline: number): number {
  const [msLeft, setMsLeft] = useState(() => client.msLeft(deadline))
  useEffect(() => {
    setMsLeft(client.msLeft(deadline))
    const id = setInterval(() => setMsLeft(client.msLeft(deadline)), 200)
    return () => clearInterval(id)
  }, [client, deadline])
  return msLeft
}

/** The most recently landed sale, held for a few seconds so the room can read
 *  it before the board moves on to whatever comes next. Diffs on `sales`
 *  growing rather than watching `phase`, because by the time this client
 *  learns about a sale the phase has usually already advanced to the next
 *  nomination (or to `complete`) in the same event batch. */
function useJustSold(sales: SaleRecord[]): SaleRecord | null {
  const [sold, setSold] = useState<SaleRecord | null>(null)
  const prevLen = useRef(sales.length)
  useEffect(() => {
    if (sales.length > prevLen.current) {
      prevLen.current = sales.length
      const latest = sales[sales.length - 1] ?? null
      setSold(latest)
      const t = setTimeout(() => setSold(null), 4_500)
      return () => clearTimeout(t)
    }
    prevLen.current = sales.length
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sales.length])
  return sold
}

const spotlightBox: CSSProperties = {
  position: 'relative',
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  padding: 'clamp(1.5rem, 4vmin, 4rem)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'clamp(0.5rem, 1.5vmin, 1.5rem)',
  textAlign: 'center',
  minHeight: 'clamp(14rem, 42vmin, 28rem)',
  flex: '0 0 auto',
}

/**
 * The TV board. Read from across a room: block spotlight, then every team's
 * budget and roster pips, then the recent-sales ticker. Fully non-interactive
 * — the board token cannot send commands, so nothing here is a `<button>`.
 * Defensive on a partial snapshot (missing `config`/`teams`) the same way
 * every other view in this app is: a malformed field must never blank the
 * screen it's on.
 */
export function BoardView({ client, view }: { client: DraftClient; view: DraftView }) {
  const state = view.state
  const sales = state?.sales ?? []
  const justSold = useJustSold(sales)

  if (!state) {
    return (
      <div className="label" style={{ padding: 'calc(var(--step) * 3)' }}>
        Joining the draft room…
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        gap: 'clamp(1rem, 2.5vmin, 2.5rem)',
        padding: 'clamp(1rem, 3vmin, 3rem)',
      }}
    >
      <BlockSpotlight client={client} state={state} justSold={justSold} />
      <TeamGrid state={state} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div className="label" style={{ marginBottom: 'calc(var(--step) / 2)', fontSize: 'clamp(0.7rem, 1.3vmin, 1rem)' }}>
          Recent sales
        </div>
        <SoldTicker sales={state.sales ?? []} players={state.config?.players ?? []} teams={state.teams ?? {}} />
      </div>
    </div>
  )
}

function BlockSpotlight({ client, state, justSold }: { client: DraftClient; state: DraftState; justSold: SaleRecord | null }) {
  const phase: Phase = state.phase ?? { type: 'lobby' }
  const players = state.config?.players ?? []
  const teams = state.teams ?? {}

  if (justSold) {
    const player = players.find(p => p.id === justSold.playerId)
    const team = teams[justSold.teamId]
    return (
      <div data-testid="block-spotlight" style={spotlightBox}>
        <span
          className="name"
          style={{
            color: 'var(--sold)',
            fontSize: 'clamp(2.5rem, 8vmin, 6rem)',
            animation: 'tick-roll 260ms ease-out',
          }}
        >
          SOLD
        </span>
        <span className="name" style={{ fontSize: 'clamp(1.5rem, 4vmin, 3.5rem)' }}>
          {player?.name ?? justSold.playerId}
        </span>
        <span style={{ fontSize: 'clamp(1.1rem, 2.6vmin, 2.2rem)', color: 'var(--ink)' }}>
          {`to ${team?.name ?? justSold.teamId} — $${justSold.price}`}
        </span>
      </div>
    )
  }

  if (phase.type === 'bidding') {
    return <BiddingSpotlight client={client} state={state} phase={phase} />
  }

  if (phase.type === 'paused') {
    return <PausedSpotlight state={state} phase={phase} />
  }

  if (phase.type === 'awaiting_nomination') {
    return <AwaitingNominationSpotlight client={client} state={state} phase={phase} />
  }

  if (phase.type === 'complete') {
    return (
      <div data-testid="block-spotlight" style={spotlightBox}>
        <span className="name" style={{ fontSize: 'clamp(2rem, 6vmin, 5rem)' }}>
          Draft complete
        </span>
      </div>
    )
  }

  // lobby
  return (
    <div data-testid="block-spotlight" style={spotlightBox}>
      <span className="name" style={{ fontSize: 'clamp(1.5rem, 4vmin, 3rem)' }}>
        Waiting for the commissioner to start
      </span>
    </div>
  )
}

function AwaitingNominationSpotlight({
  client,
  state,
  phase,
}: {
  client: DraftClient
  state: DraftState
  phase: Extract<TimedPhase, { type: 'awaiting_nomination' }>
}) {
  const msLeft = useLiveMsLeft(client, phase.deadline)
  const team = (state.teams ?? {})[phase.teamId]
  return (
    <div data-testid="block-spotlight" style={spotlightBox}>
      <span className="label" style={{ fontSize: 'clamp(0.9rem, 2vmin, 1.4rem)' }}>
        On the clock
      </span>
      <span className="name" style={{ fontSize: 'clamp(1.5rem, 4vmin, 3rem)' }}>
        {`${team?.name ?? phase.teamId} is nominating`}
      </span>
      <Countdown msLeft={msLeft} totalMs={state.config?.nominationClockMs ?? 1} />
    </div>
  )
}

function BiddingSpotlight({
  client,
  state,
  phase,
}: {
  client: DraftClient
  state: DraftState
  phase: Extract<TimedPhase, { type: 'bidding' }>
}) {
  const msLeft = useLiveMsLeft(client, phase.deadline)
  const totalMs = state.config?.bidClockMs ?? 1
  const player = state.config?.players?.find(p => p.id === phase.playerId)
  const leader = state.teams?.[phase.highBidderId]
  const { delta, key } = useTick(phase.price)
  const clockPhase = phaseFor(msLeft)
  const label = clockPhase !== 'urgent' ? 'ON THE BLOCK' : msLeft <= 1_500 ? 'GOING TWICE' : 'GOING ONCE'

  return (
    <div
      data-testid="block-spotlight"
      style={{
        ...spotlightBox,
        animation: clockPhase === 'urgent' ? 'urgency 1s ease-in-out infinite' : undefined,
      }}
    >
      <span
        className="label"
        style={{
          fontSize: 'clamp(1rem, 2.4vmin, 1.8rem)',
          ...(clockPhase === 'urgent' ? { color: 'var(--siren)', fontWeight: 800 } : undefined),
        }}
      >
        {label}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(0.5rem, 1.5vmin, 1.5rem)' }}>
        {player && <PositionChip position={player.position} />}
        <span className="name" style={{ fontSize: 'clamp(1.5rem, 4.5vmin, 4rem)' }}>
          {player?.name ?? phase.playerId}
        </span>
        {player && <span className="label" style={{ fontSize: 'clamp(0.8rem, 1.8vmin, 1.4rem)' }}>{player.nflTeam}</span>}
      </div>

      <div style={{ position: 'relative', display: 'inline-block' }}>
        <span key={key} style={{ display: 'inline-block', animation: 'tick-roll 220ms ease-out' }}>
          <Money value={phase.price} size="board" />
        </span>
        {delta !== null && (
          <span
            aria-hidden
            className="numerals"
            style={{
              position: 'absolute',
              top: 0,
              left: '100%',
              marginLeft: 'var(--step)',
              color: 'var(--brass)',
              fontSize: 'clamp(1.2rem, 3vmin, 2.5rem)',
              animation: 'delta-rise 900ms ease-out forwards',
            }}
          >
            {`+$${delta}`}
          </span>
        )}
      </div>

      <div style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 'clamp(1.1rem, 2.6vmin, 2.2rem)' }}>
        {`${leader?.name ?? phase.highBidderId} leading`}
      </div>

      <Countdown msLeft={msLeft} totalMs={totalMs} />
    </div>
  )
}

function PausedSpotlight({ state, phase }: { state: DraftState; phase: Extract<Phase, { type: 'paused' }> }) {
  const inner = phase.inner
  const teams = state.teams ?? {}
  const totalMs = inner.type === 'bidding' ? (state.config?.bidClockMs ?? 1) : (state.config?.nominationClockMs ?? 1)

  if (inner.type === 'bidding') {
    const player = state.config?.players?.find(p => p.id === inner.playerId)
    const leader = teams[inner.highBidderId]
    return (
      <div data-testid="block-spotlight" style={spotlightBox}>
        <span className="label" style={{ fontSize: 'clamp(0.9rem, 2vmin, 1.4rem)' }}>
          Paused
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(0.5rem, 1.5vmin, 1.5rem)' }}>
          {player && <PositionChip position={player.position} />}
          <span className="name" style={{ fontSize: 'clamp(1.5rem, 4.5vmin, 4rem)' }}>
            {player?.name ?? inner.playerId}
          </span>
        </div>
        <Money value={inner.price} size="board" />
        <div style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 'clamp(1.1rem, 2.6vmin, 2.2rem)' }}>
          {`${leader?.name ?? inner.highBidderId} leading`}
        </div>
        <Countdown msLeft={phase.remainingMs} totalMs={totalMs} />
      </div>
    )
  }

  const team = teams[inner.teamId]
  return (
    <div data-testid="block-spotlight" style={spotlightBox}>
      <span className="label" style={{ fontSize: 'clamp(0.9rem, 2vmin, 1.4rem)' }}>
        Paused
      </span>
      <span className="name" style={{ fontSize: 'clamp(1.5rem, 4vmin, 3rem)' }}>
        {`${team?.name ?? inner.teamId} is nominating`}
      </span>
      <Countdown msLeft={phase.remainingMs} totalMs={totalMs} />
    </div>
  )
}

function TeamGrid({ state }: { state: DraftState }) {
  const teams = Object.values(state.teams ?? {})
  const capacity = rosterCapacity(state.config?.rosterTemplate ?? [])

  return (
    <div
      data-testid="team-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(clamp(9rem, 18vmin, 15rem), 1fr))',
        gap: 'clamp(0.5rem, 1.4vmin, 1.25rem)',
      }}
    >
      {teams.map(team => {
        const roster = team.roster ?? []
        const open = Math.max(0, capacity - roster.length)
        return (
          <div
            key={team.id}
            data-testid={`team-card-${team.id}`}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              padding: 'clamp(0.6rem, 1.4vmin, 1.25rem)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'clamp(0.3rem, 1vmin, 0.6rem)',
            }}
          >
            <span className="name" style={{ fontSize: 'clamp(0.9rem, 2vmin, 1.6rem)' }}>
              {team.name}
            </span>
            <Money value={team.budget} size="row" />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} aria-hidden>
              {roster.map(entry => (
                <Pip key={entry.playerId} color={POSITION_COLOR[entry.position]} />
              ))}
              {Array.from({ length: open }).map((_, i) => (
                <Pip key={`open-${i}`} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Pip({ color }: { color?: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 'clamp(0.5rem, 1.1vmin, 0.9rem)',
        height: 'clamp(0.5rem, 1.1vmin, 0.9rem)',
        borderRadius: '50%',
        background: color ?? 'transparent',
        border: color ? 'none' : '1px solid var(--line)',
      }}
    />
  )
}
