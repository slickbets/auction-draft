import { z } from 'zod'
import type { WireCommand } from './room.js'

const money = z.number().int().min(1).max(10_000)
const clockMs = z.number().int().min(1_000).max(600_000)

export const WireCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('START_DRAFT') }),
  z.object({ type: z.literal('NOMINATE'), teamId: z.string(), playerId: z.string(), openingBid: money }),
  z.object({ type: z.literal('BID'), teamId: z.string(), amount: money }),
  z.object({ type: z.literal('CLOCK_EXPIRED') }),
  z.object({ type: z.literal('PAUSE') }),
  z.object({ type: z.literal('RESUME') }),
  z.object({ type: z.literal('ADD_TIME'), ms: z.number().int().min(1_000).max(600_000) }),
  z.object({ type: z.literal('SET_TIMERS'), bidClockMs: clockMs.optional(), nominationClockMs: clockMs.optional() }),
  z.object({ type: z.literal('UNDO_SALE') }),
  z.object({ type: z.literal('EDIT_PICK'), overall: z.number().int().min(1), newTeamId: z.string().optional(), newPrice: money.optional() }),
  z.object({ type: z.literal('ADJUST_BUDGET'), teamId: z.string(), delta: z.number().int().min(-1_000).max(1_000).refine(d => d !== 0, 'delta must be nonzero') }),
])

export function parseWireCommand(input: unknown): WireCommand {
  return WireCommandSchema.parse(input) as WireCommand
}
