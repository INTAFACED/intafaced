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
  'bank.step_up.business.removeMember',
  'bank.step_up.business.setMemberRole',
  'bank.step_up.cards.unfreeze',
  'bank.step_up.cards.issue',
  'bank.step_up.cards.setLimits',
  'bank.step_up.cards.reveal',
  'bank.step_up.cards.pinReveal',
  'bank.step_up.cards.pinSet',
  // Withdrawals. Identity mints and consumes these. svc-bank ramps still gate on the
  // trade:withdraw bearer until a bank change reads the approval (one service per PR).
  'bank.step_up.ramps.offramp',
  'bank.step_up.ramps.setWithdrawDestination',
  // Merchant payout destination. Identity mints it; svc-pay consumes it.
  // A bank door cannot spend this approval (target service follows the prefix).
  'pay.step_up.payoutDestination.set',
  'bank.step_up.bills.pay',
  'bank.step_up.bills.recurring',
  'bank.step_up.global.send',
  // Customer contact changes. Identity mints and consumes these itself.
  // They are not bank doors and not a sign-in factor.
  'identity.step_up.email_change',
  'identity.step_up.phone_change',
  'identity.step_up.phone_remove',
  // Close the caller's own account. Identity mints and consumes it.
  // Closing does not erase ledger, trade, or p2p history.
  'identity.step_up.close_account',
  // Security changes on the caller's own sign-in methods and limits (identity ENGINE STP-3). Identity
  // mints and consumes these itself. Closing an account is `close_account` above.
  'identity.step_up.passkey_add',
  'identity.step_up.passkey_remove',
  'identity.step_up.passkey_rename',
  // Bind one passkey to the actions it answers for, and ask for a passkey after the password (I-signin-sessions-10).
  'identity.step_up.passkey_purposes',
  'identity.step_up.passkey_second_step',
  'identity.step_up.totp_replace',
  'identity.step_up.totp_disable',
  'identity.step_up.recovery_codes_regenerate',
  'identity.step_up.password_change_with_second_factor',
  'identity.step_up.fund_password_set',
  'identity.step_up.limits_loosen',
  'identity.step_up.self_freeze_lift',
  'identity.step_up.trusted_device_remove',
  // Approve a waiting new-device sign-in of the caller's own account from a trusted session (I-signin-sessions-07).
  'identity.step_up.trusted_device_approve',
  'identity.step_up.link_method',
  'identity.step_up.unlink_method',
  // Add or revoke one of the caller's own recovery keys, or name their heir and threshold (RC-identity-07). Identity mints and consumes it.
  'identity.step_up.recovery_key_change',
  // Delete one of the caller's own sub-accounts (revoke only; it moves no money). Identity mints and consumes it.
  'identity.step_up.sub_account_delete',
  // Edit the label and purpose of one of the caller's own sub-accounts (RC-identity-14). Identity mints and consumes it.
  'identity.step_up.sub_account_edit',
  // Set or clear the caller's own anti-phishing code (I-signin-sessions-25). Identity mints and consumes it.
  'identity.step_up.anti_phishing_set',
  // Ask to lift the caller's own security lock (W-withdraw-09). Identity mints and consumes it; the lock still holds for the owner-set wait.
  'identity.step_up.security_lock_unlock',
  // Place a P2P order from an ad (P-trade-orders-07). Identity mints it; svc-p2p consumes it before the take reserves.
  'p2p.step_up.trades.take',
  // Release a P2P order's escrow to the buyer (P-trade-orders-07, -16). Identity mints it; svc-p2p consumes it before the release.
  'p2p.step_up.trades.confirmReceived',
  // Add, change or remove a P2P payment method (P-ads-merchant-18). Identity mints it; svc-p2p consumes it before the change.
  'p2p.step_up.instruments.change',
  // Take realised profit out of the caller's own spot grid bot (CB-bots-05). Identity mints it; svc-trade consumes it
  // before it reads the bot. It lowers the bot's reserve and posts no ledger row.
  'trade.step_up.bots.grid.withdrawProfit',
  // Close every position a copy follow holds and end the follow (CB-copy close-all, J-copy-bots-otc-03 #4). Identity
  // mints it; svc-trade consumes it before it reads the follow. It sells at market, so it can realise a loss.
  'trade.step_up.copy.flatten',
  // A founder changes one account's governance role (MC-token-02, J-more-catalogue-10 #6). Identity mints it for the
  // founder who runs the two-founder change; svc-token consumes it before the role is written. It moves no value.
  'token.step_up.governance.setRole',
] as const;

