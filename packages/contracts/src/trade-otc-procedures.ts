import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { decimal, otcAcceptAnswer, otcConvertBoundsAnswer, otcMakersAnswer, otcSettleAnswer } from './trade-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `otc.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

export const TRADE_OTC_MAKERS_LIST = defineProcedure({
  ...base,
  name: 'trade.otc.makers.list',
  kind: 'query',
  path: 'otc.makers.list',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: otcMakersAnswer,
  samples: [{ verdict: 'accept' }],
});

export const TRADE_OTC_ACCEPT = defineProcedure({
  ...base,
  name: 'trade.otc.accept',
  kind: 'mutation',
  path: 'otc.accept',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z
    .object({
      quoteId: z.string().guid(),
      assertedPrice: decimal.optional(),
    })
    .strict(),
  output: otcAcceptAnswer,
  samples: [
    { verdict: 'accept', input: { quoteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_OTC_SETTLE = defineProcedure({
  ...base,
  name: 'trade.otc.settle',
  kind: 'mutation',
  path: 'otc.settle',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ quoteId: z.string().guid() }).strict(),
  output: otcSettleAnswer,
  samples: [
    { verdict: 'accept', input: { quoteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Owner bounds for one-click buy and convert at OTC pricing (CB-otc-12). */
export const TRADE_OTC_CONVERT_BOUNDS = defineProcedure({
  ...base,
  name: 'trade.otc.convertBounds',
  kind: 'query',
  path: 'otc.convertBounds',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: NO_INPUT,
  output: otcConvertBoundsAnswer,
  samples: [{ verdict: 'accept' }],
});
