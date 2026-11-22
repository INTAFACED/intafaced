import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  decimal,
  otcAcceptAnswer,
  otcConvertBoundsAnswer,
  otcMakersAnswer,
  otcSettleAnswer,
  otcConvertQuoteAnswer,
} from './trade-call-schemas.js';
import { orderSideSchema } from './order-enums.js';

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
  refusals: {
    'trade.otc_desk_law_blank': 'PRECONDITION_FAILED',
    'trade.otc_last_look_forbidden': 'BAD_REQUEST',
    'trade.otc_quote_expired': 'BAD_REQUEST',
    'trade.otc_quote_missing': 'NOT_FOUND',
  },
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
  refusals: { 'trade.otc_desk_law_blank': 'PRECONDITION_FAILED', 'trade.otc_quote_missing': 'NOT_FOUND' },
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

/** Bounds-gated OTC quote for one-click buy / convert. The desk names the price. */
export const TRADE_OTC_CONVERT_QUOTE = defineProcedure({
  ...base,
  name: 'trade.otc.convertQuote',
  kind: 'mutation',
  path: 'otc.convertQuote',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: { 'trade.otc_desk_law_blank': 'PRECONDITION_FAILED' },
  input: z
    .object({
      flow: z.enum(['convert', 'oneClickBuy']),
      side: orderSideSchema,
      baseAsset: z.string().min(1).max(32),
      quoteAsset: z.string().min(1).max(32),
      qty: decimal,
    })
    .strict(),
  output: otcConvertQuoteAnswer,
  samples: [
    { verdict: 'accept', input: { flow: 'convert', side: 'buy', baseAsset: 'USDC', quoteAsset: 'USDC', qty: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});