/**
 * Same-person rows are consumed only by the service named on the row.
 * Bank doors stay `svc-bank`. Pay destination step-up is `svc-pay`. A P2P order is `svc-p2p`.
 * A grid bot profit withdrawal and a copy close-all are `svc-trade`. A governance role change is `svc-token`.
 * Identity contact changes are `svc-identity`, because identity consumes them
 * itself and refuses a consume whose caller is not the target service.
 */
export function samePersonTargetService(
  actionType: string,
): 'svc-bank' | 'svc-pay' | 'svc-identity' | 'svc-p2p' | 'svc-trade' | 'svc-token' {
  if (actionType.startsWith('pay.step_up.')) return 'svc-pay';
  if (actionType.startsWith('token.step_up.')) return 'svc-token';
  if (actionType.startsWith('trade.step_up.')) return 'svc-trade';
  if (actionType.startsWith('p2p.step_up.')) return 'svc-p2p';
  if (actionType.startsWith('identity.step_up.')) return 'svc-identity';
  return 'svc-bank';
}
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
  /**
   * Founder-audience consume result only. Identity re-checks, at the moment of consume and against the live founder
   * entitlement, that the approver and the proposer are both current founders. A target service reads these and
   * refuses when they are absent or not both true. Operator-audience protective verbs do not carry them.
   */
  approverIsFounder: z.boolean().optional(),
  requesterIsFounder: z.boolean().optional(),
  /**
   * Set when the row has been consumed. `get` returns these to the requester, the approver, and an
   * operator holding `admin:read`. Other readers of the same row do not receive them.
   */
  consumedAt: z.string().datetime({ offset: true }).optional(),
  consumedByRequestId: z.string().min(1).max(128).optional(),
  /**
   * Set only when `consume` is retried with the same request id that already consumed the row.
   * A different request id is `action_approval.consumed`, not this value.
   */
  consumption: z.literal('already_consumed_by_this_request').optional(),
  /**
   * Policy-governed types only (OPS-change-control-01 CR-1, `POLICY_GOVERNED_ACTION_TYPES`): the distinct approvers
   * other than the requester the request needs, and how many it has. Absent on every other row.
   */
  approvalsRequired: z.number().int().min(1).optional(),
  approvalsGiven: z.number().int().min(0).optional(),
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

/** Reject and revoke name the approval only. Approve is a different shape: it also binds the payload (below). */
export const actionApprovalIdInputSchema = z
  .object({
    approvalId: z.string().min(1).max(128),
  })
  .strict();
export type ActionApprovalIdInput = z.infer<typeof actionApprovalIdInputSchema>;

/**
 * Approve binds the approver to the exact payload they reviewed. `expectedPayloadHash` is the hash the approver
 * computed or was shown for the change under review; identity refuses (`action_approval.payload_mismatch`) unless it
 * equals the stored request's hash. An id alone is never enough to approve.
 */
