import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { accountControlHistoryInputSchema, accountControlInputSchema, accountControlResultSchema } from './account-controls.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantState.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_STATE_HISTORY = defineProcedure({
  ...base,
  name: 'pay.merchantState.history',
  kind: 'query',
  path: 'merchantState.history',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountControlHistoryInputSchema,
  output: z.array(accountControlResultSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_STATE_SET = defineProcedure({
  ...base,
  name: 'pay.merchantState.set',
  kind: 'mutation',
  path: 'merchantState.set',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountControlInputSchema,
  output: accountControlResultSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
