import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { convertPairsOutput, decimal, limitConvertOutput } from './trade-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `convert.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

/** What can be converted now, each coin with its per-conversion limit or none set (J-cex-spot-11 #1). */
export const TRADE_CONVERT_PAIRS = defineProcedure({
  ...base,
  name: 'trade.convert.pairs',
  kind: 'query',
  path: 'convert.pairs',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: convertPairsOutput,
  samples: [{ verdict: 'accept' }],
});

/** The caller's limit converts, newest first: waiting, filled, ended and cancelled. */
export const TRADE_CONVERT_LIMITS = defineProcedure({
  ...base,
  name: 'trade.convert.limits',
  kind: 'query',
  path: 'convert.limits',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(limitConvertOutput),
  samples: [{ verdict: 'accept' }],
});

/** Place a limit convert: the source held until a quote reaches the target rate, then settled once (#8). */
export const TRADE_CONVERT_LIMIT_PLACE = defineProcedure({
  ...base,
  name: 'trade.convert.limitPlace',
  kind: 'mutation',
  path: 'convert.limitPlace',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({
    symbol: z.string().min(3),
    side: z.enum(['buy', 'sell']),
    amount: decimal,
    targetRate: decimal,
    clientLimitId: z.string().min(8).max(64),
  }),
  output: limitConvertOutput,
  samples: [
    { verdict: 'accept', input: { symbol: 'USDC', side: 'buy', amount: '1', targetRate: '1', clientLimitId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Cancel a waiting limit convert: its hold released once. */
export const TRADE_CONVERT_LIMIT_CANCEL = defineProcedure({
  ...base,
  name: 'trade.convert.limitCancel',
  kind: 'mutation',
  path: 'convert.limitCancel',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ id: z.string().uuid() }),
  output: limitConvertOutput,
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** How one asset converts to another: a direct market, or a typed refusal such as a two-leg cash route (#11). */
export const TRADE_CONVERT_ROUTE = defineProcedure({
  ...base,
  name: 'trade.convert.route',
  kind: 'query',
  path: 'convert.route',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ from: z.string().regex(/^[A-Z0-9]{2,12}$/), to: z.string().regex(/^[A-Z0-9]{2,12}$/) }),
  output: z.object({ kind: z.literal('direct'), symbol: z.string(), side: z.enum(['buy', 'sell']) }),
  samples: [
    { verdict: 'accept', input: { from: 'USDC', to: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
