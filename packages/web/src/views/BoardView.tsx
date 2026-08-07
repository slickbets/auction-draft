import type { DraftView } from '../client/draftClient.js'

export function BoardView({ view }: { view: DraftView }) {
  return <div className="label">{view.role}</div>
}
