import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { decimal, firmRfqAnswer, rfqQuoteAnswer, rfqBoardAnswer } from './trade-call-schemas.js';
import { orderSideSchema } from './order-enums.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `rfq.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

export const TRADE_RFQ_GET = defineProcedure({
  ...base,
  name: 'trade.rfq.get',
  kind: 'query',
  path: 'rfq.get',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z.object({ quoteId: z.string().guid() }).strict(),
  output: firmRfqAnswer,
  samples: [
    { verdict: 'accept', input: { quoteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_RFQ_ACCEPT = defineProcedure({
  ...base,
  name: 'trade.rfq.accept',
  kind: 'mutation',
  path: 'rfq.accept',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ quoteId: z.string().guid(), assertedPrice: decimal.optional() }).strict(),
  output: firmRfqAnswer,
  samples: [
    { verdict: 'accept', input: { quoteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_RFQ_EXPIRE = defineProcedure({
  ...base,
  name: 'trade.rfq.expire',
  kind: 'mutation',
  path: 'rfq.expire',
  access: { caller: 'scope', scope: 'trade:write', module: 'trade' },
  refusals: {},
  input: z.object({ quoteId: z.string().guid() }).strict(),
  output: firmRfqAnswer,
  samples: [
    { verdict: 'accept', input: { quoteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_RFQ_QUOTE = defineProcedure({
  ...base,
  name: 'trade.rfq.quote',
  kind: 'mutation',
  path: 'rfq.quote',
  access: { caller: 'scope', scope: 'trade:read', module: 'trade' },
  refusals: {},
  input: z
    .object({
      side: orderSideSchema,
      baseAsset: z.string().min(1).max(32),
      quoteAsset: z.string().min(1).max(32),
      qty: z.string(),
      makerId: z.string().min(1).max(120).optional(),
      /** CB-otc-01: the providers this request asks, from `otc.makers.list`; the owner's cap is checked in the desk. */
      makerIds: z.array(z.string().max(120)).max(50).optional(),
    })
    .strict(),
  output: rfqQuoteAnswer,
  samples: [
    { verdict: 'accept', input: { side: 'buy', baseAsset: 'USDC', quoteAsset: 'USDC', qty: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TRADE_RFQ_BOARD = defineProcedure({
  ...base,
  name: 'trade.rfq.board',
  kind: 'query',
  path: 'rfq.board',
  access: { caller: 'scope', scope: 'trade:read' },
  refusals: {},
  input: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().optional(),
  }),
  output: rfqBoardAnswer,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
