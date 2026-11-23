import { defineProcedure } from './procedure.js';
import { depositFreezeResultSchema, depositUnfreezeResultSchema } from './pay-deposit-freezes.js';
import { depositFreezeInputSchema, depositUnfreezeInputSchema } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `founderAdmin.depositFreezes.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_FOUNDER_ADMIN_DEPOSIT_FREEZES_FREEZE = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.depositFreezes.freeze',
  kind: 'mutation',
  path: 'founderAdmin.depositFreezes.freeze',
  access: { caller: 'founder' },
  refusals: {},
  input: depositFreezeInputSchema,
  output: depositFreezeResultSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_DEPOSIT_FREEZES_UNFREEZE = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.depositFreezes.unfreeze',
  kind: 'mutation',
  path: 'founderAdmin.depositFreezes.unfreeze',
  access: { caller: 'founder' },
  refusals: {},
  input: depositUnfreezeInputSchema,
  output: depositUnfreezeResultSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
