import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  algoResultOutputSchema,
  algoScheduleHonestySchema,
  algoStopReasonSchema,
  decimal,
  MAX_ALGO_SEED,
  algoParentOutputSchema,
  algoGetOutputSchema,
  algoPolicyAnswer,
  algoCreateInputSchema,
  algoListAnswer,
} from './trade-call-schemas.js';

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
  refusals: { 'trade.market_not_found': 'NOT_FOUND' },
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

export const TRADE_ALGO_GET = defineProcedure({
  ...base,
  name: 'trade.algo.get',
  kind: 'query',
  path: 'algo.get',
  access: { caller: 'scope', scope: 'trade:read' },
  refusals: {},
  input: z.object({ algoId: z.string().min(1) }),
  output: algoGetOutputSchema,
  samples: [
    { verdict: 'accept', input: { algoId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_ALGO_PAUSE = defineProcedure({
  ...base,
  name: 'trade.algo.pause',
  kind: 'mutation',
  path: 'algo.pause',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ algoId: z.string().min(1) }),
  output: algoParentOutputSchema,
  samples: [
    { verdict: 'accept', input: { algoId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_ALGO_RESUME = defineProcedure({
  ...base,
  name: 'trade.algo.resume',
  kind: 'mutation',
  path: 'algo.resume',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: { 'trade.algo_resume_extends_too_far': 'BAD_REQUEST' },
  input: z.object({ algoId: z.string().min(1) }),
  output: algoParentOutputSchema,
  samples: [
    { verdict: 'accept', input: { algoId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_ALGO_CANCEL = defineProcedure({
  ...base,
  name: 'trade.algo.cancel',
  kind: 'mutation',
  path: 'algo.cancel',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ algoId: z.string().min(1) }),
  output: algoParentOutputSchema,
  samples: [
    { verdict: 'accept', input: { algoId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_ALGO_POLICY = defineProcedure({
  ...base,
  name: 'trade.algo.policy',
  kind: 'query',
  path: 'algo.policy',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: algoPolicyAnswer,
  samples: [{ verdict: 'accept' }],
});

export const TRADE_ALGO_CREATE_TWAP = defineProcedure({
  ...base,
  name: 'trade.algo.createTwap',
  kind: 'mutation',
  path: 'algo.createTwap',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {
    'trade.algo_disabled': 'BAD_REQUEST',
    'trade.algo_mark_missing': 'BAD_REQUEST',
    'trade.bots_verification_insufficient': 'FORBIDDEN',
    'trade.bots_verification_level_not_set': 'FORBIDDEN',
    'trade.spot_disabled': 'FORBIDDEN',
  },
  input: algoCreateInputSchema,
  output: algoParentOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: { symbol: 'USDC', side: 'buy', totalQty: '1', durationMs: 1000, sliceIntervalMs: 1000, clientAlgoId: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_ALGO_LIST = defineProcedure({
  ...base,
  name: 'trade.algo.list',
  kind: 'query',
  path: 'algo.list',
  access: { caller: 'scope', scope: 'trade:read' },
  refusals: { 'trade.algo_list_limit_unset': 'PRECONDITION_FAILED' },
  input: z.object({
    status: z.string().optional(),
    kind: z.string().optional(),
    from: z.string().optional(),
    limit: z.number().int().optional(),
    cursor: z.string().optional(),
  }),
  output: algoListAnswer,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
