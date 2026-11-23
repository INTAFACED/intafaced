import { defineProcedure } from './procedure.js';
import { opsCostEntryInputSchema, opsCostEntrySchema } from './ops-venue-economics.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `recordVenueCost.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_RECORD_VENUE_COST = defineProcedure({
  ...base,
  name: 'ops.recordVenueCost',
  kind: 'mutation',
  path: 'recordVenueCost',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {
    'action_approval.identity_unwired': 'PRECONDITION_FAILED',
    'ops.cost_amount_invalid': 'PRECONDITION_FAILED',
    'ops.cost_category_invalid': 'PRECONDITION_FAILED',
    'ops.cost_period_invalid': 'PRECONDITION_FAILED',
    'ops.cost_storage_unconfigured': 'PRECONDITION_FAILED',
    'ops.idempotency_conflict': 'CONFLICT',
  },
  input: opsCostEntryInputSchema,
  output: opsCostEntrySchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        period: 'USDC',
        category: 'USDC',
        amount: 'USDC',
        asset: 'USDC',
        sourceNote: 'USDC',
        idempotencyKey: 'USDC',
        approvalId: 'USDC',
        operationId: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
