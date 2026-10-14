import { z } from 'zod';

/**
 * ACTION-BOUND APPROVAL (Astra stage A / PX-S02).
 *
 * A free-text second name (`confirmOperatorId` / `confirmActorId`) is
 * attribution at most. It never establishes that a second person approved.
 * Identity issues a durable approval; the target service consumes it.
 *
 * This package carries the wire contract only — no persistence, no amounts.
 */

export const ACTION_APPROVAL_NOT_AUTHORITY = 'action_approval.names_are_not_authority' as const;

export const actionApprovalStatusSchema = z.enum(['PENDING', 'APPROVED', 'CONSUMED', 'REJECTED', 'EXPIRED', 'REVOKED']);
export type ActionApprovalStatus = z.infer<typeof actionApprovalStatusSchema>;

/**
 * `four_eyes` is the original maker/checker row: a second authenticated person
 * approves. `same_person` is the money-out step-up row: the requester proves a
 * fresh second factor for THEIR OWN intent and only they can consume it, once.
 * The two never share a path; see `SAME_PERSON_ACTION_TYPES`.
 */
export const actionApprovalKindSchema = z.enum(['four_eyes', 'same_person']);
export type ActionApprovalKind = z.infer<typeof actionApprovalKindSchema>;

/**
 * Action types that are same-person step-up approvals for svc-bank money-out
 * doors (ADR 2026-10-14-money-out-step-up). Identity refuses to issue these
 * through the four-eyes `propose` and refuses any other type on the
 * same-person door, so one type is never both.
 */
export const SAME_PERSON_ACTION_TYPES = [
  'bank.step_up.transfers.toUser',
  'bank.step_up.transfers.create',
  'bank.step_up.transfers.scheduleToUser',
  'bank.step_up.transfers.schedule',
  'bank.step_up.business.runPayroll',
  'bank.step_up.business.proposeTransfer',
  'bank.step_up.business.approve',
  'bank.step_up.business.addMember',
  'bank.step_up.cards.unfreeze',
  'bank.step_up.cards.issue',
] as const;
export type SamePersonActionType = (typeof SAME_PERSON_ACTION_TYPES)[number];

export function isSamePersonActionType(actionType: string): actionType is SamePersonActionType {
  return (SAME_PERSON_ACTION_TYPES as readonly string[]).includes(actionType);
}

/** Lifetime of a same-person step-up approval. Fixed, not env: five minutes, like `auth.stepUp`. */
export const SAME_PERSON_APPROVAL_TTL_SECONDS = 300;

export const actionApprovalSchema = z.object({
  approvalId: z.string().min(1).max(128),
  actionType: z.string().min(1).max(128),
  targetService: z.string().min(1).max(64),
  targetId: z.string().min(1).max(256),
  expectedVersion: z.string().min(1).max(128),
  payloadHash: z.string().min(1).max(128),
  requesterId: z.string().min(1).max(128),
  /** Null until a distinct authenticated person approves. Never a typed-in name. */
  approverId: z.string().min(1).max(128).nullable(),
  policyVersion: z.string().min(1).max(128),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  status: actionApprovalStatusSchema,
  operationId: z.string().min(1).max(128),
  /** Absent means `four_eyes`. Present only for `same_person` rows, so four-eyes output is unchanged. */
  kind: actionApprovalKindSchema.optional(),
});
export type ActionApproval = z.infer<typeof actionApprovalSchema>;

/** Propose: requester only. Approver is filled on a later authenticated approve. */
export const actionApprovalProposeInputSchema = z.object({
  actionType: z.string().min(1).max(128),
  targetService: z.string().min(1).max(64),
  targetId: z.string().min(1).max(256),
  expectedVersion: z.string().min(1).max(128),
  payloadHash: z.string().min(1).max(128),
  policyVersion: z.string().min(1).max(128),
});
export type ActionApprovalProposeInput = z.infer<typeof actionApprovalProposeInputSchema>;

export const actionApprovalApproveInputSchema = z
  .object({
    approvalId: z.string().min(1).max(128),
  })
  .strict();
export type ActionApprovalApproveInput = z.infer<typeof actionApprovalApproveInputSchema>;

export const actionApprovalConsumeInputSchema = z.object({
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
  payloadHash: z.string().min(1).max(128),
  targetService: z.string().min(1).max(64),
  targetId: z.string().min(1).max(256),
  expectedVersion: z.string().min(1).max(128),
  /**
   * Same-person consume only. Both are the CONSUMING caller's authenticated
   * principal (user id and session id), forwarded by the target service.
   * Identity refuses a same-person row unless both match the row, and refuses a
   * four-eyes row when they are present, so neither kind can pass as the other.
   */
  principalUserId: z.string().min(1).max(128).optional(),
  principalSessionId: z.string().min(1).max(128).optional(),
});
export type ActionApprovalConsumeInput = z.infer<typeof actionApprovalConsumeInputSchema>;

/**
 * Two distinct strings in one request are not two authenticated people.
 * Services must not treat this shape as stage-A approval.
 */
export function namesAreNotActionApproval(input: {
  readonly actorId?: string | null;
  readonly confirmOperatorId?: string | null;
  readonly confirmActorId?: string | null;
}): true {
  void input;
  return true;
}

export function isConsumableApproval(row: ActionApproval): boolean {
  if (row.status !== 'APPROVED' || row.approverId === null) return false;
  // A same-person step-up row is its own approval by construction (the fresh
  // factor was proven by the requester). Every other row needs a second person.
  if (row.kind === 'same_person') return row.approverId === row.requesterId;
  return row.approverId !== row.requesterId;
}

export function approvalCannotExecute(row: ActionApproval): boolean {
  return !isConsumableApproval(row);
}
