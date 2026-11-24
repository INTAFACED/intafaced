import { defineProcedure } from './procedure.js';
import { staffHoldListInputSchema, staffHoldListSchema } from './ops-staff-holds.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `staffHolds.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_STAFF_HOLDS_LIST = defineProcedure({
  ...base,
  name: 'ops.staffHolds.list',
  kind: 'query',
  path: 'staffHolds.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.hold_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: staffHoldListInputSchema,
  output: staffHoldListSchema,
  outputChecks: { amount_holds: { at: ['output.holds[].amount', 'output.holds[].movements[].amount'], says: 'an amount above zero' } },
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
