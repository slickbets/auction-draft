import { initialState, run, type DraftState, type Command } from '../src/index.js'
import { testConfig } from './fixtures.js'
import type { LeagueConfig } from '../src/types.js'

export function startedDraft(overrides: Partial<LeagueConfig> = {}, now = 1000): DraftState {
  const r = run(initialState(testConfig(overrides)), { type: 'START_DRAFT', now })
  if (!r.ok) throw new Error('failed to start draft')
  return r.state
}

/** Run a command that must succeed; throws (failing the test) otherwise. */
export function mustRun(s: DraftState, cmd: Command): DraftState {
  const r = run(s, cmd)
  if (!r.ok) throw new Error(`${cmd.type} failed: ${r.error.code}`)
  return r.state
}
