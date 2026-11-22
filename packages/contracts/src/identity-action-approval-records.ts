import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  actionApprovalApproveInputSchema,
  actionApprovalIdInputSchema,
  actionApprovalProposeInputSchema,
  actionApprovalSchema,
} from './action-approval.js';
import { actionApprovalPoliciesReadSchema } from './action-approval-policy.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `actionApproval.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_ACTION_APPROVAL_REJECT = defineProcedure({
  ...base,
  name: 'identity.actionApproval.reject',
  kind: 'mutation',
  path: 'actionApproval.reject',
  access: { caller: 'signedIn' },
  refusals: {},
  input: actionApprovalIdInputSchema,
  output: actionApprovalSchema,
  samples: [
    { verdict: 'accept', input: { approvalId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACTION_APPROVAL_PROPOSE = defineProcedure({
  ...base,
  name: 'identity.actionApproval.propose',
  kind: 'mutation',
  path: 'actionApproval.propose',
  access: { caller: 'signedIn' },
  refusals: {},
  input: actionApprovalProposeInputSchema,
  output: actionApprovalSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        actionType: 'USDC',
        targetService: 'USDC',
        targetId: 'USDC',
        expectedVersion: 'USDC',
        payloadHash: 'USDC',
        policyVersion: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACTION_APPROVAL_APPROVE = defineProcedure({
  ...base,
  name: 'identity.actionApproval.approve',
  kind: 'mutation',
  path: 'actionApproval.approve',
  access: { caller: 'signedIn' },
  refusals: {},
  input: actionApprovalApproveInputSchema,
  output: actionApprovalSchema,
  samples: [
    { verdict: 'accept', input: { approvalId: 'USDC', expectedPayloadHash: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Every policy-governed action type with its owner policy row, or `unset` with `action_approval.policy_unset`
 * (OPS-change-control-01 CR-1). A founder or operator read for the console; it changes nothing.
 */
export const IDENTITY_ACTION_APPROVAL_POLICIES = defineProcedure({
  ...base,
  name: 'identity.actionApproval.policies',
  kind: 'query',
  path: 'actionApproval.policies',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: actionApprovalPoliciesReadSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_ACTION_APPROVAL_REVOKE = defineProcedure({
  ...base,
  name: 'identity.actionApproval.revoke',
  kind: 'mutation',
  path: 'actionApproval.revoke',
  access: { caller: 'signedIn' },
  refusals: {},
  input: actionApprovalIdInputSchema,
  output: actionApprovalSchema,
  samples: [
    { verdict: 'accept', input: { approvalId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
