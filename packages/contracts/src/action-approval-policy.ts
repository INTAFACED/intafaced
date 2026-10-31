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
 * Action types governed by an owner policy row. Operator ledger corrections (OPS-ledger-desk-02) are the first.
 * Matching is exact after trimming and lower-casing, so a different spelling is the same governed type.
 */
export const POLICY_GOVERNED_ACTION_TYPES = ['ops.ledger.reverse', 'ops.ledger.adjust'] as const;
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

export const actionApprovalPolicyEntrySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('set'), actionType: z.enum(POLICY_GOVERNED_ACTION_TYPES), policy: actionApprovalPolicySchema }),
  z.object({
    state: z.literal('unset'),
    actionType: z.enum(POLICY_GOVERNED_ACTION_TYPES),
    code: z.literal(ACTION_APPROVAL_POLICY_UNSET),
  }),
]);
export type ActionApprovalPolicyEntry = z.infer<typeof actionApprovalPolicyEntrySchema>;

/** `actionApproval.policies`: every governed type, in `POLICY_GOVERNED_ACTION_TYPES` order, set or unset. */
export const actionApprovalPoliciesReadSchema = z.object({
  policies: z.array(actionApprovalPolicyEntrySchema),
});
export type ActionApprovalPoliciesRead = z.infer<typeof actionApprovalPoliciesReadSchema>;
