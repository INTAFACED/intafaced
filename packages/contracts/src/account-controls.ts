import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import type { Context } from './trpc.js';
import { accountStateSchema, apiKeyOwnershipSchema, sessionOwnershipSchema, subAccountOwnershipSchema } from './identity.js';

/** Wire records only. Parsing a command, snapshot or receipt never grants authority. */
const id = z.string().guid();
const timestamp = z.string().datetime({ offset: true });
const businessId = z.string().trim().min(1).max(128);
const reason = z.string().trim().min(3).max(500);
const version = z
  .string()
  .max(40)
  .regex(/^(?:0|[1-9]\d*)$/);
const payloadHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const accountControlTargetSchema = z.discriminatedUnion('area', [
  z.object({ area: z.literal('identity'), userId: id }).strict(),
  z.object({ area: z.literal('trading'), userId: id }).strict(),
  z.object({ area: z.literal('merchant'), merchantId: id }).strict(),
]);
export type AccountControlTarget = z.infer<typeof accountControlTargetSchema>;

/** Actor and founder entitlement are resolved from authentication, never this body. */
export const accountControlInputSchema = z
  .object({
    requestId: id,
    target: accountControlTargetSchema,
    action: z.enum(['restrict', 'restore']),
    reason,
    expectedVersion: version,
  })
  .strict();
export type AccountControlInput = z.infer<typeof accountControlInputSchema>;

/**
 * svc-identity only. `approvalId` names a stored `trading.restrict` approval, or an `identity.account_unfreeze` one for an identity restore.
 * It is a reference, not authority: identity checks the row is approved, unexpired,
 * unconsumed, and bound to this account and payload before consuming it.
 * The shared schema refuses this field so another service cannot apply the
 * restriction and leave the approval unused.
 * `reasonCode` (trading restrict only): a code from the owner's trading restriction reason list
 * (`IDENTITY_TRADING_RESTRICTION_REASONS`). Identity stores it and the customer's account status shows its words; a code
 * not on the list, or one on a restore, refuses `restriction.reason_unlisted`; another code on a restriction already in
 * force refuses `restriction.reason_in_force` (restore, then restrict); another area refuses it with `operator.denied`.
 * Each refuses before an approval is spent. It is bound into the approval's payload hash when present.
 */
export const identityAccountControlInputSchema = accountControlInputSchema
  .extend({
    approvalId: z.string().trim().min(1).max(128).optional(),
    reasonCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,63}$/)
      .optional(),
  })
  .strict();
export type IdentityAccountControlInput = z.infer<typeof identityAccountControlInputSchema>;

export const accountControlStateSchema = z.object({ target: accountControlTargetSchema, version, restricted: z.boolean() }).strict();
export type AccountControlState = z.infer<typeof accountControlStateSchema>;

export const accountControlLookupInputSchema = z.object({ target: accountControlTargetSchema }).strict();
export const accountControlHistoryInputSchema = accountControlLookupInputSchema
  .extend({ limit: z.number().int().min(1).max(200) })
  .strict();

function sameTarget(a: AccountControlTarget, b: AccountControlTarget): boolean {
  if (a.area === 'merchant' && b.area === 'merchant') return a.merchantId === b.merchantId;
  return a.area !== 'merchant' && b.area !== 'merchant' && a.area === b.area && a.userId === b.userId;
}

const auditFields = {
  auditId: id,
  requestId: id,
  target: accountControlTargetSchema,
  action: z.enum(['restrict', 'restore']),
  reason,
  occurredAt: timestamp,
};
/** `approverUserId`: the second person whose approval was spent for this change (an identity unfreeze, a trading restriction). */
const completedFields = {
  ...auditFields,
  actorUserId: id,
  approverUserId: id.optional(),
  before: accountControlStateSchema,
  after: accountControlStateSchema,
};

/** Failed/no-op attempts are audited too; they never claim a successful state change. */
export const accountControlResultSchema = z
  .discriminatedUnion('outcome', [
    z.object({ ...completedFields, outcome: z.literal('changed'), changed: z.literal(true) }).strict(),
    z.object({ ...completedFields, outcome: z.literal('noop'), changed: z.literal(false) }).strict(),
    z
      .object({
        ...auditFields,
        outcome: z.literal('refused'),
        changed: z.literal(false),
        actorUserId: id.nullable(),
        code: z.enum([
          'operator.denied',
          'mfa.required',
          'authority.unavailable',
          'target.not_found',
          'restore.not_permitted',
          'request.conflict',
          'restriction_no_four_eyes',
          'restriction_approval_mismatch',
          'restriction_approval_consumed',
          'identity.account_archived',
          'restriction.reason_unlisted',
          'restriction.reason_in_force',
        ]),
        current: accountControlStateSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...auditFields,
        outcome: z.literal('conflict'),
        changed: z.literal(false),
        actorUserId: id,
        code: z.literal('restriction.version_conflict'),
        current: accountControlStateSchema,
      })
      .strict(),
  ])
  .superRefine((result, ctx) => {
    if (result.outcome === 'refused' && (result.code === 'operator.denied' || result.code === 'mfa.required') && result.current !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current'], message: 'Unauthorized attempts cannot disclose target state' });
    }
    const states = 'before' in result ? [result.before, result.after] : result.current === null ? [] : [result.current];
    if (states.some((state) => !sameTarget(state.target, result.target))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: 'State belongs to a different target' });
    }
    if (!('before' in result)) return;
    // Zod runs refinements on dirty strings too. Refuse malformed/oversized
    // versions before BigInt conversion so safeParse remains non-throwing.
    if (!version.safeParse(result.before.version).success || !version.safeParse(result.after.version).success) return;
    const requested = result.action === 'restrict';
    const coherent =
      result.after.restricted === requested &&
      (result.outcome === 'changed'
        ? result.before.restricted !== result.after.restricted && BigInt(result.after.version) === BigInt(result.before.version) + 1n
        : result.before.restricted === result.after.restricted && result.before.version === result.after.version);
    if (!coherent) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['after'], message: 'Outcome, action and state versions disagree' });
  });
