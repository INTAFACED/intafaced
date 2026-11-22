import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { algoResultOutputSchema, algoScheduleHonestySchema, algoStopReasonSchema, decimal, MAX_ALGO_SEED } from './trade-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `algo.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

export const TRADE_ALGO_PROGRESS = defineProcedure({
  ...base,
  name: 'trade.algo.progress',
  kind: 'query',
  path: 'algo.progress',
  access: { caller: 'scope', scope: 'trade:read' },
  refusals: {},
  input: z.object({ algoId: z.string().min(1) }),
  output: z.object({
    parentId: z.string(),
    status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
    haltReason: z.string().nullable(),
    stopReason: algoStopReasonSchema,
    childrenEmitted: z.number().int(),
    missesRecorded: z.number().int(),
    slicesPlanned: z.number().int(),
    nextSliceIndex: z.number().int(),
    filledQty: decimal,
    totalQty: decimal,
    ...algoScheduleHonestySchema,
  }),
  samples: [
    { verdict: 'accept', input: { algoId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_ALGO_PREVIEW_TWAP_SIZES = defineProcedure({
  ...base,
  name: 'trade.algo.previewTwapSizes',
  kind: 'query',
  path: 'algo.previewTwapSizes',
  access: { caller: 'scope', scope: 'trade:read' },
  refusals: {},
  input: z.object({
    symbol: z.string().min(3),
    totalQty: decimal,
    durationMs: z.number().int().min(1_000).max(86_400_000),
    sliceIntervalMs: z.number().int().min(1_000).max(86_400_000),
    randomSeed: z.number().int().min(0).max(MAX_ALGO_SEED).optional(),
  }),
  output: z.object({ sliceQtys: z.array(decimal) }),
  samples: [
    { verdict: 'accept', input: { symbol: 'USDC', totalQty: '1', durationMs: 1000, sliceIntervalMs: 1000 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_ALGO_RESULT = defineProcedure({
  ...base,
  name: 'trade.algo.result',
  kind: 'query',
  path: 'algo.result',
  access: { caller: 'scope', scope: 'trade:read' },
  refusals: {},
  input: z.object({ algoId: z.string().min(1) }),
  output: algoResultOutputSchema,
  samples: [
    { verdict: 'accept', input: { algoId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
