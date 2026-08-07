import type { DraftClient } from './client/draftClient.js'
import { useDraft } from './useDraft.js'
import { Screen, Banner } from './ui/Screen.js'
import { ManagerView } from './views/ManagerView.js'
import { BoardView } from './views/BoardView.js'

export function App({ client }: { client: DraftClient }) {
  const view = useDraft(client)

  if (view.status === 'rejected') {
    return (
      <Screen>
        <div style={{ padding: 'calc(var(--step) * 3)' }}>
          <h1 className="name">This link isn't valid</h1>
          <p style={{ color: 'var(--muted)' }}>
            Ask the commissioner to re-send your invite. Open it exactly as sent — the part after the # is what
            identifies your team.
          </p>
        </div>
      </Screen>
    )
  }

  if (!view.state) {
    return (
      <Screen>
        <div style={{ padding: 'calc(var(--step) * 3)' }} className="label">
          Joining the draft room…
        </div>
      </Screen>
    )
  }

  const banner = view.status === 'reconnecting' ? <Banner tone="warn">Reconnecting — your bids are safe</Banner> : undefined

  return (
    <Screen banner={banner}>
      {view.role === 'board' ? <BoardView view={view} /> : <ManagerView client={client} view={view} />}
    </Screen>
  )
}