export type AccountControlResult = z.infer<typeof accountControlResultSchema>;

/**
 * Staff close and reopen of one account (J-ops-console-04 #7), svc-identity only. Both are four-eyes: the actor runs it
 * with an approval a second person gave (`identity.account_close` or `identity.account_reopen`), bound to the account,
 * the reason and `expectedVersion` (the same identity control version a freeze moves). A close needs a reason code from
 * this list. Only a customer-closed account can be reopened: one the customer closed through the closure flow, or that
 * staff closed with `customer_request`. A close for any other reason (fraud, negative balance, bank reason, other) stays
 * closed. No money moves here; the balance at close is the closure sweep's, and a close refuses while the closure checks
 * report open products or balances.
 */
export const accountCloseReasonCodes = ['fraud', 'negative_balance', 'bank_reason', 'customer_request', 'other'] as const;
export const accountCloseReasonCodeSchema = z.enum(accountCloseReasonCodes);
export type AccountCloseReasonCode = z.infer<typeof accountCloseReasonCodeSchema>;

const closureReason = z.string().trim().min(3).max(255);

export const accountClosureInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      requestId: id,
      userId: id,
      action: z.literal('close'),
      reasonCode: accountCloseReasonCodeSchema,
      reason: closureReason,
      expectedVersion: version,
      approvalId: z.string().trim().min(1).max(128).optional(),
    })
    .strict(),
  z
    .object({
      requestId: id,
      userId: id,
      action: z.literal('reopen'),
      reason: closureReason,
      expectedVersion: version,
      approvalId: z.string().trim().min(1).max(128).optional(),
    })
    .strict(),
]);
export type AccountClosureInput = z.infer<typeof accountClosureInputSchema>;

/** `closedBy`: who closed it, `customer` (the closure flow, or staff with `customer_request`) or `staff`; null while open. */
export const accountClosureStateSchema = z
  .object({
    userId: id,
    version,
    status: z.enum(['active', 'frozen', 'closed']),
    closedBy: z.enum(['customer', 'staff']).nullable(),
    closeReasonCode: accountCloseReasonCodeSchema.nullable(),
    reopenable: z.boolean(),
  })
  .strict();
export type AccountClosureState = z.infer<typeof accountClosureStateSchema>;

export const accountClosureLookupInputSchema = z.object({ userId: id }).strict();
export const accountClosureHistoryInputSchema = z.object({ userId: id, limit: z.number().int().min(1).max(200) }).strict();

const closureAuditFields = {
  auditId: id,
  requestId: id,
  userId: id,
  action: z.enum(['close', 'reopen']),
  reasonCode: accountCloseReasonCodeSchema.nullable(),
  reason: closureReason,
  occurredAt: timestamp,
};
const closureBlockerSchema = z.object({ code: z.string().min(1).max(128), count: z.number().int().min(0) }).strict();

export const accountClosureResultSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        ...closureAuditFields,
        outcome: z.literal('changed'),
        changed: z.literal(true),
        actorUserId: id,
        approverUserId: id,
        before: accountClosureStateSchema,
        after: accountClosureStateSchema,
      })
      .strict(),
    z
      .object({
        ...closureAuditFields,
        outcome: z.literal('refused'),
        changed: z.literal(false),
        actorUserId: id.nullable(),
        code: z.enum([
          'operator.denied',
          'mfa.required',
          'target.not_found',
          'request.conflict',
          'identity.close_founder_forbidden',
          'identity.close_self_forbidden',
          'identity.close_already_closed',
          'identity.reopen_not_closed',
          'identity.reopen_not_allowed',
          'identity.close_requires_approver',
          'identity.close_approval_mismatch',
          'identity.close_approval_consumed',
          'identity.close_blocked',
          'identity.close_check_unavailable',
          'identity.account_archived',
        ]),
        current: accountClosureStateSchema.nullable(),
        blockers: z.array(closureBlockerSchema).max(50).optional(),
      })
      .strict(),
    z
      .object({
        ...closureAuditFields,
        outcome: z.literal('conflict'),
        changed: z.literal(false),
        actorUserId: id,
        code: z.literal('restriction.version_conflict'),
        current: accountClosureStateSchema,
      })
      .strict(),
  ])
  .superRefine((result, ctx) => {
    if (result.outcome === 'refused' && (result.code === 'operator.denied' || result.code === 'mfa.required') && result.current !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current'], message: 'Unauthorized attempts cannot disclose target state' });
    }
    const states = 'before' in result ? [result.before, result.after] : result.current === null ? [] : [result.current];
    if (states.some((state) => state.userId !== result.userId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['userId'], message: 'State belongs to a different account' });
    }
    if (result.outcome === 'changed') {
      const closed = result.action === 'close';
      const coherent =
        (result.after.status === 'closed') === closed &&
        (result.before.status === 'closed') !== closed &&
        version.safeParse(result.before.version).success &&
        version.safeParse(result.after.version).success &&
        BigInt(result.after.version) === BigInt(result.before.version) + 1n &&
        result.approverUserId !== result.actorUserId;
      if (!coherent) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['after'], message: 'Outcome, action and state versions disagree' });
    }
    if ((result.action === 'close') !== (result.reasonCode !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'A close carries a reason code and a reopen does not' });
    }
  });
export type AccountClosureResult = z.infer<typeof accountClosureResultSchema>;

