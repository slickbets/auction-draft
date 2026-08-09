import { useState } from 'react'
import { maxBid } from '@auction/engine'
import type { DraftClient, DraftView } from '../client/draftClient.js'
import { bidState } from '../bidRules.js'
import { searchPlayers } from '../playerSearch.js'
import { Button } from '../ui/Button.js'
import { PositionChip } from '../ui/PositionChip.js'

/**
 * The compact bar pinned above the manager view for `role === 'commissioner'`.
 * Only what running a live draft requires: start, pause/resume, +30s, and a
 * proxy nominate/bid so the commissioner can stand in for a team that's AFK.
 *
 * Deliberately NOT here: undo sale, edit pick, adjust budget. Those land in
 * Plan 4 with confirmation flows — an accidental undo mid-draft is worse than
 * a slow correction, so this bar does not offer a fast path to either.
 */
export function CommissionerBar({ client, view }: { client: DraftClient; view: DraftView }) {
  const state = view.state
  const [noPlayers, setNoPlayers] = useState(false)
  const [proxyTeamId, setProxyTeamId] = useState('')
  const [proxyMode, setProxyMode] = useState<'nominate' | 'bid' | null>(null)

  // Defensive beyond what the type promises: a partial/malformed snapshot must
  // never crash this bar and take the manager view behind it down too.
  if (!state || !state.config || !state.teams) return null

  const phase = state.phase
  const isLobby = phase.type === 'lobby'
  const isPaused = phase.type === 'paused'
  const canPause = phase.type === 'awaiting_nomination' || phase.type === 'bidding'
  const canAddTime = canPause || isPaused

  const teams = state.config.teams ?? []
  const proxyTeam = teams.find(t => t.id === proxyTeamId) ?? null

  async function startDraft() {
    setNoPlayers(false)
    const ack = await client.send({ type: 'START_DRAFT' })
    if (!ack.ok && ack.error.code === 'NO_PLAYERS') setNoPlayers(true)
  }

  async function togglePause() {
    await client.send({ type: isPaused ? 'RESUME' : 'PAUSE' })
  }

  async function addTime() {
    await client.send({ type: 'ADD_TIME', ms: 30_000 })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--step)',
        padding: 'calc(var(--step) * 1.5) calc(var(--step) * 2)',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 'var(--step)' }}>
        <Button
          variant="ghost"
          disabled={!isLobby}
          reason={!isLobby ? 'Only available before the draft starts' : undefined}
          onClick={startDraft}
        >
          Start draft
        </Button>
        <Button
          variant="ghost"
          disabled={!isPaused && !canPause}
          reason={!isPaused && !canPause ? 'Nothing running to pause' : undefined}
          onClick={togglePause}
        >
          {isPaused ? 'Resume' : 'Pause'}
        </Button>
        <Button variant="ghost" disabled={!canAddTime} reason={!canAddTime ? 'No clock to extend' : undefined} onClick={addTime}>
          +30s
        </Button>
      </div>

      {noPlayers && (
        <p role="alert" style={{ margin: 0, color: 'var(--siren)' }}>
          The player pool is empty or too small. Refresh players before starting.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 'var(--step)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="label">Acting as</span>
          <select
            aria-label="Acting as"
            value={proxyTeamId}
            onChange={e => {
              setProxyTeamId(e.target.value)
              setProxyMode(null)
            }}
            style={{
              minHeight: 40,
              background: 'var(--pitch)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              color: 'var(--ink)',
              padding: '0 var(--step)',
            }}
          >
            <option value="">Choose a team…</option>
            {teams.map(t => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <Button
          variant="ghost"
          disabled={!proxyTeam}
          reason={!proxyTeam ? 'Choose a team first' : undefined}
          onClick={() => setProxyMode(m => (m === 'nominate' ? null : 'nominate'))}
        >
          {proxyTeam ? `Nominate for ${proxyTeam.name}` : 'Nominate for…'}
        </Button>
        <Button
          variant="ghost"
          disabled={!proxyTeam}
          reason={!proxyTeam ? 'Choose a team first' : undefined}
          onClick={() => setProxyMode(m => (m === 'bid' ? null : 'bid'))}
        >
          {proxyTeam ? `Bid for ${proxyTeam.name}` : 'Bid for…'}
        </Button>
      </div>

      {proxyTeam && proxyMode === 'nominate' && (
        <ProxyNominatePanel client={client} view={view} teamId={proxyTeam.id} teamName={proxyTeam.name} />
      )}
      {proxyTeam && proxyMode === 'bid' && <ProxyBidPanel client={client} view={view} teamId={proxyTeam.id} teamName={proxyTeam.name} />}
    </div>
  )
}

function ProxyNominatePanel({
  client,
  view,
  teamId,
  teamName,
}: {
  client: DraftClient
  view: DraftView
  teamId: string
  teamName: string
}) {
  const state = view.state!
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openingBid, setOpeningBid] = useState(1)
  const [pending, setPending] = useState(false)

  const team = state.teams[teamId]
  const max = team ? Math.max(1, maxBid(team, state.config)) : 1
  const results = searchPlayers(state, teamId, query)
  const selected = selectedId ? (state.config.players.find(p => p.id === selectedId) ?? null) : null

  const nominate = async () => {
    if (!selected) return
    setPending(true)
    await client.send({ type: 'NOMINATE', teamId, playerId: selected.id, openingBid })
    setPending(false)
  }

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        padding: 'var(--step)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--step)',
      }}
    >
      <p className="label" style={{ margin: 0 }}>{`Nominating for ${teamName}`}</p>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="label">Search players</span>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search players for proxy nomination"
          style={{
            minHeight: 40,
            background: 'var(--pitch)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            color: 'var(--ink)',
            padding: '0 var(--step)',
          }}
        />
      </label>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '30vh', overflowY: 'auto' }}>
        {results.map(p => (
          <li key={p.id} style={{ marginBottom: 4 }}>
            <button
              type="button"
              onClick={() => setSelectedId(p.id)}
              aria-pressed={selectedId === p.id}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--step)',
                minHeight: 40,
                padding: '0 var(--step)',
                background: selectedId === p.id ? 'var(--line)' : 'transparent',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius)',
                color: 'var(--ink)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <PositionChip position={p.position} />
              <span className="name" style={{ flex: 1 }}>
                {p.name}
              </span>
            </button>
          </li>
        ))}
        {results.length === 0 && <li style={{ color: 'var(--muted)' }}>No players match</li>}
      </ul>

      {selected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--step)' }}>
          <Button variant="ghost" disabled={openingBid <= 1} onClick={() => setOpeningBid(b => Math.max(1, b - 1))}>
            −
          </Button>
          <span className="numerals" style={{ color: 'var(--brass)', minWidth: '3ch', textAlign: 'center' }}>
            {openingBid}
          </span>
          <Button variant="ghost" disabled={openingBid >= max} onClick={() => setOpeningBid(b => Math.min(max, b + 1))}>
            +
          </Button>
          <span className="label">{`Max $${max}`}</span>
          <Button variant="bid" disabled={pending} onClick={nominate}>
            {`Nominate ${selected.name} for ${teamName}`}
          </Button>
        </div>
      )}
    </div>
  )
}

