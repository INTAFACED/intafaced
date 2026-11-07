import { z } from 'zod';

/**
 * PER-ACTION-TYPE APPROVAL POLICY (OPS-change-control-01 CR-1).
 *
 * A governed action type is approved under an owner policy row: how many distinct people other than the requester
 * must approve, who may approve, which service may apply it, and the longest a request may live. Every other four-eyes
 * type keeps the fixed rule (one requester and one distinct approver, the shared lifetime).
 *
 * The rows are owner values and ship blank. For a governed type a missing, blank, zero, non-integer or unreadable row is
 * `action_approval.policy_unset`: identity refuses propose, approve and consume, and never falls back to a weaker rule.
 * A required count below one approver other than the requester is refused the same way, so no row is weaker than the
 * fixed two-person rule.
 *
 * This package carries the wire contract only.
 */

export const ACTION_APPROVAL_POLICY_UNSET = 'action_approval.policy_unset' as const;
/** A governed request whose policy row changed after it was proposed. It is never judged by the new row. */
export const ACTION_APPROVAL_POLICY_CHANGED = 'action_approval.policy_changed' as const;
/** The approver is not in the policy's audience. */
export const ACTION_APPROVAL_AUDIENCE_MISMATCH = 'action_approval.audience_mismatch' as const;
/** The same person approving one governed request twice. */
export const ACTION_APPROVAL_ALREADY_APPROVED = 'action_approval.already_approved' as const;

/**
 * Action types governed by an owner policy row. Operator ledger corrections (OPS-ledger-desk-02) are the first; the
 * privileged staff changes (`IDENTITY_STAFF_ACTION_TYPES` in `identity-staff.ts`, OPS-admin-access-03) follow, so an
 * invite or a role change is refused `action_approval.policy_unset` until the founders set its row.
 * Matching is exact after trimming and lower-casing, so a different spelling is the same governed type.
 */
export const POLICY_GOVERNED_ACTION_TYPES = [
  'ops.ledger.reverse',
  'ops.ledger.adjust',
  'identity.staff.invite',
  'identity.staff.disable',
  'identity.staff.remove',
  'identity.roles.define',
  'identity.roles.assign',
  'identity.roles.unassign',
] as const;
export type PolicyGovernedActionType = (typeof POLICY_GOVERNED_ACTION_TYPES)[number];

/** The governed type a request names, or null when it is not governed. */
export function governedActionTypeOf(actionType: string): PolicyGovernedActionType | null {
  const norm = actionType.trim().toLowerCase();
  return (POLICY_GOVERNED_ACTION_TYPES as readonly string[]).includes(norm) ? (norm as PolicyGovernedActionType) : null;
}

export function isPolicyGovernedActionType(actionType: string): boolean {
  return governedActionTypeOf(actionType) !== null;
}

/** Who may approve a governed type. The same audiences identity already decides by. */
export const approvalPolicyAudienceSchema = z.enum(['founder', 'operator', 'trade_ops']);
export type ApprovalPolicyAudience = z.infer<typeof approvalPolicyAudienceSchema>;

export const actionApprovalPolicySchema = z.object({
  /** Distinct approvers other than the requester. At least one. */
  requiredApprovals: z.number().int().min(1),
  approverAudience: approvalPolicyAudienceSchema,
  /** The only service that may consume (apply) an approval of this type. */
  applier: z.string().min(1).max(64),
  /** Longest a request may live, in seconds. It caps the shared approval lifetime. */
  maxAgeSeconds: z.number().int().min(1),
  /** Hash of the row's values. A request is bound to the version it was proposed under. */
  version: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type ActionApprovalPolicy = z.infer<typeof actionApprovalPolicySchema>;

/**
 * Where a row comes from: the deployment's owner setting, or a change two founders made in the console (which then
 * stands in for the deployment's row of that type). `rowVersion` counts the console changes of that type ('0' before
 * the first); a console change is bound to the version its founders read.
 */
const rowOrigin = {
  source: z.enum(['deployment', 'console']).optional(),
  rowVersion: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,9})$/)
    .optional(),
};

export const actionApprovalPolicyEntrySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('set'),
    actionType: z.enum(POLICY_GOVERNED_ACTION_TYPES),
    policy: actionApprovalPolicySchema,
    ...rowOrigin,
  }),
  z.object({
    state: z.literal('unset'),
    actionType: z.enum(POLICY_GOVERNED_ACTION_TYPES),
    code: z.literal(ACTION_APPROVAL_POLICY_UNSET),
    ...rowOrigin,
  }),
]);
export type ActionApprovalPolicyEntry = z.infer<typeof actionApprovalPolicyEntrySchema>;

/** `actionApproval.policies`: every governed type, in `POLICY_GOVERNED_ACTION_TYPES` order, set or unset. */
export const actionApprovalPoliciesReadSchema = z.object({
  policies: z.array(actionApprovalPolicyEntrySchema),
});
export type ActionApprovalPoliciesRead = z.infer<typeof actionApprovalPoliciesReadSchema>;

// ── Setting a row in the console (OPS-change-control-01, J-ops-console-09 #1) ─────────────────────────────────

/**
 * Two founders set one governed type's row in the console: one asks, a different founder approves the exact row, and
 * identity spends that approval once when the row is written. It is a founder-only fixed-rule type (it is not itself
 * governed, so no row can lower the bar for changing rows).
 *
 * The four values travel as the founder typed them. A blank or unreadable count, audience, applier or age is a row
 * identity reads as unset: written, the type refuses `action_approval.policy_unset` at propose, approve and apply,
 * so nothing of that type applies until a whole row is set again.
 */
export const APPROVAL_POLICY_SET_ACTION_TYPE = 'identity.approval_policy.set' as const;

export const approvalPolicySetFieldsSchema = z
  .object({
    actionType: z.enum(POLICY_GOVERNED_ACTION_TYPES),
    requiredApprovals: z.string().trim().max(12),
    approverAudience: z.string().trim().max(32),
    applier: z.string().trim().max(64),
    maxAgeSeconds: z.string().trim().max(12),
    /** The `rowVersion` the founders read. A row changed since is refused `action_approval.target_mismatch`. */
    expectedVersion: z.string().regex(/^(?:0|[1-9]\d{0,9})$/),
  })
  .strict();
export type ApprovalPolicySetFields = z.infer<typeof approvalPolicySetFieldsSchema>;

export const approvalPolicySetInputSchema = approvalPolicySetFieldsSchema
  .extend({ approvalId: z.string().min(1).max(128), operationId: z.string().min(1).max(128) })
  .strict();
export type ApprovalPolicySetInput = z.infer<typeof approvalPolicySetInputSchema>;

/**
 * The fields, in this order, that identity hashes a row change under
 * (`identityActionPayloadHash('identity.approval_policy.set', fields)`): the type, the four values as typed, and the
 * version read, so an approval is for one exact change of one exact row.
 */
export function approvalPolicySetPayloadFields(v: ApprovalPolicySetFields): Record<string, string> {
  return {
    actionType: v.actionType,
    requiredApprovals: v.requiredApprovals.trim(),
    approverAudience: v.approverAudience.trim(),
    applier: v.applier.trim(),
    maxAgeSeconds: v.maxAgeSeconds.trim(),
    expectedVersion: v.expectedVersion,
  };
}

export const approvalPolicySetResultSchema = z.object({ entry: actionApprovalPolicyEntrySchema }).strict();
export type ApprovalPolicySetResult = z.infer<typeof approvalPolicySetResultSchema>;