/**
 * Archive of one customer record (J-ops-console-04 #10), svc-identity only. Irreversible and four-eyes: the actor runs it
 * with an `identity.account_archive` approval the other founder gave, bound to the account, the reason code, the reason and
 * `expectedVersion`. Only a closed account can be archived (`identity.archive_blocked_open_account` while it is open).
 * Archived, the record is read-only: freeze, unfreeze and reopen refuse `identity.account_archived`. The reason codes are a starting list for the owner and counsel to settle.
 */
export const accountArchiveReasonCodes = ['dormant', 'customer_request', 'duplicate', 'other'] as const;
export const accountArchiveReasonCodeSchema = z.enum(accountArchiveReasonCodes);
export type AccountArchiveReasonCode = z.infer<typeof accountArchiveReasonCodeSchema>;

export const accountArchiveInputSchema = z
  .object({
    requestId: id,
    userId: id,
    reasonCode: accountArchiveReasonCodeSchema,
    reason: closureReason,
    expectedVersion: version,
    approvalId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type AccountArchiveInput = z.infer<typeof accountArchiveInputSchema>;

export const accountArchiveStateSchema = z
  .object({
    userId: id,
    version,
    status: z.enum(['active', 'frozen', 'closed']),
    archivedAt: timestamp.nullable(),
    archiveReasonCode: accountArchiveReasonCodeSchema.nullable(),
  })
  .strict()
  .refine((state) => (state.archivedAt === null) === (state.archiveReasonCode === null), 'An archive carries its reason code')
  .refine((state) => state.archivedAt === null || state.status === 'closed', 'Only a closed account is archived');
export type AccountArchiveState = z.infer<typeof accountArchiveStateSchema>;

export const accountArchiveLookupInputSchema = z.object({ userId: id }).strict();
export const accountArchiveHistoryInputSchema = z.object({ userId: id, limit: z.number().int().min(1).max(200) }).strict();

const archiveAuditFields = {
  auditId: id,
  requestId: id,
  userId: id,
  reasonCode: accountArchiveReasonCodeSchema,
  reason: closureReason,
  occurredAt: timestamp,
};

export const accountArchiveResultSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        ...archiveAuditFields,
        outcome: z.literal('changed'),
        changed: z.literal(true),
        actorUserId: id,
        approverUserId: id,
        before: accountArchiveStateSchema,
        after: accountArchiveStateSchema,
      })
      .strict(),
    z
      .object({
        ...archiveAuditFields,
        outcome: z.literal('refused'),
        changed: z.literal(false),
        actorUserId: id.nullable(),
        code: z.enum([
          'operator.denied',
          'mfa.required',
          'target.not_found',
          'request.conflict',
          'identity.archive_founder_forbidden',
          'identity.archive_self_forbidden',
          'identity.archive_blocked_open_account',
          'identity.account_archived',
          'identity.archive_requires_approver',
          'identity.archive_approval_mismatch',
          'identity.archive_approval_consumed',
        ]),
        current: accountArchiveStateSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...archiveAuditFields,
        outcome: z.literal('conflict'),
        changed: z.literal(false),
        actorUserId: id,
        code: z.literal('restriction.version_conflict'),
        current: accountArchiveStateSchema,
      })
      .strict(),
  ])
  .superRefine((result, ctx) => {
    if (result.outcome === 'refused' && (result.code === 'operator.denied' || result.code === 'mfa.required') && result.current !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current'], message: 'Unauthorized attempts cannot disclose target state' });
    }
    const states = 'before' in result ? [result.before, result.after] : result.current === null ? [] : [result.current];
    if (states.some((state) => state.userId !== result.userId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['userId'], message: 'State belongs to a different account' });
    }
    if (result.outcome === 'changed') {
      const coherent =
        result.before.archivedAt === null &&
        result.after.archivedAt !== null &&
        result.after.archiveReasonCode === result.reasonCode &&
        version.safeParse(result.before.version).success &&
        version.safeParse(result.after.version).success &&
        BigInt(result.after.version) === BigInt(result.before.version) + 1n &&
        result.approverUserId !== result.actorUserId;
      if (!coherent) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['after'], message: 'Outcome and archive state disagree' });
    }
  });
export type AccountArchiveResult = z.infer<typeof accountArchiveResultSchema>;

/**
 * Customers identity proposes for archive (J-ops-console-04 #10): closed, not archived, and with no change and no new
 * session for the owner's dormancy period. Only a proposal: a person archives each one with a second approver. The period
 * ships blank: `dormancyDays` null means no proposal is made and the console says the period is not set.
 */
export const accountArchiveProposalsSchema = z
  .object({
    dormancyDays: z.number().int().min(1).max(36500).nullable(),
    proposals: z.array(z.object({ userId: id, lastActivityAt: timestamp }).strict()).max(200),
    asOf: timestamp,
  })
  .strict()
  .refine((list) => list.dormancyDays !== null || list.proposals.length === 0, 'No proposal without a dormancy period');
export type AccountArchiveProposals = z.infer<typeof accountArchiveProposalsSchema>;

/**
 * Account product tiers (J-ops-console-04 #11). Identity keeps which tier an account is on; the tiers and their terms are
 * an owner setting that ships blank. A term left blank (null) means the tier cannot be assigned
 * (`identity.tier_terms_unset`). Terms are decimal strings, never numbers.
 */
const tierId = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const termDecimal = z
  .string()
  .max(40)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
export const accountTierTermsSchema = z
  .object({
    /** Yearly rate in percent, as a decimal string. */
    ratePercent: termDecimal.nullable(),
    monthlyFee: termDecimal.nullable(),
    /** The asset the fee and the daily limit are in. */
    feeAssetId: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[A-Z0-9]+$/)
      .nullable(),
    dailyLimit: termDecimal.nullable(),
    clearingDays: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,2})$/)
      .nullable(),
  })
  .strict();
export type AccountTierTerms = z.infer<typeof accountTierTermsSchema>;
export const ACCOUNT_TIER_TERM_KEYS = ['ratePercent', 'monthlyFee', 'feeAssetId', 'dailyLimit', 'clearingDays'] as const;

