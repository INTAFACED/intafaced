/**
 * What svc-pay answers the customer's money rooms (module `pay`): a withdrawal's record, history and cancel, its limits,
 * quote, network rules and destination (`withdrawal.*`), team approval requests (`withdrawalApproval.*`) and the withdrawal
 * allowlist (`allowlist.*`). Browser-safe (zod only). A record is a projection, not a balance book, a delivery receipt or
 * settlement evidence; a check against the caller's own user or request stays in the app.
 */
import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';

const id = z.string().guid();
const stamp = z.string().datetime({ offset: true });
/**
 * An exact decimal of up to 18 places, never negative, kept as a string, whose whole part fits the ledger's column (below
 * 10^20): `unsignedAmountSchema`'s rule as one regex, so the record's JSON export carries it.
 */
const amount = z.string().regex(/^0*\d{1,20}(\.\d{1,18})?$/);
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

/** Why a withdrawal came back (`withdrawals/returns/schemas.ts`). */
export const PAY_WITHDRAWAL_RETURN_REASONS = ['destination_rejected', 'network_returned', 'other'] as const;

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
  // svc-pay always sends the four below; each is optional so a reply from an older svc-pay without it still reads.
  /** The row in the customer vocabulary: a held row reads `held` while nothing was sent, `dispatching`, then `broadcast`. */
  customerStatus: z.enum(PAY_WITHDRAWAL_SHOWN).optional(),
  /** Whether `withdrawal.cancel` would cancel it now. False whenever the answer is not proven. */
  cancellable: z.boolean().optional(),
  /** The network a send out of the platform went on; null on a send inside the platform or an older row. */
  networkId: z.string().nullable().optional(),
  /** The quoted network fee its hold carries on top of `amount`; null when it carries none. */
  fee: amount.nullable().optional(),
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
  returnedFunds: z
    .object({ amount, reasonCode: z.enum(PAY_WITHDRAWAL_RETURN_REASONS).nullable(), credited: z.boolean() })
    .nullable()
    .optional(),
  createdAt: stamp,
});

/** `withdrawal.history`: one page, newest first, and the cursor to the next. */
export const payWithdrawalHistoryPageSchema = z.object({
  items: z.array(payWithdrawalHistoryItemSchema),
  next: z.string().min(1).max(200).nullable(),
});

/** `withdrawal.quote`: the fee parts, net amount, total debit and expiry for one withdrawal. */
export const payWithdrawQuoteSchema = z.object({
  quoteRef: z.string(),
  assetId: assetIdSchema,
  networkId: z.string(),
  amount,
  feeMode: z.enum(['on_top', 'deducted']),
  /** The fee parts that apply today; a part with no source is absent, never shown as zero. */
  fees: z.array(z.object({ kind: z.enum(['network']), amount })),
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
export const payWithdrawNetworkRulesSchema = z
  .object({
    assetId: assetIdSchema,
    networkId: z.string(),
    minimum: amount,
    maximum: amount,
    step: amount,
    tag: z.enum(['none', 'required']),
  })
  .strict();

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
    assetId: assetIdSchema,
    address: z.string(),
    label: z.string(),
  }),
  z.strictObject({ enabled: z.boolean(), assetId: assetIdSchema, maxAmount: z.string() }),
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