export const actionApprovalApproveInputSchema = z
  .object({
    approvalId: z.string().min(1).max(128),
    expectedPayloadHash: z.string().min(1).max(128),
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
  /**
   * Client idempotency key for this consume. The same key after a lost reply returns the
   * original consumed row with `consumption: already_consumed_by_this_request`. A different
   * key is `action_approval.consumed`. Omitted: one-shot consume, and a retry cannot be
   * told apart from another caller (the previous behaviour).
   */
  requestId: z.string().min(1).max(128).optional(),
  /**
   * The person who consumed a four-eyes row, when the caller is a session (edge kill).
   * This is not the same-person principal pair: a four-eyes row still refuses `principalUserId`.
   */
  consumerPrincipalId: z.string().min(1).max(128).optional(),
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

/**
 * Operator-audience protective verbs. A brake must not wait for both founders.
 * The exception holds only when the type, the target service, and the target verb all agree.
 * svc-identity decides audience from this same list. Every other consume needs identity's founder attestation.
 */
export const PROTECTIVE_OPERATOR_APPROVALS: readonly {
  readonly actionType: string;
  readonly targetService: string;
  readonly targetVerb: string;
}[] = [
  { actionType: 'matching.halt', targetService: 'svc-matching', targetVerb: 'halt' },
  { actionType: 'matching.halt_all', targetService: 'svc-matching', targetVerb: 'halt_all' },
  { actionType: 'matching.reduce_only', targetService: 'svc-matching', targetVerb: 'reduce_only' },
  { actionType: 'matching.post_only', targetService: 'svc-matching', targetVerb: 'post_only' },
  { actionType: 'ledger.freeze', targetService: 'svc-ledger', targetVerb: 'posting_freeze' },
  { actionType: 'execution.halt', targetService: 'svc-execution', targetVerb: 'halt' },
];

export type FounderApprovalSubject = {
  readonly actionType: string;
  readonly targetService: string;
  readonly targetId: string;
};

const normApproval = (value: string): string => value.trim().toLowerCase();

/** `halt:market-1` → `halt`; `posting_freeze` → `posting_freeze`. */
const verbOfTarget = (targetId: string): string => {
  const normalized = normApproval(targetId);
  const colon = normalized.indexOf(':');
  return colon === -1 ? normalized : normalized.slice(0, colon);
};

/** True only when type, service, and target verb all name one protective brake. */
export function isProtectiveOperatorApproval(subject: FounderApprovalSubject): boolean {
  const type = normApproval(subject.actionType);
  const service = normApproval(subject.targetService);
  const verb = verbOfTarget(subject.targetId);
  return PROTECTIVE_OPERATOR_APPROVALS.some((row) => row.actionType === type && row.targetService === service && row.targetVerb === verb);
}

export type FounderAttestationVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: 'missing' | 'forged' };

function sameBinding(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

/** Identity stores the action type. A row that only repeats the target id names a different action. */
function namesThisAction(row: ActionApproval, subject: FounderApprovalSubject): boolean {
  return normApproval(row.actionType) === normApproval(subject.actionType);
}

function distinctParties(row: ActionApproval): boolean {
  const approver = row.approverId?.trim() ?? '';
  const requester = row.requesterId.trim();
  return approver.length > 0 && approver.toLowerCase() !== requester.toLowerCase();
}

/**
 * What a consuming service does with identity's founder attestation.
 * A protective verb is accepted without it. Every other subject needs a consumed row for this target,
 * naming this action, whose proposer and approver are distinct and both attested founders.
 * Absent flags are `missing`. A false flag, the same person twice, or a row for a different action is `forged`.
 */
export function founderAttestationVerdict(row: ActionApproval, subject: FounderApprovalSubject): FounderAttestationVerdict {
  if (isProtectiveOperatorApproval(subject)) return { ok: true };
  if (
    row.status !== 'CONSUMED' ||
    !sameBinding(row.targetService, subject.targetService) ||
    !sameBinding(row.targetId, subject.targetId) ||
    !namesThisAction(row, subject) ||
    !distinctParties(row)
  ) {
    return { ok: false, reason: 'forged' };
  }
  if (row.approverIsFounder === undefined && row.requesterIsFounder === undefined) {
    return { ok: false, reason: 'missing' };
  }
  if (row.approverIsFounder !== true || row.requesterIsFounder !== true) {
    return { ok: false, reason: 'forged' };
  }
  return { ok: true };
}