export const accountTierSchema = z.object({ id: tierId, name: z.string().trim().min(1).max(64), terms: accountTierTermsSchema }).strict();
export type AccountTier = z.infer<typeof accountTierSchema>;

/** The tiers on offer. Unset (blank, or not a valid list) is its own answer, never an empty list. */
export const accountTierListSchema = z.discriminatedUnion('configured', [
  z
    .object({
      configured: z.literal(true),
      tiers: z.array(accountTierSchema).min(1).max(50),
    })
    .strict(),
  z.object({ configured: z.literal(false), code: z.literal('identity.account_tiers_unset') }).strict(),
]);
export type AccountTierList = z.infer<typeof accountTierListSchema>;

/** `tierId` null: the account was never put on a tier. */
export const accountTierStateSchema = z.object({ userId: id, version, tierId: tierId.nullable() }).strict();
export type AccountTierState = z.infer<typeof accountTierStateSchema>;

const tierReason = z.string().trim().min(3).max(255);
export const accountTierMoveInputSchema = z
  .object({
    requestId: id,
    userId: id,
    tierId,
    reason: tierReason,
    expectedVersion: version,
    approvalId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type AccountTierMoveInput = z.infer<typeof accountTierMoveInputSchema>;
export const accountTierLookupInputSchema = z.object({ userId: id }).strict();
export const accountTierHistoryInputSchema = z.object({ userId: id, limit: z.number().int().min(1).max(200) }).strict();

const tierAuditFields = { auditId: id, requestId: id, userId: id, tierId, reason: tierReason, occurredAt: timestamp };

export const accountTierResultSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        ...tierAuditFields,
        outcome: z.literal('changed'),
        changed: z.literal(true),
        actorUserId: id,
        approverUserId: id,
        before: accountTierStateSchema,
        after: accountTierStateSchema,
      })
      .strict(),
    z
      .object({
        ...tierAuditFields,
        outcome: z.literal('refused'),
        changed: z.literal(false),
        actorUserId: id.nullable(),
        code: z.enum([
          'operator.denied',
          'mfa.required',
          'target.not_found',
          'request.conflict',
          'identity.account_tiers_unset',
          'identity.tier_unknown',
          'identity.tier_terms_unset',
          'identity.tier_unchanged',
          'identity.tier_self_forbidden',
          'identity.tier_account_closed',
          'identity.tier_requires_approver',
          'identity.tier_approval_mismatch',
          'identity.tier_approval_consumed',
        ]),
        current: accountTierStateSchema.nullable(),
        /** With `identity.tier_terms_unset`: which terms of the tier are blank. */
        blankTerms: z.array(z.enum(ACCOUNT_TIER_TERM_KEYS)).min(1).max(5).optional(),
      })
      .strict(),
    z
      .object({
        ...tierAuditFields,
        outcome: z.literal('conflict'),
        changed: z.literal(false),
        actorUserId: id,
        code: z.literal('restriction.version_conflict'),
        current: accountTierStateSchema,
      })
      .strict(),
  ])
  .superRefine((result, ctx) => {
    if (result.outcome === 'refused' && (result.code === 'operator.denied' || result.code === 'mfa.required') && result.current !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current'], message: 'Unauthorized attempts cannot disclose target state' });
    }
    const states = 'before' in result ? [result.before, result.after] : result.current === null ? [] : [result.current];
    if (states.some((state) => state.userId !== result.userId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['userId'], message: 'State belongs to a different account' });
    }
    if (result.outcome === 'refused' && (result.code === 'identity.tier_terms_unset') !== (result.blankTerms !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blankTerms'], message: 'Blank terms come with tier_terms_unset only' });
    }
    if (result.outcome === 'changed') {
      const coherent =
        result.after.tierId === result.tierId &&
        result.before.tierId !== result.tierId &&
        BigInt(result.after.version) === BigInt(result.before.version) + 1n &&
        result.approverUserId !== result.actorUserId;
      if (!coherent) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['after'], message: 'Outcome, tier and state versions disagree' });
    }
  });
export type AccountTierResult = z.infer<typeof accountTierResultSchema>;

/**
 * Account limit overrides (J-ops-console-04 #12, OPS-accounts-desk-03). The base limits stay with the service that
 * enforces them (svc-pay's withdrawal limits by KYC tier, D-148). Identity keeps a temporary per-customer override of one
 * rail's figures for one asset, which ends at a stored time; after it the base limit is back. A null figure keeps the base
 * figure. Figures are decimal strings in the asset's own units, never numbers, and never zero (a freeze stops an account).
 *
 * The owner policy (`IDENTITY_LIMIT_OVERRIDE_POLICY`) ships blank: the longest an override may last and, per rail and
 * asset, the ceiling above which an override needs the other founder. Blank, invalid, or no ceiling for the asset refuses
 * `identity.limit_ceiling_unset`; nothing is assumed.
 */
export const ACCOUNT_LIMIT_RAILS = ['withdrawal'] as const;
export const accountLimitRailSchema = z.enum(ACCOUNT_LIMIT_RAILS);
export type AccountLimitRail = z.infer<typeof accountLimitRailSchema>;
export const accountLimitAssetIdSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Z0-9]+$/);
/** A positive decimal string: no sign, no exponent, at most 20 whole digits and 18 decimals (the ledger's column), never zero. */
export const accountLimitAmountSchema = z
  .string()
  .max(40)
  .regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/)
  .refine((value) => !/^0(?:\.0+)?$/.test(value), 'A limit figure is above zero');
const limitReason = z.string().trim().min(12).max(255);