function ProxyBidPanel({
  client,
  view,
  teamId,
  teamName,
}: {
  client: DraftClient
  view: DraftView
  teamId: string
  teamName: string
}) {
  const state = view.state!
  const [pending, setPending] = useState(false)
  const phase = state.phase

  if (phase.type !== 'bidding') {
    return (
      <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 'var(--step)' }}>
        <p className="label" style={{ margin: 0 }}>{`Bidding for ${teamName}`}</p>
        <p style={{ color: 'var(--muted)', margin: 'calc(var(--step) / 2) 0 0' }}>No player is on the block right now.</p>
      </div>
    )
  }

  // Mirrors the display-only guardrails a manager sees for their own team, just
  // evaluated as if the proxy team were the viewer — so the same disabled
  // reasons ("Max bid $X", "No open spot for a Y", "You're leading") apply.
  const proxyView: DraftView = { ...view, teamId }
  const plusOne = phase.price + 1
  const plusFive = phase.price + 5
  const oneState = bidState(proxyView, plusOne)
  const fiveState = bidState(proxyView, plusFive)

  const submit = async (amount: number) => {
    setPending(true)
    await client.send({ type: 'BID', teamId, amount })
    setPending(false)
  }

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        padding: 'var(--step)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--step)',
      }}
    >
      <p className="label" style={{ margin: 0 }}>{`Bidding for ${teamName}`}</p>
      <div style={{ display: 'flex', gap: 'var(--step)' }}>
        <Button variant="bid" disabled={pending || !oneState.allowed} reason={oneState.reason} onClick={() => submit(plusOne)}>
          {`+$1 for ${teamName} → ${plusOne}`}
        </Button>
        <Button variant="bid" disabled={pending || !fiveState.allowed} reason={fiveState.reason} onClick={() => submit(plusFive)}>
          {`+$5 for ${teamName} → ${plusFive}`}
        </Button>
      </div>
    </div>
  )
}
