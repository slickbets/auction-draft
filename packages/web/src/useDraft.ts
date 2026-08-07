import { useSyncExternalStore } from 'react'
import type { DraftClient, DraftView } from './client/draftClient.js'

export function readToken(): string | null {
  const raw = window.location.hash.replace(/^#/, '').trim()
  return raw.length > 0 ? raw : null
}

export function useDraft(client: DraftClient): DraftView {
  return useSyncExternalStore(
    cb => client.subscribe(cb),
    () => client.view,
  )
}
