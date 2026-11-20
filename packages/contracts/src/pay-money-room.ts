/**
 * What svc-pay answers the customer's money rooms (module `pay`): a withdrawal's record, history and cancel, its limits,
 * quote, network rules and destination (`withdrawal.*`), team approval requests (`withdrawalApproval.*`) and the withdrawal
 * allowlist (`allowlist.*`). Browser-safe (zod only). A record is a projection, not a balance book, a delivery receipt or
 * settlement evidence; a check against the caller's own user or request stays in the app.
 */
import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { unsignedAmountSchema } from './wire-amount.js';

const id = z.string().guid();
const stamp = z.string().datetime({ offset: true });
/** An exact decimal of up to 18 places, never negative, kept as a string. */
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/)
  .pipe(unsignedAmountSchema);
const destination = z.object({ kind: z.string(), ref: z.string() });

// ── Withdrawals ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** svc-pay's customer vocabulary for a withdrawal (`withdrawals/status.ts`). */
export const PAY_WITHDRAWAL_SHOWN = [
  'requested',
  'pending_review',
  'approved',
  'held',
  'dispatching',
  'broadcast',
  'confirming',
  'settled',
  'rejected',
  'canceled',
  'failed',
  'needs_review',
] as const;

/** The published withdrawalView (`withdrawal.get`, `withdrawal.create`). */
export const payWithdrawalSchema = z.object({
  id,
  userId: id,
  assetId: assetIdSchema.min(1).max(16),
  amount,
  rail: z.string(),
  destination,
  clientRef: z.string(),
  railRef: z.string().nullable(),
  attempts: z.number().int(),
  failureCode: z.string().nullable(),
  status: z.enum(['pending', 'held', 'sent', 'failed']),
  createdAt: stamp,
  // The row in the customer vocabulary (a held row split by its dispatch journal), and whether a cancel would run now.
  // Optional so an older svc-pay without them still reads.
  customerStatus: z.enum(PAY_WITHDRAWAL_SHOWN).optional(),
  cancellable: z.boolean().optional(),
});

/** `withdrawal.cancel`: the cancelled row, and whether a hold went back (`null`: unknown on a repeat). */
export const payCanceledWithdrawalSchema = payWithdrawalSchema.extend({
  customerStatus: z.literal('canceled'),
  holdReleased: z.boolean().nullable(),
});

/** One row of `withdrawal.history`: the person's own withdrawal in the customer vocabulary. */
export const payWithdrawalHistoryItemSchema = z.object({
  id,
  userId: id,
  assetId: assetIdSchema.min(1).max(16),
  amount,
  rail: z.string(),
  destination,
  clientRef: z.string(),
  railRef: z.string().nullable(),
  attempts: z.number().int(),
  status: z.enum(PAY_WITHDRAWAL_SHOWN),
  failure: z.object({ code: z.string(), known: z.boolean(), message: z.string() }).nullable(),
  returned: z.boolean(),
  /** What came back, when anything did, and whether it is back in available yet. An older svc-pay sends none. */
  returnedFunds: z.object({ amount, reasonCode: z.string().nullable(), credited: z.boolean() }).nullable().optional(),
  createdAt: stamp,
});

/** `withdrawal.history`: one page, newest first, and the cursor to the next. */
export const payWithdrawalHistoryPageSchema = z.object({
  items: z.array(payWithdrawalHistoryItemSchema),
  next: z.string().min(1).max(200).nullable(),
});

/** `withdrawal.limits`: the owner-set figures for the caller's tier, what 24 hours used, and the most one send may be now. */
export const payWithdrawLimitsSchema = z.object({
  tier: z.string(),
  assetId: assetIdSchema,
  perTx: amount,
  rolling24h: amount,
  used24h: amount,
  remaining: z.object({ perTx: amount, rolling24h: amount }),
  maxNow: amount,
});

/** `withdrawal.quote`: the fee parts, net amount, total debit and expiry for one withdrawal. */
export const payWithdrawQuoteSchema = z.object({
  quoteRef: z.string(),
  assetId: assetIdSchema,
  networkId: z.string(),
  amount,
  feeMode: z.enum(['on_top', 'deducted']),
  fees: z.array(z.object({ kind: z.string(), amount })),
  feeTotal: amount,
  netAmount: amount,
  totalDebit: amount,
  feeSource: z.string(),
  quotedAt: stamp,
  expiresAt: stamp,
  expired: z.boolean(),
  acceptedBy: z.string().nullable(),
});

