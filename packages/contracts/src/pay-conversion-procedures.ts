import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  conversionExecuteInputSchema,
  conversionGetInputSchema,
  conversionListInputSchema,
  conversionOrderSchema,
  conversionQuoteInputSchema,
  conversionQuoteSchema,
} from './conversion.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `conversion.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_CONVERSION_LIST = defineProcedure({
  ...base,
  name: 'pay.conversion.list',
  kind: 'query',
  path: 'conversion.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: conversionListInputSchema,
  output: z.array(conversionOrderSchema),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_CONVERSION_GET = defineProcedure({
  ...base,
  name: 'pay.conversion.get',
  kind: 'query',
  path: 'conversion.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: conversionGetInputSchema,
  output: conversionOrderSchema,
  samples: [
    { verdict: 'accept', input: { conversionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_CONVERSION_QUOTE = defineProcedure({
  ...base,
  name: 'pay.conversion.quote',
  kind: 'mutation',
  path: 'conversion.quote',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: conversionQuoteInputSchema,
  output: conversionQuoteSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        merchantId: '11111111-1111-4111-8111-111111111111',
        settlementId: '11111111-1111-4111-8111-111111111111',
        fromAsset: 'USDC',
        toAsset: 'USDC',
        fromAmount: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_CONVERSION_EXECUTE = defineProcedure({
  ...base,
  name: 'pay.conversion.execute',
  kind: 'mutation',
  path: 'conversion.execute',
  access: { caller: 'scope', scope: 'pay:payout', module: 'pay' },
  refusals: {},
  input: conversionExecuteInputSchema,
  output: conversionOrderSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111', quoteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
