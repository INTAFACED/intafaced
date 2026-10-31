import { z } from 'zod';
import { orderSideSchema } from '@intafaced/exchange-contract';
import { MAX_ALGO_SEED } from './schedule.js';
import { POV_BASES } from './types.js';

/** The kinds an engine runs. */
export const ALGO_KINDS = ['twap', 'vwap', 'pov', 'chase'] as const;

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

/** One algo create, as the web's `trade.algo.createTwap` and the public `POST /api/v1/algo` take it. */
export const algoCreateInputSchema = z.object({
  symbol: z.string().min(3),
  side: orderSideSchema,
  totalQty: decimal,
  durationMs: z.number().int().min(1_000).max(86_400_000),
  sliceIntervalMs: z.number().int().min(1_000).max(86_400_000),
  limitPrice: decimal.optional(),
  clientAlgoId: z.string().trim().min(1).max(48),
  subAccountId: z.string().guid().optional(),
  kind: z.enum(ALGO_KINDS).optional(),
  participationBps: z.number().int().min(1).max(10_000).optional(),
  chaseDistanceBps: z.number().int().min(1).max(10_000).optional(),
  povBasis: z.enum(POV_BASES).optional(),
  randomSeed: z.number().int().min(0).max(MAX_ALGO_SEED).optional(),
  triggerPrice: decimal.optional(),
});

export type AlgoCreateInput = z.infer<typeof algoCreateInputSchema>;