export const accountLimitOverrideSchema = z
  .object({
    userId: id,
    rail: accountLimitRailSchema,
    assetId: accountLimitAssetIdSchema,
    /** Of this rail and asset for this customer; each set or clear adds one. */
    version,
    perTx: accountLimitAmountSchema.nullable(),
    rolling24h: accountLimitAmountSchema.nullable(),
    expiresAt: timestamp,
    /** `expired` once the stored expiry has passed; `cleared` when a founder ended it early. */
    status: z.enum(['active', 'expired', 'cleared']),
    setBy: id,
    /** The other founder, when the override is above the ceiling. */
    approvedBy: id.nullable(),
    setAt: timestamp,
    reason: limitReason,
    clearedBy: id.nullable(),
    clearedAt: timestamp.nullable(),
  })
  .strict();
export type AccountLimitOverride = z.infer<typeof accountLimitOverrideSchema>;

export const accountLimitCeilingSchema = z
  .object({ rail: accountLimitRailSchema, assetId: accountLimitAssetIdSchema, ceiling: accountLimitAmountSchema })
  .strict();
export type AccountLimitCeiling = z.infer<typeof accountLimitCeilingSchema>;
export const accountLimitPolicySchema = z.discriminatedUnion('configured', [
  z
    .object({
      configured: z.literal(true),
      /** Whole hours, 1 to 8784 (a leap year). */
      maxLifetimeHours: z.string().regex(/^[1-9]\d{0,3}$/),
      ceilings: z.array(accountLimitCeilingSchema).min(1).max(100),
    })
    .strict(),
  z.object({ configured: z.literal(false), code: z.literal('identity.limit_ceiling_unset') }).strict(),
]);
export type AccountLimitPolicy = z.infer<typeof accountLimitPolicySchema>;

/** The customer's overrides as they stand, one per rail and asset ever set, with the owner policy. */
export const accountLimitsStateSchema = z
  .object({
    userId: id,
    overrides: z.array(accountLimitOverrideSchema).max(100),
    policy: accountLimitPolicySchema,
    closed: z.boolean(),
    archived: z.boolean(),
  })
  .strict()
  .refine((state) => state.overrides.every((row) => row.userId === state.userId), 'An override belongs to another account');
export type AccountLimitsState = z.infer<typeof accountLimitsStateSchema>;

export const accountLimitOverrideSetInputSchema = z
  .object({
    requestId: id,
    userId: id,
    rail: accountLimitRailSchema,
    assetId: accountLimitAssetIdSchema,
    perTx: accountLimitAmountSchema.nullable(),
    rolling24h: accountLimitAmountSchema.nullable(),
    expiresAt: timestamp,
    reason: limitReason,
    expectedVersion: version,
    /** A stored `identity.change_limit` approval from the other founder; needed only above the ceiling. */
    approvalId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .refine((input) => input.perTx !== null || input.rolling24h !== null, 'An override sets at least one figure');
export type AccountLimitOverrideSetInput = z.infer<typeof accountLimitOverrideSetInputSchema>;
export const accountLimitOverrideClearInputSchema = z
  .object({
    requestId: id,
    userId: id,
    rail: accountLimitRailSchema,
    assetId: accountLimitAssetIdSchema,
    reason: limitReason,
    expectedVersion: version,
  })
  .strict();
export type AccountLimitOverrideClearInput = z.infer<typeof accountLimitOverrideClearInputSchema>;
export const accountLimitsLookupInputSchema = z.object({ userId: id }).strict();
export const accountLimitsHistoryInputSchema = z.object({ userId: id, limit: z.number().int().min(1).max(200) }).strict();

const limitAuditFields = {
  auditId: id,
  requestId: id,
  userId: id,
  action: z.enum(['set', 'clear']),
  rail: accountLimitRailSchema,
  assetId: accountLimitAssetIdSchema,
  reason: limitReason,
  occurredAt: timestamp,
};

export const accountLimitResultSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        ...limitAuditFields,
        outcome: z.literal('changed'),
        changed: z.literal(true),
        actorUserId: id,
        approverUserId: id.nullable(),
        before: accountLimitOverrideSchema.nullable(),
        after: accountLimitOverrideSchema,
      })
      .strict(),
    z
      .object({
        ...limitAuditFields,
        outcome: z.literal('refused'),
        changed: z.literal(false),
        actorUserId: id.nullable(),
        code: z.enum([
          'operator.denied',
          'mfa.required',
          'target.not_found',
          'request.conflict',
          'identity.limit_ceiling_unset',
          'identity.limit_expiry_past',
          'identity.limit_lifetime_exceeded',
          'identity.limit_unchanged',
          'identity.limit_self_forbidden',
          'identity.limit_account_closed',
          'identity.account_archived',
          'identity.limit_requires_approver',
          'identity.limit_approval_mismatch',
          'identity.limit_approval_consumed',
          'identity.limit_override_not_found',
          'identity.limit_override_expired',
        ]),
        current: accountLimitOverrideSchema.nullable(),
        /** With `identity.limit_requires_approver`: the owner ceiling the override goes above. */
        ceiling: accountLimitAmountSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...limitAuditFields,
        outcome: z.literal('conflict'),
        changed: z.literal(false),
        actorUserId: id,
        code: z.literal('restriction.version_conflict'),
        current: accountLimitOverrideSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine((result, ctx) => {
    if (result.outcome === 'refused' && (result.code === 'operator.denied' || result.code === 'mfa.required') && result.current !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current'], message: 'Unauthorized attempts cannot disclose target state' });
    }
    const states = 'after' in result ? [result.before, result.after] : [result.current];
    if (
      states.some((row) => row !== null && (row.userId !== result.userId || row.rail !== result.rail || row.assetId !== result.assetId))
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['userId'], message: 'Override belongs to another account, rail or asset' });
    }
    if (result.outcome === 'refused' && (result.code === 'identity.limit_requires_approver') !== (result.ceiling !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ceiling'], message: 'The ceiling comes with limit_requires_approver only' });
    }
    if (result.outcome === 'changed') {
      const coherent =
        BigInt(result.after.version) === BigInt(result.before?.version ?? '0') + 1n &&
        (result.action === 'set' ? result.after.status === 'active' : result.after.status === 'cleared') &&
        result.approverUserId !== result.actorUserId;
      if (!coherent) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['after'], message: 'Outcome, action and versions disagree' });
    }
  });