/** `withdrawal.networkRules`: the owner's minimum, maximum and step for one asset on one network, and its tag rule. */
export const payWithdrawNetworkRulesSchema = z.object({
  assetId: assetIdSchema,
  networkId: z.string(),
  minimum: amount,
  maximum: amount,
  step: amount,
  tag: z.enum(['none', 'required']),
});

/** `withdrawal.destination`: where an address leads. It never names the other account. */
export const payWithdrawDestinationSchema = z.union([
  z.object({ kind: z.enum(['internal', 'self', 'external']) }),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['expired', 'unavailable']) }),
]);

// ── Team approval of a withdrawal (`withdrawalApproval.*`) ─────────────────────────────────────────────────────────────

export const PAY_APPROVAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'expired', 'canceled', 'failed'] as const;

/** The published requestView: the ask and its tally, not proof that money was sent. */
export const payApprovalRequestSchema = z.object({
  id,
  userId: id,
  assetId: assetIdSchema.min(1).max(32),
  amount,
  rail: z.string(),
  destination,
  clientRef: z.string(),
  teamAccountId: id,
  requiredApprovals: z.number().int().min(1),
  approvalCount: z.number().int().min(0),
  approvedByMe: z.boolean(),
  holdAtSubmit: z.boolean(),
  status: z.enum(PAY_APPROVAL_STATUSES),
  failureCode: z.string().nullable(),
  expiresAt: stamp,
  createdAt: stamp,
  decidedAt: stamp.nullable(),
});

// ── The withdrawal allowlist (`allowlist.*`) ────────────────────────────────────────────────────────────────────────────
// The list says where money MAY go; it is not a balance and moves nothing.

export const payAllowlistEntrySchema = z.object({
  id,
  userId: id,
  group: z.enum(['internal_wallet', 'external_wallet', 'contract']),
  assetId: assetIdSchema.min(1).max(32),
  address: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(['active', 'suspended', 'removed']),
  createdBy: z.string(),
  suspendedReason: z.string().nullable(),
  createdAt: stamp,
  lastUsedAt: stamp.nullable(),
});

/**
 * What a change would do, in the wording of its op: an entry's group, asset, address and label (`add`, `delete`), the
 * one-time policy (`onetime_policy`), or nothing (`mode_off`). Strict, so one shape is never read as another.
 */
const payAllowlistSubjectSchema = z.union([
  z.strictObject({
    group: z.enum(['internal_wallet', 'external_wallet', 'contract']),
    assetId: z.string(),
    address: z.string(),
    label: z.string(),
  }),
  z.strictObject({ enabled: z.boolean(), assetId: z.string(), maxAmount: z.string() }),
  z.strictObject({}),
]);

export const PAY_ALLOWLIST_CHANGE_STATUSES = ['waiting', 'approved', 'cancelled', 'rejected', 'failed'] as const;
export const payAllowlistChangeSchema = z.object({
  id,
  userId: id,
  op: z.enum(['add', 'delete', 'mode_off', 'onetime_policy']),
  entryId: id.nullable(),
  subject: payAllowlistSubjectSchema,
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  teamAccountId: id,
  requiredApprovals: z.number().int().min(1),
  approvalCount: z.number().int().min(0),
  approvedByMe: z.boolean(),
  status: z.enum(PAY_ALLOWLIST_CHANGE_STATUSES),
  failureCode: z.string().nullable(),
  createdAt: stamp,
  decidedAt: stamp.nullable(),
});

/** `allowlist.mode`. */
export const payAllowlistModeSchema = z.object({ userId: id, enabled: z.boolean(), setAt: stamp.nullable() });

/** `allowlist.policy`: the one-time send policy. */
export const payAllowlistPolicySchema = z.object({
  userId: id,
  enabled: z.boolean(),
  assetId: assetIdSchema.nullable(),
  maxAmount: z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/)
    .nullable(),
  setAt: stamp.nullable(),
});

/** `allowlist.setMode`: the mode now, and the change for the team when switching off. */
export const payAllowlistSetModeResultSchema = z.object({
  mode: payAllowlistModeSchema,
  change: payAllowlistChangeSchema.nullable(),
});
