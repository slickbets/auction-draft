import type { Ack, DraftClient, DraftView, WireCommand } from '../../src/client/draftClient.js'

export function makeFakeClient(initial: Partial<DraftView> = {}) {
  let view: DraftView = {
    status: 'live', seq: 0, state: null, role: 'manager', teamId: 'T1',
    presence: [], notice: null, lastError: null, ...initial,
  }
  const subs = new Set<(v: DraftView) => void>()
  const sent: WireCommand[] = []
  let nextAck: Ack = { ok: true }
  const client: DraftClient = {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
    get view() { return view },
    async send(cmd) { sent.push(cmd); return nextAck },
    msLeft(deadline) { return Math.max(0, deadline - Date.now()) },
    dismissError() { push({ lastError: null }) },
    close() { subs.clear() },
  }
  function push(patch: Partial<DraftView>) {
    view = { ...view, ...patch }
    for (const fn of [...subs]) fn(view)
  }
  return { client, push, sent, ack: (a: Ack) => { nextAck = a } }
}
