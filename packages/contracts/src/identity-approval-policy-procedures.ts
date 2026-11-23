import { defineProcedure, NO_INPUT } from './procedure.js';
import { approvalPolicyRowsReadSchema, approvalPolicySetInputSchema, approvalPolicySetResultSchema } from './action-approval-policy.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `approvalPolicy.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** Every governed type's row as identity reads it now, with its source and the version to bind a change to. */
export const IDENTITY_APPROVAL_POLICY_ROWS = defineProcedure({
  ...base,
  name: 'identity.approvalPolicy.rows',
  kind: 'query',
  path: 'approvalPolicy.rows',
  access: { caller: 'founder' },
  refusals: {},
  input: NO_INPUT,
  output: approvalPolicyRowsReadSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_APPROVAL_POLICY_SET = defineProcedure({
  ...base,
  name: 'identity.approvalPolicy.set',
  kind: 'mutation',
  path: 'approvalPolicy.set',
  access: { caller: 'founder' },
  refusals: {},
  input: approvalPolicySetInputSchema,
  output: approvalPolicySetResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        actionType: 'identity.staff.invite',
        requiredApprovals: 'USDC',
        approverAudience: 'USDC',
        applier: 'USDC',
        maxAgeSeconds: 'USDC',
        expectedVersion: '1',
        approvalId: 'USDC',
        operationId: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
