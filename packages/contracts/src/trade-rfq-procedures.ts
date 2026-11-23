import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { decimal, firmRfqAnswer } from './trade-call-schemas.js';

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
