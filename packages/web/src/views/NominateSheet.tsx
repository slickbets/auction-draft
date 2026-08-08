import { useEffect, useState } from 'react'
import { maxBid } from '@auction/engine'
import type { DraftClient, DraftView } from '../client/draftClient.js'
import { searchPlayers } from '../playerSearch.js'
import { Sheet } from '../ui/Sheet.js'
import { Button } from '../ui/Button.js'
import { PositionChip } from '../ui/PositionChip.js'
import { Countdown } from '../ui/Countdown.js'

/** Re-renders on an interval so the countdown embedded in this sheet keeps
 *  counting down. Mirrors ManagerView's own tick hook — kept local (not
 *  exported/shared) because this sheet needs a live clock of its own: once it
 *  opens it visually covers the awaiting_nomination screen's countdown, so the
 *  clock has to live inside the sheet for "the nomination countdown stays
 *  visible" to hold true while the sheet is up. */
function useLiveMsLeft(client: DraftClient, deadline: number): number {
  const [msLeft, setMsLeft] = useState(() => client.msLeft(deadline))
  useEffect(() => {
    setMsLeft(client.msLeft(deadline))
    const id = setInterval(() => setMsLeft(client.msLeft(deadline)), 200)
    return () => clearInterval(id)
  }, [client, deadline])
  return msLeft
}

/**
 * The nomination flow. `open` is derived from `view` on every render — never
 * from local state — so a server-driven phase change (the clock running out
 * and the server auto-nominating) closes this sheet by the same mechanism
 * that opened it, instead of local UI state fighting what the server just
 * did. Escape/backdrop dismissal is deliberately not wired to a local
 * "closed by the user" flag for the same reason: nominating is the one thing
 * to do in this phase, so the only path back to closed is the state actually
 * moving on.
 */
export function NominateSheet({ client, view }: { client: DraftClient; view: DraftView }) {
  const state = view.state
  const phase = state?.phase
  const isMyTurn = Boolean(
    state && view.teamId && phase?.type === 'awaiting_nomination' && phase.teamId === view.teamId,
  )
  const deadline = isMyTurn && phase?.type === 'awaiting_nomination' ? phase.deadline : 0
  const msLeft = useLiveMsLeft(client, deadline)

  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openingBid, setOpeningBid] = useState(1)
  const [pending, setPending] = useState(false)

  // A new turn (a fresh deadline) starts from a clean slate — relevant the
  // next time the rotation comes back around to this same manager.
  useEffect(() => {
    if (!isMyTurn) return
    setQuery('')
    setSelectedId(null)
    setOpeningBid(1)
  }, [deadline, isMyTurn])

  const team = state && view.teamId ? (state.teams[view.teamId] ?? null) : null
  const max = team && state ? Math.max(1, maxBid(team, state.config)) : 1
  const results = state && view.teamId ? searchPlayers(state, view.teamId, query) : []
  const selected = selectedId && state ? (state.config.players.find(p => p.id === selectedId) ?? null) : null

  const clamp = (n: number) => Math.min(max, Math.max(1, n))

  const nominate = async () => {
    if (!selected || !view.teamId) return
    setPending(true)
    await client.send({ type: 'NOMINATE', teamId: view.teamId, playerId: selected.id, openingBid })
    setPending(false)
  }

  return (
    <Sheet open={isMyTurn} onClose={() => {}} title="Nominate a player">
      <div style={{ marginBottom: 'calc(var(--step) * 2)' }}>
        <Countdown msLeft={msLeft} totalMs={state?.config.nominationClockMs ?? 1} />
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="label">Search players</span>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Player name"
          aria-label="Search players"
          style={{
            minHeight: 44,
            background: 'var(--pitch)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            color: 'var(--ink)',
            padding: '0 var(--step)',
            fontSize: '1rem',
          }}
        />
      </label>

      <ul style={{ listStyle: 'none', padding: 0, margin: 'var(--step) 0 0', maxHeight: '40vh', overflowY: 'auto' }}>
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
                minHeight: 44,
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
              <span className="label">{p.nflTeam}</span>
            </button>
          </li>
        ))}
        {results.length === 0 && <li style={{ color: 'var(--muted)', padding: 'var(--step) 0' }}>No players match</li>}
      </ul>

      {selected && (
        <div style={{ marginTop: 'calc(var(--step) * 2)', display: 'flex', flexDirection: 'column', gap: 'var(--step)' }}>
          <span className="label">Opening bid</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--step)' }}>
            <Button variant="ghost" disabled={openingBid <= 1} onClick={() => setOpeningBid(b => clamp(b - 1))}>
              −
            </Button>
            <span
              className="numerals"
              style={{ fontSize: '1.5rem', color: 'var(--brass)', minWidth: '3ch', textAlign: 'center' }}
            >
              {openingBid}
            </span>
            <Button variant="ghost" disabled={openingBid >= max} onClick={() => setOpeningBid(b => clamp(b + 1))}>
              +
            </Button>
            <span className="label">{`Max $${max}`}</span>
          </div>
          <Button variant="bid" disabled={pending} onClick={nominate}>
            {`Nominate ${selected.name}`}
          </Button>
        </div>
      )}
    </Sheet>
  )
}
