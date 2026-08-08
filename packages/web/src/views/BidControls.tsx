import { useState } from 'react'
import type { DraftClient, DraftView } from '../client/draftClient.js'
import { bidState } from '../bidRules.js'
import { Button } from '../ui/Button.js'

/**
 * Maps a rejected ack's error code to plain, in-the-room copy. Computed fresh at
 * render time from the CURRENT `view` (never from a value captured when the bid
 * was sent) so the number quoted reflects whatever the client has since learned
 * about the price — which, on a real socket, is already the up-to-date price by
 * the time a rejected ack comes back (the winning bid's broadcast always lands
 * on this same connection before our own command's ack does).
 */
function rejectionCopy(view: DraftView, code: string): string {
  const state = view.state
  const phase = state && state.phase.type === 'bidding' ? state.phase : null
  switch (code) {
    case 'STALE_PRICE':
      return phase
        ? `Someone bid $${phase.price} first. Bid again to stay in.`
        : 'Someone bid first. Bid again to stay in.'
    case 'EXCEEDS_MAX_BID':
      return "That's over your max bid."
    case 'NO_ELIGIBLE_SLOT': {
      const player = phase && state ? state.config.players.find(p => p.id === phase.playerId) : undefined
      return player ? `You have no open spot for a ${player.position}.` : 'You have no open spot for this player.'
    }
    default:
      return "That bid didn't go through. Try again."
  }
}

/**
 * `+$1` / `+$5` quick bids plus a custom amount, sent as `{ type: 'BID', teamId,
 * amount }` for the viewer's own team. Only structurally impossible bids (no
 * eligible slot, can't afford it, already leading) are disabled — never a bid
 * that merely looks stale against the locally-known price, so a manager can
 * always re-raise immediately after a rejection.
 */
export function BidControls({ client, view }: { client: DraftClient; view: DraftView }) {
  const [custom, setCustom] = useState('')
  const [pending, setPending] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  const state = view.state
  if (!state || state.phase.type !== 'bidding' || !view.teamId) return null
  const phase = state.phase
  const teamId = view.teamId

  const plusOne = phase.price + 1
  const plusFive = phase.price + 5
  const oneState = bidState(view, plusOne)
  const fiveState = bidState(view, plusFive)

  const trimmed = custom.trim()
  const parsedCustom = Number.parseInt(trimmed, 10)
  const customValid = trimmed !== '' && Number.isInteger(parsedCustom) && parsedCustom > 0 && String(parsedCustom) === trimmed
  const customBidState = customValid ? bidState(view, parsedCustom) : { allowed: false }

  const submit = async (amount: number) => {
    setErrorCode(null)
    setPending(true)
    const ack = await client.send({ type: 'BID', teamId, amount })
    setPending(false)
    if (ack.ok) {
      setCustom('')
    } else {
      setErrorCode(ack.error.code)
    }
  }

  return (
    <div
      style={{
        marginTop: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--step)',
        padding: 'calc(var(--step) * 2)',
        borderTop: '1px solid var(--line)',
        background: 'var(--surface)',
      }}
    >
      {errorCode && (
        <p role="alert" style={{ margin: 0, color: 'var(--siren)' }}>
          {rejectionCopy(view, errorCode)}
        </p>
      )}

      <div style={{ display: 'flex', gap: 'var(--step)' }}>
        <Button variant="bid" disabled={pending || !oneState.allowed} reason={oneState.reason} onClick={() => submit(plusOne)}>
          {`+$1 → ${plusOne}`}
        </Button>
        <Button variant="bid" disabled={pending || !fiveState.allowed} reason={fiveState.reason} onClick={() => submit(plusFive)}>
          {`+$5 → ${plusFive}`}
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--step)', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
          <span className="label">Custom bid</span>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={custom}
            onChange={e => setCustom(e.target.value)}
            aria-label="Custom bid amount"
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
        <Button
          variant="bid"
          disabled={pending || !customValid || !customBidState.allowed}
          reason={customValid ? customBidState.reason : undefined}
          onClick={() => submit(parsedCustom)}
        >
          Bid
        </Button>
      </div>
    </div>
  )
}
