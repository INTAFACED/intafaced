import { defineProcedure } from './procedure.js';
import { payHaltStatusInputSchema, payHaltStatusSchema } from './pay-halts.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `payHalts.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_PAY_HALTS_STATUS = defineProcedure({
  ...base,
  name: 'pay.payHalts.status',
  kind: 'query',
  path: 'payHalts.status',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: payHaltStatusInputSchema,
  output: payHaltStatusSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
