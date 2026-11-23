import { defineProcedure } from './procedure.js';
import { storeListInputSchema, storeListSchema } from './merchant-stores.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantStores.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_STORES_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantStores.list',
  kind: 'query',
  path: 'merchantStores.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: storeListInputSchema,
  output: storeListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
