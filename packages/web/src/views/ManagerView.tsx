import { useEffect, useState } from 'react'
import type { DraftClient, DraftView } from '../client/draftClient.js'
import { Countdown } from '../ui/Countdown.js'
import { Money } from '../ui/Money.js'
import { PositionChip } from '../ui/PositionChip.js'
import { Button } from '../ui/Button.js'
import { StatusHeader } from './StatusHeader.js'
import { BlockCard } from './BlockCard.js'
import { BidControls } from './BidControls.js'
import { NominateSheet } from './NominateSheet.js'
import { RosterSheet } from './RosterSheet.js'
import { TeamsSheet } from './TeamsSheet.js'
import { CommissionerBar } from './CommissionerBar.js'

/** Re-renders on an interval so a countdown driven by `client.msLeft` keeps
 *  counting down instead of freezing at whatever value was true when the
 *  underlying draft state last changed. */
function useLiveMsLeft(client: DraftClient, deadline: number): number {
  const [msLeft, setMsLeft] = useState(() => client.msLeft(deadline))
  useEffect(() => {
    setMsLeft(client.msLeft(deadline))
    const id = setInterval(() => setMsLeft(client.msLeft(deadline)), 200)
    return () => clearInterval(id)
  }, [client, deadline])
  return msLeft
}

export function ManagerView({ client, view }: { client: DraftClient; view: DraftView }) {
  const [sheet, setSheet] = useState<'roster' | 'teams' | null>(null)

  // Close the reference sheets the moment a new player hits the block. Checking your
  // roster between nominations is exactly what these are for, but a modal left open
  // over a live auction hides the bid buttons while a 10-second clock drains.
  const onBlock = view.state?.phase.type === 'bidding' ? view.state.phase.playerId : null
  useEffect(() => {
    if (onBlock) setSheet(null)
  }, [onBlock])

  if (!view.state) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {view.role === 'commissioner' && <CommissionerBar client={client} view={view} />}
      <StatusHeader view={view} />
      <div data-testid="phase-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <PhaseBody client={client} view={view} />
      </div>

      <div
        style={{
          display: 'flex',
          gap: 'var(--step)',
          padding: 'var(--step) calc(var(--step) * 2) calc(var(--step) * 2)',
          borderTop: '1px solid var(--line)',
        }}
      >
        <Button variant="ghost" onClick={() => setSheet('roster')}>
          Your roster
        </Button>
        <Button variant="ghost" onClick={() => setSheet('teams')}>
          All teams
        </Button>
      </div>

      {view.teamId && (
        <RosterSheet view={view} teamId={view.teamId} open={sheet === 'roster'} onClose={() => setSheet(null)} />
      )}
      <TeamsSheet view={view} open={sheet === 'teams'} onClose={() => setSheet(null)} />
    </div>
  )
}

function PhaseBody({ client, view }: { client: DraftClient; view: DraftView }) {
  const state = view.state!
  switch (state.phase.type) {
    case 'lobby':
      return <LobbyPhase view={view} />
    case 'awaiting_nomination':
      return <AwaitingNominationPhase client={client} view={view} />
    case 'bidding':
      return <BiddingPhase client={client} view={view} />
    case 'paused':
      return <PausedPhase view={view} />
    case 'complete':
      return <CompletePhase view={view} />
    default:
      return null
  }
}

