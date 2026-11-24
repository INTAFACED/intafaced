import { defineProcedure } from './procedure.js';
import { storeIdInputSchema, storeSchema } from './merchant-stores.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantStores.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_STORES_ARCHIVE = defineProcedure({
  ...base,
  name: 'pay.merchantStores.archive',
  kind: 'mutation',
  path: 'merchantStores.archive',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: storeIdInputSchema,
  output: storeSchema,
  samples: [
    { verdict: 'accept', input: { storeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_STORES_REOPEN = defineProcedure({
  ...base,
  name: 'pay.merchantStores.reopen',
  kind: 'mutation',
  path: 'merchantStores.reopen',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: storeIdInputSchema,
  output: storeSchema,
  samples: [
    { verdict: 'accept', input: { storeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
