import { z } from 'zod';
import { actionApprovalSchema } from './action-approval.js';
import { defineProcedure } from './procedure.js';

/**
 * svc-identity's four-eyes approvals, as a caller reads them back. Written once here; svc-identity mounts it and the
 * console calls it through this record.
 */

export const ACTION_APPROVAL_LIST_LIMIT_MAX = 100;

export const actionApprovalListInputSchema = z.object({
  view: z.enum(['pending', 'mine']),
  limit: z.number().int().min(1).max(ACTION_APPROVAL_LIST_LIMIT_MAX),
});

export const actionApprovalListSchema = z.object({ approvals: z.array(actionApprovalSchema), pageFull: z.boolean() });
export type ActionApprovalList = z.infer<typeof actionApprovalListSchema>;

/**
 * `pending`: the approvals this caller may decide (an operator or founder read). `mine`: the caller's own requests, newest
 * first. The limit is required: leaving it out is not a page.
 */
export const IDENTITY_ACTION_APPROVAL_LIST = defineProcedure({
  name: 'identity.actionApproval.list',
  service: 'svc-identity',
  module: 'identity',
  transport: 'trpc',
  kind: 'query',
  path: 'actionApproval.list',
  access: { caller: 'signedIn' },
  refusals: {
    'action_approval.operator_only': 'FORBIDDEN',
    'action_approval.founders_unavailable': 'SERVICE_UNAVAILABLE',
  },
  input: actionApprovalListInputSchema,
  output: actionApprovalListSchema,
  samples: [
    { verdict: 'accept', input: { view: 'mine', limit: 20 } },
    { verdict: 'refuse', input: { view: 'mine', limit: 0 } },
    { verdict: 'refuse', input: { view: 'everyone', limit: 20 } },
  ],
});