export type AccountLimitResult = z.infer<typeof accountLimitResultSchema>;

/**
 * svc-identity's `GET /internal/limit-override/:userId?rail=&assetId=`: the override in force now for one rail and asset,
 * read by the service that enforces the limit. `override` null: none in force (never set, expired or cleared), so the
 * base limit applies.
 */
export const accountLimitOverrideReadSchema = z
  .object({
    userId: id,
    rail: accountLimitRailSchema,
    assetId: accountLimitAssetIdSchema,
    override: z
      .object({
        version,
        perTx: accountLimitAmountSchema.nullable(),
        rolling24h: accountLimitAmountSchema.nullable(),
        expiresAt: timestamp,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AccountLimitOverrideRead = z.infer<typeof accountLimitOverrideReadSchema>;

export const accountCredentialReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: id }).strict(),
  z.object({ kind: z.literal('api_key'), apiKeyId: id }).strict(),
]);
export const currentAuthorityInputSchema = z
  .object({ userId: id, credential: accountCredentialReferenceSchema, subAccountId: id.optional() })
  .strict();
export type CurrentAuthorityInput = z.infer<typeof currentAuthorityInputSchema>;

/** Identity's revocable founder entitlement; it does not assert session MFA or grant a scope. */
export const accountOperatorEntitlementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('enabled'), userId: id, version, changedAt: timestamp }).strict(),
  z.object({ status: z.literal('revoked'), userId: id, version, changedAt: timestamp }).strict(),
  z.object({ status: z.literal('unconfigured'), userId: id }).strict(),
  z.object({ status: z.literal('not_operator'), userId: id }).strict(),
]);
export type AccountOperatorEntitlement = z.infer<typeof accountOperatorEntitlementSchema>;

/**
 * Service-only read of the same entitlement. The calling service proves itself with a body-bound
 * service signature and names the user and the session it already authenticated at the edge; no
 * principal is forwarded or signed. Identity checks the founder pair, the entitlement, the active
 * account, its second factor and that exact session, live. The answer is a query-time observation.
 */
export const serviceOperatorEntitlementInputSchema = z.object({ userId: id, sessionId: id }).strict();
export type ServiceOperatorEntitlementInput = z.infer<typeof serviceOperatorEntitlementInputSchema>;

const ownership = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), ownership: sessionOwnershipSchema.strict() }).strict(),
  z.object({ kind: z.literal('api_key'), ownership: apiKeyOwnershipSchema.strict() }).strict(),
]);
const authorityFields = { subject: currentAuthorityInputSchema, checkedAt: timestamp };

/**
 * Read-only snapshot, NOT admission. Lease bounds private-read access, never new
 * money actions. Consumers check their trusted clock and expire access even if
 * renewal hangs; parsing does not establish freshness or authenticate the source.
 */
export const currentAuthorityResultSchema = z
  .discriminatedUnion('status', [
    z
      .object({
        ...authorityFields,
        status: z.literal('eligible'),
        account: accountStateSchema.strict(),
        credential: ownership,
        subAccount: subAccountOwnershipSchema.strict().nullable(),
        version,
        leaseExpiresAt: timestamp,
      })
      .strict(),
    z
      .object({
        ...authorityFields,
        status: z.literal('denied'),
        code: z.enum([
          'auth.account_frozen',
          'auth.credential_denied',
          'auth.credential_revoked',
          'auth.credential_expired',
          'auth.sub_account_denied',
        ]),
      })
      .strict(),
    z.object({ ...authorityFields, status: z.literal('unavailable'), code: z.literal('authority.unavailable') }).strict(),
  ])
  .superRefine((result, ctx) => {
    if (result.status !== 'eligible') return;
    const ref = result.subject.credential;
    const credentialId = ref.kind === 'session' ? ref.sessionId : ref.apiKeyId;
    const row = result.credential.ownership;
    if (
      result.account.userId !== result.subject.userId ||
      result.account.status !== 'active' ||
      result.credential.kind !== ref.kind ||
      row.id !== credentialId ||
      row.userId !== result.subject.userId ||
      row.revoked
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credential'],
        message: 'Eligible authority must match an active identity and live credential',
      });
    }
    const sub = result.subAccount;
    if (
      result.subject.subAccountId === undefined
        ? sub !== null
        : sub === null || sub.id !== result.subject.subAccountId || sub.parentUserId !== result.subject.userId || sub.revoked
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subAccount'], message: 'Sub-account proof does not match the subject' });
    }
    const leaseMs = Date.parse(result.leaseExpiresAt) - Date.parse(result.checkedAt);
    if (!(leaseMs > 0 && leaseMs <= 5000)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leaseExpiresAt'],
        message: 'Private authority lease must be positive and at most 5000ms',
      });
    }
  });
export type CurrentAuthorityResult = z.infer<typeof currentAuthorityResultSchema>;

/** Closed operation list: recovery of a parent never admits fresh child exposure. */
export const controlledOperationSchema = z.discriminatedUnion('service', [
  z
    .object({
      service: z.literal('svc-trade'),
      kind: z.enum(['order.place', 'order.increase', 'strategy.start', 'algo.child', 'copy.mirror']),
      userId: id,
    })
    .strict(),
  z
    .object({
      service: z.literal('svc-pay'),
      kind: z.enum(['payment.create', 'payment.authorize', 'payment.capture', 'payout']),
      userId: id,
      merchantId: id,
    })
    .strict(),
]);
export type ControlledOperation = z.infer<typeof controlledOperationSchema>;

