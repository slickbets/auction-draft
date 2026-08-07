import type { DraftClient, DraftView } from '../client/draftClient.js'

export function ManagerView({ client, view }: { client: DraftClient; view: DraftView }) {
  return <div className="label">{view.role}</div>
}