function LobbyPhase({ view }: { view: DraftView }) {
  const state = view.state!
  // One manager on two devices is one seat, not two — dedupe by teamId before
  // ever touching the roster of who's actually here.
  const seatTeamIds = [...new Set(view.presence.map(p => p.teamId).filter((id): id is string => Boolean(id)))]
  const seats = seatTeamIds.map(id => state.config.teams.find(t => t.id === id)?.name ?? id)

  return (
    <div style={{ padding: 'calc(var(--step) * 3)' }}>
      <p className="name" style={{ fontSize: '1.25rem', margin: 0 }}>
        Waiting for the commissioner to start
      </p>
      <p className="label" style={{ marginTop: 'calc(var(--step) * 2)' }}>
        Connected
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {seats.length === 0 ? (
          <li style={{ color: 'var(--muted)' }}>Nobody else is here yet</li>
        ) : (
          seats.map(name => (
            <li key={name} style={{ padding: 'calc(var(--step) / 2) 0', color: 'var(--ink)' }}>
              {name}
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function AwaitingNominationPhase({ client, view }: { client: DraftClient; view: DraftView }) {
  const state = view.state!
  const phase = state.phase
  const deadline = phase.type === 'awaiting_nomination' ? phase.deadline : 0
  const msLeft = useLiveMsLeft(client, deadline)
  if (phase.type !== 'awaiting_nomination') return null
  const totalMs = state.config.nominationClockMs

  if (phase.teamId === view.teamId) {
    return (
      <div style={{ padding: 'calc(var(--step) * 3)' }}>
        <p className="name" style={{ fontSize: '1.25rem', margin: 0 }}>
          You're up — nominate a player
        </p>
        <div style={{ marginTop: 'var(--step)' }}>
          <Countdown msLeft={msLeft} totalMs={totalMs} />
        </div>
        <div data-testid="nominate-sheet-mount">
          <NominateSheet client={client} view={view} />
        </div>
      </div>
    )
  }

  const teamName = state.config.teams.find(t => t.id === phase.teamId)?.name ?? phase.teamId
  return (
    <div style={{ padding: 'calc(var(--step) * 3)' }}>
      <p className="name" style={{ fontSize: '1.25rem', margin: 0 }}>
        {teamName} is nominating
      </p>
      <div style={{ marginTop: 'var(--step)' }}>
        <Countdown msLeft={msLeft} totalMs={totalMs} />
      </div>
    </div>
  )
}

function BiddingPhase({ client, view }: { client: DraftClient; view: DraftView }) {
  const state = view.state!
  const phase = state.phase
  const deadline = phase.type === 'bidding' ? phase.deadline : 0
  const msLeft = useLiveMsLeft(client, deadline)
  if (phase.type !== 'bidding') return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, padding: 'calc(var(--step) * 2)' }}>
        <BlockCard view={view} msLeft={msLeft} totalMs={state.config.bidClockMs} />
      </div>
      <BidControls client={client} view={view} />
    </div>
  )
}

function PausedPhase({ view }: { view: DraftView }) {
  const state = view.state!
  const phase = state.phase
  if (phase.type !== 'paused') return null
  const totalMs = phase.inner.type === 'bidding' ? state.config.bidClockMs : state.config.nominationClockMs

  return (
    <div style={{ padding: 'calc(var(--step) * 3)' }}>
      <p className="name" style={{ fontSize: '1.25rem', margin: 0 }}>
        Draft paused by the commissioner
      </p>
      <div style={{ marginTop: 'var(--step)' }}>
        <Countdown msLeft={phase.remainingMs} totalMs={totalMs} />
      </div>
    </div>
  )
}

function CompletePhase({ view }: { view: DraftView }) {
  const state = view.state!
  const team = view.teamId ? state.teams[view.teamId] : null

  return (
    <div style={{ padding: 'calc(var(--step) * 3)' }}>
      <p className="name" style={{ fontSize: '1.25rem', margin: 0 }}>
        Draft complete
      </p>
      {team && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 'calc(var(--step) * 2) 0 0' }}>
          {team.roster.map(entry => {
            const player = state.config.players.find(p => p.id === entry.playerId)
            return (
              <li
                key={entry.playerId}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--step)', padding: 'calc(var(--step) / 2) 0' }}
              >
                <PositionChip position={entry.position} />
                <span className="name" style={{ flex: 1 }}>
                  {player?.name ?? entry.playerId}
                </span>
                <Money value={entry.price} size="inline" />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