/** Internal service request. Hash canonical immutable parameters; store the original payload in its owner. */
export const operationAdmissionInputSchema = z.object({ operation: controlledOperationSchema, businessId, payloadHash }).strict();
export type OperationAdmissionInput = z.infer<typeof operationAdmissionInputSchema>;

/**
 * Only the authenticated owner returns this after durable, serialized admission.
 * Times/versions describe evidence; neither they nor schema parsing serialize a
 * cross-service identity freeze. Recovery remains valid after credentials revoke.
 */
export const committedOperationAdmissionSchema = operationAdmissionInputSchema
  .extend({
    status: z.literal('committed'),
    admissionId: id,
    admittedAt: timestamp,
    identityVersion: version,
    restrictionVersion: version,
  })
  .strict();
export type CommittedOperationAdmission = z.infer<typeof committedOperationAdmissionSchema>;

export const operationAdmissionResultSchema = z.discriminatedUnion('status', [
  committedOperationAdmissionSchema,
  z
    .object({
      status: z.literal('denied'),
      code: z.enum(['auth.account_frozen', 'trade.account_restricted', 'pay.merchant_inactive', 'operation.conflict']),
    })
    .strict(),
  z.object({ status: z.literal('unavailable'), code: z.literal('authority.unavailable') }).strict(),
]);
export type OperationAdmissionResult = z.infer<typeof operationAdmissionResultSchema>;

/** Reference only, never a caller-supplied permission to recover or replacement payload. */
export const operationRecoveryInputSchema = operationAdmissionInputSchema.extend({ admissionId: id }).strict();
export type OperationRecoveryInput = z.infer<typeof operationRecoveryInputSchema>;

/** Compare against a record loaded from trusted persistence, never a client-supplied receipt. */
export function recoveryMatchesAdmission(input: unknown, stored: unknown): boolean {
  const recovery = operationRecoveryInputSchema.safeParse(input);
  const admission = committedOperationAdmissionSchema.safeParse(stored);
  if (!recovery.success || !admission.success) return false;
  const a = recovery.data;
  const b = admission.data;
  return (
    a.admissionId === b.admissionId &&
    a.businessId === b.businessId &&
    a.payloadHash === b.payloadHash &&
    a.operation.service === b.operation.service &&
    a.operation.kind === b.operation.kind &&
    a.operation.userId === b.operation.userId &&
    (a.operation.service !== 'svc-pay' || (b.operation.service === 'svc-pay' && a.operation.merchantId === b.operation.merchantId))
  );
}

/**
 * Implementations authenticate context, check current founder entitlement/MFA,
 * and atomically audit changes. Either founder may act independently. Service
 * credentials alone cannot restrict accounts. Admission/recovery require an
 * authenticated owning service. Authority reads require an authenticated service
 * or the matching subject principal. This interface supplies no authorization
 * guard. Resolving recovery only loads the original admission; the owner performs
 * and reports its domain recovery, without treating this receipt as completion.
 */
export interface AccountControlsContract {
  change(context: Context & { principal: Principal }, input: AccountControlInput): Promise<AccountControlResult>;
  getState(context: Context & { principal: Principal }, input: { target: AccountControlTarget }): Promise<AccountControlState | null>;
  history(
    context: Context & { principal: Principal },
    input: { target: AccountControlTarget; limit: number },
  ): Promise<AccountControlResult[]>;
  operatorEntitlement(context: Context, input: { userId: string }): Promise<AccountOperatorEntitlement>;
  serviceOperatorEntitlement(context: Context, input: ServiceOperatorEntitlementInput): Promise<AccountOperatorEntitlement>;
  currentAuthority(context: Context, input: CurrentAuthorityInput): Promise<CurrentAuthorityResult>;
  admit(context: Context, input: OperationAdmissionInput): Promise<OperationAdmissionResult>;
  resolveRecovery(context: Context, input: OperationRecoveryInput): Promise<CommittedOperationAdmission>;
}

/**
 * Staff edits of one customer's personal details (J-ops-console-04 #9, OPS-accounts-desk-02 `identity.accounts.editDetails`).
 * Contact, address, occupation, income and business details are applied at once by a live founder with a reason. Name,
 * date of birth and tax number are protected: an edit of them opens a compliance review, the old value stays on record,
 * and identity applies the proposed value only when a second founder passes the review. One edit changes either open
 * details or protected ones, never both. Identity keeps the details encrypted; the history names fields, never values.
 */
export const CUSTOMER_PROTECTED_DETAIL_KEYS = ['legalName', 'dateOfBirth', 'taxNumber'] as const;
export const CUSTOMER_OPEN_DETAIL_KEYS = [
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'postalCode',
  'countryCode',
  'occupation',
  'income',
  'businessDetails',
] as const;
export const CUSTOMER_DETAIL_KEYS = [...CUSTOMER_PROTECTED_DETAIL_KEYS, ...CUSTOMER_OPEN_DETAIL_KEYS] as const;
export type CustomerDetailKey = (typeof CUSTOMER_DETAIL_KEYS)[number];
export type CustomerProtectedDetailKey = (typeof CUSTOMER_PROTECTED_DETAIL_KEYS)[number];
export const customerDetailKeySchema = z.enum(CUSTOMER_DETAIL_KEYS);

const detailText = (max: number) => z.string().trim().min(1).max(max);
/** A real calendar date of birth: from 1900 and not after today. */
const birthDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      value >= '1900-01-01' &&
      value <= new Date().toISOString().slice(0, 10)
    );
  }, 'a real date of birth (YYYY-MM-DD, from 1900, not in the future)');

