export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST'

export interface PlayerInfo {
  id: string
  name: string
  position: Position
  nflTeam: string
  rank: number // lower = better; drives search order and auto-nomination
}

export interface SlotDef {
  name: string // e.g. 'QB', 'FLEX', 'BENCH'
  eligible: Position[]
  count: number
}

export interface TeamConfig { id: string; name: string }

export interface LeagueConfig {
  teams: TeamConfig[]
  budget: number
  rosterTemplate: SlotDef[] // ordered; SOLD assigns to first eligible open slot
  bidClockMs: number
  nominationClockMs: number
  nominationOrder: string[] // team ids, rotation order
  nominationExpiryPolicy: 'auto_nominate' | 'skip'
  players: PlayerInfo[]
}

export interface RosterEntry { playerId: string; price: number; slot: string }

export interface TeamState { id: string; name: string; budget: number; roster: RosterEntry[] }

export interface SaleRecord {
  playerId: string
  teamId: string
  price: number
  nominatorId: string
  pointerBefore: number // nomination-order index when this auction began
  overall: number // 1-based nomination number
}

export type TimedPhase =
  | { type: 'awaiting_nomination'; teamId: string; deadline: number }
  | { type: 'bidding'; playerId: string; price: number; highBidderId: string; nominatorId: string; deadline: number }

export type Phase =
  | { type: 'lobby' }
  | TimedPhase
  | { type: 'paused'; inner: TimedPhase; remainingMs: number }
  | { type: 'complete' }

export interface DraftState {
  config: LeagueConfig
  phase: Phase
  teams: Record<string, TeamState>
  available: string[] // player ids still in the pool
  pointer: number // index into nominationOrder for the current/next nominator
  sales: SaleRecord[]
  seq: number // count of applied events
}

export type Command =
  | { type: 'START_DRAFT'; now: number }
  | { type: 'NOMINATE'; teamId: string; playerId: string; openingBid: number; now: number }
  | { type: 'BID'; teamId: string; amount: number; now: number }
  | { type: 'CLOCK_EXPIRED'; now: number }
  | { type: 'PAUSE'; now: number }
  | { type: 'RESUME'; now: number }
  | { type: 'ADD_TIME'; ms: number; now: number }
  | { type: 'SET_TIMERS'; bidClockMs?: number; nominationClockMs?: number; now: number }
  | { type: 'UNDO_SALE'; now: number }
  | { type: 'EDIT_PICK'; overall: number; newTeamId?: string; newPrice?: number; now: number }
  | { type: 'ADJUST_BUDGET'; teamId: string; delta: number; now: number }

export type DraftEvent =
  | { type: 'DRAFT_STARTED'; at: number }
  | { type: 'NOMINATION_STARTED'; teamId: string; deadline: number; at: number }
  | { type: 'PLAYER_NOMINATED'; teamId: string; playerId: string; openingBid: number; deadline: number; at: number }
  | { type: 'BID_PLACED'; teamId: string; amount: number; deadline: number; at: number }
  | { type: 'SOLD'; playerId: string; teamId: string; price: number; slot: string; nominatorId: string; pointerBefore: number; overall: number; at: number }
  | { type: 'NOMINATION_SKIPPED'; teamId: string; at: number }
  | { type: 'DRAFT_PAUSED'; remainingMs: number; at: number }
  | { type: 'DRAFT_RESUMED'; deadline: number; at: number }
  | { type: 'TIME_ADDED'; ms: number; at: number }
  | { type: 'TIMER_CONFIG_CHANGED'; bidClockMs?: number; nominationClockMs?: number; at: number }
  | { type: 'SALE_UNDONE'; sale: SaleRecord; canceledInFlightPlayerId: string | null; nominationDeadline: number; at: number }
  | { type: 'PICK_EDITED'; overall: number; fromTeamId: string; toTeamId: string; oldPrice: number; newPrice: number; newSlot: string; at: number }
  | { type: 'BUDGET_ADJUSTED'; teamId: string; delta: number; at: number }
  | { type: 'DRAFT_COMPLETED'; at: number }

export type EngineErrorCode =
  | 'NOT_IN_LOBBY'
  | 'WRONG_PHASE'
  | 'NOT_YOUR_NOMINATION'
  | 'PLAYER_NOT_AVAILABLE'
  | 'INVALID_AMOUNT'
  | 'STALE_PRICE'
  | 'EXCEEDS_MAX_BID'
  | 'ALREADY_HIGH_BIDDER'
  | 'NO_ELIGIBLE_SLOT'
  | 'CLOCK_NOT_EXPIRED'
  | 'NOTHING_TO_UNDO'
  | 'UNKNOWN_TEAM'
  | 'INVALID_EDIT'
  | 'INVALID_ADJUSTMENT'

export interface EngineError { code: EngineErrorCode; message: string }

export type ExecuteResult =
  | { ok: true; events: DraftEvent[] }
  | { ok: false; error: EngineError }