/** One schema per detail. A null value is "not on record"; identity never fills one in. */
export const customerDetailValueSchemas = {
  legalName: detailText(200),
  dateOfBirth: birthDate,
  taxNumber: detailText(64),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{3,31}$/),
  addressLine1: detailText(200),
  addressLine2: detailText(200),
  city: detailText(100),
  postalCode: detailText(32),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  occupation: detailText(120),
  income: detailText(120),
  businessDetails: detailText(500),
} as const satisfies Record<CustomerDetailKey, z.ZodType<string>>;

export const customerDetailsSchema = z
  .object(
    Object.fromEntries(CUSTOMER_DETAIL_KEYS.map((key) => [key, customerDetailValueSchemas[key].nullable()])) as {
      [K in CustomerDetailKey]: z.ZodNullable<(typeof customerDetailValueSchemas)[K]>;
    },
  )
  .strict();
export type CustomerDetails = z.infer<typeof customerDetailsSchema>;

/** The details an edit changes: a value sets it, null takes it off the record. At least one. */
export const customerDetailChangesSchema = customerDetailsSchema
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, 'at least one detail');
export type CustomerDetailChanges = z.infer<typeof customerDetailChangesSchema>;

const detailReason = z.string().trim().min(12).max(255);

export const customerDetailReviewStatuses = ['open', 'passed', 'rejected'] as const;
export const customerDetailReviewSchema = z
  .object({
    reviewId: id,
    userId: id,
    status: z.enum(customerDetailReviewStatuses),
    fields: z.array(z.enum(CUSTOMER_PROTECTED_DETAIL_KEYS)).min(1).max(3),
    /** The proposed values, shown to founders only; the record keeps the old ones until the review passes. */
    proposed: customerDetailsSchema.pick({ legalName: true, dateOfBirth: true, taxNumber: true }).partial().strict(),
    /** KYC documents of this same customer the requester attached as evidence (identity's encrypted store). */
    documentIds: z.array(id).max(5),
    reason: detailReason,
    requestedBy: id,
    requestedAt: timestamp,
    decidedBy: id.nullable(),
    decidedAt: timestamp.nullable(),
    decisionNote: detailReason.nullable(),
  })
  .strict()
  .refine((review) => (review.status === 'open') === (review.decidedBy === null), 'an open review has no decision');
export type CustomerDetailReview = z.infer<typeof customerDetailReviewSchema>;

export const customerDetailsStateSchema = z
  .object({
    userId: id,
    /** Bumped by every applied change; an edit names the version it read. */
    version,
    details: customerDetailsSchema,
    openReview: customerDetailReviewSchema.nullable(),
    /** An archived record is read-only (`identity.account_archived`). */
    archived: z.boolean(),
  })
  .strict();
export type CustomerDetailsState = z.infer<typeof customerDetailsStateSchema>;

export const customerDetailsLookupInputSchema = z.object({ userId: id }).strict();
export const customerDetailsHistoryInputSchema = z.object({ userId: id, limit: z.number().int().min(1).max(200) }).strict();
export const customerDetailReviewsInputSchema = customerDetailsHistoryInputSchema;

export const customerDetailsEditInputSchema = z
  .object({
    requestId: id,
    userId: id,
    expectedVersion: version,
    reason: detailReason,
    changes: customerDetailChangesSchema,
    documentIds: z.array(id).max(5).optional(),
  })
  .strict();
export type CustomerDetailsEditInput = z.infer<typeof customerDetailsEditInputSchema>;

export const customerDetailDecisionInputSchema = z
  .object({
    requestId: id,
    /** The customer the review is about; identity refuses a review of anyone else as not found. */
    userId: id,
    reviewId: id,
    decision: z.enum(['pass', 'reject']),
    note: detailReason,
  })
  .strict();
export type CustomerDetailDecisionInput = z.infer<typeof customerDetailDecisionInputSchema>;

/** Kept in the history: which fields, who and why. Never the values. */
const detailAuditFields = {
  auditId: id,
  requestId: id,
  userId: id,
  fields: z.array(customerDetailKeySchema).max(CUSTOMER_DETAIL_KEYS.length),
  reason: detailReason,
  occurredAt: timestamp,
};
export const customerDetailsResultSchema = z.discriminatedUnion('outcome', [
  /** Open details applied by the editor, or protected ones applied when the second founder passed their review. */
  z
    .object({
      ...detailAuditFields,
      outcome: z.literal('applied'),
      changed: z.literal(true),
      actorUserId: id,
      reviewId: id.nullable(),
      version,
    })
    .strict(),
  /** Protected details asked for: nothing changed on the record yet. */
  z
    .object({
      ...detailAuditFields,
      outcome: z.literal('review_opened'),
      changed: z.literal(false),
      actorUserId: id,
      reviewId: id,
      version,
    })
    .strict(),
  z
    .object({
      ...detailAuditFields,
      outcome: z.literal('review_rejected'),
      changed: z.literal(false),
      actorUserId: id,
      reviewId: id,
      version,
    })
    .strict(),
  z
    .object({
      ...detailAuditFields,
      outcome: z.literal('refused'),
      changed: z.literal(false),
      actorUserId: id.nullable(),
      reviewId: id.nullable(),
      code: z.enum([
        'operator.denied',
        'mfa.required',
        'target.not_found',
        'request.conflict',
        'identity.account_archived',
        'identity.details_unconfigured',
        'identity.details_founder_forbidden',
        'identity.details_mixed_edit',
        'identity.details_unchanged',
        'identity.details_documents_unknown',
        'identity.details_review_open',
        'identity.details_review_not_found',
        'identity.details_review_closed',
        'identity.details_review_self_forbidden',
      ]),
    })
    .strict(),
  z
    .object({
      ...detailAuditFields,
      outcome: z.literal('conflict'),
      changed: z.literal(false),
      actorUserId: id,
      reviewId: z.null(),
      code: z.literal('restriction.version_conflict'),
      version,
    })
    .strict(),
]);
export type CustomerDetailsResult = z.infer<typeof customerDetailsResultSchema>;
