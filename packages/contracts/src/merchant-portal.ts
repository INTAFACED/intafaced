import { z } from 'zod';
import { payAmountStringSchema, payAssetCodeSchema, payBpsSchema, payMerchantIdSchema, payTimestampSchema } from './merchant-control.js';
import { merchantStatementDescriptorSchema } from './merchant-descriptor.js';
import { payListCursorSchema } from './pay-merchant-reads.js';

/**
 * Merchant portal reads that the customer app can treat as the business-access
 * source, plus the business profile and the volume/fee series.
 *
 * Amounts are decimal strings, one asset per row. Two assets are never folded
 * into one figure. A missing business number stays null or a named
 * not-configured state: this module does not publish a fee, a cap, or a terms
 * version.
 */

/**
 * Local-test starter fee, when the pay service was booted with one.
 * Absent on the product: the starter fee is not set yet. `local_test` is the
 * only source this contract names, so a screen can label it as a test fee.
 */
export const merchantStarterFeeSchema = z
  .object({
    bps: payBpsSchema,
    source: z.literal('local_test'),
  })
  .strict();
export type MerchantStarterFeeView = z.infer<typeof merchantStarterFeeSchema>;

export const MERCHANT_PORTAL_ROLES = ['owner', 'admin', 'finance', 'developer', 'viewer'] as const;
export const merchantPortalRoleSchema = z.enum(MERCHANT_PORTAL_ROLES);

/**
 * One boolean per team permission. The service fills these from the role table.
 * Keep the keys aligned with `MERCHANT_PERMISSIONS` in svc-pay (the portal test pins it).
 */
export const merchantCapabilityFlagsSchema = z
  .object({
    'team.read': z.boolean(),
    'team.manage': z.boolean(),
    'disputes.read': z.boolean(),
    'disputes.respond': z.boolean(),
    'invoices.read': z.boolean(),
    'invoices.write': z.boolean(),
    'customers.read': z.boolean(),
    'kyb.read': z.boolean(),
    'profile.read': z.boolean(),
    'profile.manage': z.boolean(),
    'exports.create': z.boolean(),
    'exports.read': z.boolean(),
    'notifications.read': z.boolean(),
    'notifications.manage': z.boolean(),
    'payments.read': z.boolean(),
    'settlements.read': z.boolean(),
    'halts.read': z.boolean(),
    'payout.request': z.boolean(),
    'payout.approve': z.boolean(),
    'activity.read': z.boolean(),
    'payouts.read': z.boolean(),
    'webhooks.read': z.boolean(),
    'webhooks.manage': z.boolean(),
    'products.read': z.boolean(),
    'products.manage': z.boolean(),
    'payments.unmask': z.boolean(),
  })
  .strict();

export const merchantMembershipSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    role: merchantPortalRoleSchema,
    status: z.enum(['pending', 'active', 'suspended', 'closed']),
    kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
    /** True only when the stored KYB status is approved. A pending identity change does not flip this. */
    verified: z.boolean(),
    /** True while a sensitive identity proposal is waiting on INTAFACED compliance. The live row is still the old identity. */
    identityChangePending: z.boolean(),
    /** False for an API key or a session without MFA. Write capability flags are false in that case. */
    sessionInteractive: z.boolean(),
    mode: z.enum(['gateway', 'psp', 'payfac']),
    displayName: z.string().nullable(),
    legalName: z.string().nullable(),
    capabilities: merchantCapabilityFlagsSchema,
    /** Viewer and developer stay on the fee-only pricing projection. */
    pricingVisibility: z.enum(['full', 'fee_only']),
  })
  .strict();

export const merchantMyAccessSchema = z.object({ memberships: z.array(merchantMembershipSchema) }).strict();
export type MerchantMyAccess = z.infer<typeof merchantMyAccessSchema>;

export const merchantAddressSchema = z
  .object({
    line1: z.string(),
    line2: z.string().nullable(),
    city: z.string(),
    region: z.string().nullable(),
    postalCode: z.string(),
    country: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();

export const merchantBusinessProfileSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    version: z.string().regex(/^\d{1,18}$/),
    displayName: z.string().nullable(),
    legalName: z.string().nullable(),
    address: merchantAddressSchema.nullable(),
    website: z.string().nullable(),
    supportEmail: z.string().nullable(),
    supportPhone: z.string().nullable(),
    statementDescriptor: z.string().nullable(),
    industry: z.string().nullable(),
    /** The owner's rule: a legal-detail change also needs a second teammate before INTAFACED reviews it. */
    secondApprovalEnabled: z.boolean(),
  })
  .strict();
export type MerchantBusinessProfile = z.infer<typeof merchantBusinessProfileSchema>;
/** The fields a change request edits: the profile without its key, version and the second-approval rule. */
const merchantProfileFieldsSchema = merchantBusinessProfileSchema.omit({ merchantId: true, version: true, secondApprovalEnabled: true });

/**
 * Identity a compliance proposer reads before filing a KYB approval.
 * `identityHash` is the only binding. Website, support email, display name,
 * and the profile version are absent: those edits must not invalidate an
 * approval of this identity.
 */
export const kybDecisionBindingSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    legalName: z.string().nullable(),
    address: merchantAddressSchema.nullable(),
    statementDescriptor: z.string().nullable(),
    industry: z.string().nullable(),
    identityHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type KybDecisionBindingView = z.infer<typeof kybDecisionBindingSchema>;

const profileField = z.string().nullable().optional();

export const merchantBusinessProfileSubmitInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    expectedVersion: z.string().regex(/^\d{1,18}$/),
    reason: z.string().trim().min(3).max(500),
    displayName: profileField,
    legalName: profileField,
    address: merchantAddressSchema.nullable().optional(),
    website: profileField,
    supportEmail: profileField,
    supportPhone: profileField,
    /** '' or null clears the descriptor; any other value must pass the shared descriptor validator. */
    statementDescriptor: z
      .union([z.literal(''), merchantStatementDescriptorSchema])
      .nullable()
      .optional(),
    industry: profileField,
  })
  .strict();

export const merchantBusinessProfileSubmitResultSchema = z
  .object({
    requestId: z.string().guid(),
    outcome: z.enum(['applied', 'pending_review', 'pending_second_approval']),
    version: z.string().regex(/^\d{1,18}$/),
    /** Hash of the sensitive proposal. Compliance review must send this exact value. Null when nothing is waiting. */
    changeHash: z.string().nullable(),
    profile: merchantBusinessProfileSchema,
  })
  .strict();

export const merchantBusinessProfileDecideResultSchema = z
  .object({
    requestId: z.string().guid(),
    outcome: z.enum(['applied', 'rejected', 'pending_review']),
    version: z.string().regex(/^\d{1,18}$/),
    profile: merchantBusinessProfileSchema,
  })
  .strict();

export const merchantBusinessProfileConfirmInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    requestId: z.string().guid(),
    decision: z.enum(['confirm', 'reject', 'withdraw']),
    expectedChangeHash: z.string().min(8).max(200),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/**
 * Optional merchant second approver. Default off: a sensitive submit goes
 * straight to compliance review. Turning this on adds a merchant confirm
 * step that still does not apply the identity.
 */
export const merchantProfileSecondApprovalInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    enabled: z.boolean(),
  })
  .strict();

export const merchantProfileSecondApprovalResultSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    enabled: z.boolean(),
  })
  .strict();

/**
 * INTAFACED compliance decide for a sensitive identity proposal.
 * Same approval shape as `merchant.decideKyb`: scope is `admin:compliance`,
 * and a typed-in second name is not the approval.
 */
export const merchantBusinessProfileReviewInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    requestId: z.string().guid(),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(3).max(500),
    expectedChangeHash: z.string().min(8).max(200),
    confirmOperatorId: z.string().max(128).nullish(),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  })
  .strict();

export const merchantBusinessProfileReviewResultSchema = z
  .object({
    requestId: z.string().guid(),
    outcome: z.enum(['applied', 'rejected']),
    version: z.string().regex(/^\d{1,18}$/),
    profile: merchantBusinessProfileSchema,
    confirmOperatorId: z.string(),
  })
  .strict();

export const merchantProfileChangeSchema = z
  .object({
    requestId: z.string().guid(),
    /** bigserial ordering key. A string, never a number. */
    seq: z.string().regex(/^\d+$/),
    /**
     * `applied_pre_kyb` is a sensitive edit written onto the live row while KYB
     * is `none` or `rejected`. While KYB is `pending`, a sensitive edit is refused.
     * After approval, a sensitive edit is `pending` or `pending_review` until
     * compliance decides.
     */
    status: z.enum(['applied', 'applied_pre_kyb', 'pending', 'pending_review', 'rejected', 'conflict']),
    before: merchantProfileFieldsSchema,
    after: merchantProfileFieldsSchema,
    sensitiveKeys: z.array(z.enum(['legalName', 'address', 'statementDescriptor', 'industry'])),
    changeHash: z.string(),
    expectedVersion: z.string().regex(/^\d{1,18}$/),
    makerId: z.string(),
    checkerId: z.string().nullable(),
    /** Merchant who confirmed the optional second step. Null when that step is off or not taken. */
    secondApproverId: z.string().nullable(),
    reason: z.string(),
    checkerReason: z.string().nullable(),
    createdAt: payTimestampSchema,
    decidedAt: payTimestampSchema.nullable(),
  })
  .strict();

export const merchantProfileHistoryInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    limit: z.number().int().min(1).max(200).optional(),
    cursor: payListCursorSchema.optional(),
  })
  .strict();

export const merchantProfileHistorySchema = z
  .object({
    items: z.array(merchantProfileChangeSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const merchantPortalMerchantInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();

/**
 * The merchant terms of service (J-merchant-02, going live). The owner publishes a version and where to read it
 * (`PAY_MERCHANT_TERMS_VERSION`, `PAY_MERCHANT_TERMS_URL`). While either is blank there is nothing to accept and the
 * state is `not_configured`. Each acceptance is kept for good, per business and version: a new version needs a new one.
 */
export const merchantTermsStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_configured') }).strict(),
  z.object({ state: z.literal('not_accepted'), version: z.string().min(1), url: z.string().url() }).strict(),
  z
    .object({
      state: z.literal('accepted'),
      version: z.string().min(1),
      url: z.string().url(),
      acceptedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
export type MerchantTermsState = z.infer<typeof merchantTermsStateSchema>;

/** The owner accepts the version they were shown. A version that is no longer the published one is refused. */
export const merchantTermsAcceptInputSchema = z.object({ merchantId: payMerchantIdSchema, version: z.string().min(1).max(64) }).strict();
export const merchantTermsAcceptResultSchema = z
  .object({ merchantId: payMerchantIdSchema, version: z.string(), acceptedAt: z.string().datetime({ offset: true }) })
  .strict();

export const ONBOARDING_BLOCKERS = [
  'business_incomplete',
  'documents_pending_vendor',
  'destination_missing',
  'terms_not_configured',
  'terms_not_accepted',
  'kyb_not_approved',
  'merchant_not_active',
  /** RC-merchant-08: the owner has published no business categories. */
  'category_policy_unset',
  /** The business has not chosen its category. */
  'category_not_chosen',
  /** The chosen category is prohibited: INTAFACED does not take this business. */
  'category_prohibited',
  /** The chosen category is restricted and its reserve terms are blank. */
  'reserve_terms_unset',
] as const;

export const merchantOnboardingProgressSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    business: z
      .object({
        done: z.boolean(),
        missing: z.array(z.enum(['legalName', 'displayName', 'address'])),
      })
      .strict(),
    /** No document vendor is wired. This state does not become "done". */
    documents: z.object({ state: z.literal('pending_vendor') }).strict(),
    terms: merchantTermsStateSchema,
    destination: z
      .object({
        present: z.boolean(),
        destinations: z.array(
          z
            .object({
              railId: z.string(),
              kind: z.string(),
              destinationMasked: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
    merchantStatus: z.enum(['pending', 'active', 'suspended', 'closed']),
    blocking: z.array(z.enum(ONBOARDING_BLOCKERS)),
  })
  .strict();

export const merchantAnalyticsBucketSchema = z.enum(['day', 'week']);

export const merchantAnalyticsInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    from: payTimestampSchema,
    to: payTimestampSchema,
    bucket: merchantAnalyticsBucketSchema,
    limit: z.number().int().min(1).max(200).optional(),
    cursor: payListCursorSchema.optional(),
    assetId: payAssetCodeSchema.optional(),
  })
  .strict();

export const metricsFreshnessOutSchema = z
  .object({ asOf: payTimestampSchema.nullable(), lagSeconds: z.number().int().min(0).nullable() })
  .strict();

export const merchantVolumePointSchema = z
  .object({
    period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    assetCode: payAssetCodeSchema,
    count: z.number().int().min(0),
    volume: payAmountStringSchema,
  })
  .strict();

export const merchantAnalyticsVolumeSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    bucket: merchantAnalyticsBucketSchema,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    freshness: metricsFreshnessOutSchema,
    items: z.array(merchantVolumePointSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

/** Fees and gross on a rate row. A refused row may be negative; every other row is not. */
const signedPayAmountSchema = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

const LEDGER_SCALE = 10n ** 18n;
const FEE_RATE_SCALE = 1_000_000n;

function ledgerScaled(raw: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,18}))?$/.exec(raw);
  if (!match) return null;
  const [, sign, whole, frac = ''] = match;
  const value = BigInt(whole ?? '0') * LEDGER_SCALE + BigInt(frac.padEnd(18, '0'));
  return sign === '-' ? -value : value;
}

function feeRateScaled(raw: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) return null;
  const [, whole, frac = ''] = match;
  return BigInt(whole ?? '0') * FEE_RATE_SCALE + BigInt(frac.padEnd(6, '0'));
}

/**
 * Fees ÷ gross for one asset over the requested window. The quotient is rounded
 * down to 6 decimal places. `exact` lost nothing; `rounded` did. `no_volume`
 * is a zero gross, not a rate of 0. `refused` is a negative input.
 */
export const merchantEffectiveRateSchema = z
  .object({
    assetCode: payAssetCodeSchema,
    fees: signedPayAmountSchema,
    gross: signedPayAmountSchema,
    rate: payAmountStringSchema.nullable(),
    rateStatus: z.enum(['exact', 'rounded', 'no_volume', 'refused']),
  })
  .strict()
  .superRefine((value, ctx) => {
    const negative = value.fees.startsWith('-') || value.gross.startsWith('-');
    const publishes = value.rateStatus === 'exact' || value.rateStatus === 'rounded';
    if (publishes && value.rate === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a published rate needs a quotient' });
    }
    if (!publishes && value.rate !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only a published quotient carries a rate' });
    }
    if (value.rate !== null && !/^\d+(\.\d{1,6})?$/.test(value.rate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a rate has at most 6 decimal places' });
    }
    if (value.rateStatus === 'no_volume' && (value.gross !== '0' || negative)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'no_volume requires a zero gross and a non-negative fee' });
    }
    if (value.rateStatus === 'refused' && !negative) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'refused requires a negative input' });
    }
    if (publishes && (negative || value.gross === '0')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a published rate needs a positive gross and a non-negative fee' });
    }
    if (publishes && value.rate !== null && !negative && value.gross !== '0') {
      const fees = ledgerScaled(value.fees);
      const gross = ledgerScaled(value.gross);
      const rate = feeRateScaled(value.rate);
      if (fees === null || gross === null || rate === null || gross <= 0n) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a published rate needs a readable quotient' });
      } else {
        const quotient = (fees * FEE_RATE_SCALE) / gross;
        const remainder = (fees * FEE_RATE_SCALE) % gross;
        if (rate !== quotient) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the rate is not the rounded-down quotient' });
        }
        if (value.rateStatus === 'exact' && remainder !== 0n) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exact requires a quotient that fits 6 decimal places' });
        }
        if (value.rateStatus === 'rounded' && remainder === 0n) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'rounded requires a quotient that does not fit 6 decimal places' });
        }
      }
    }
  });

export const merchantFeePointSchema = z
  .object({
    period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    assetCode: payAssetCodeSchema,
    gross: payAmountStringSchema,
    fees: payAmountStringSchema,
    net: payAmountStringSchema,
    refunded: payAmountStringSchema,
  })
  .strict();

export const merchantAnalyticsFeesSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    bucket: merchantAnalyticsBucketSchema,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    freshness: metricsFreshnessOutSchema,
    items: z.array(merchantFeePointSchema),
    nextCursor: z.string().nullable(),
    /**
     * There is no single rate across assets. `rates` is fees ÷ gross per asset
     * over the whole window, rounded down to 6 decimal places. `rounded` keeps
     * that quotient. `exact` lost nothing. A zero gross is `no_volume`, not 0.
     * A negative input is `refused`.
     */
    effectiveRate: z.null(),
    effectiveRateReason: z.literal('not_aggregated'),
    rates: z.array(merchantEffectiveRateSchema).max(200),
    /** Conversion cost is not on the merchant-day projection. */
    conversionCost: z.null(),
    byRule: z.array(z.never()),
  })
  .strict();

export const merchantCustomerSeriesInputSchema = z
  .object({
    customerRef: z.string().trim().min(1).max(200),
    from: payTimestampSchema,
    to: payTimestampSchema,
    bucket: merchantAnalyticsBucketSchema,
    limit: z.number().int().min(1).max(200).optional(),
    cursor: payListCursorSchema.optional(),
    assetId: payAssetCodeSchema.optional(),
  })
  .strict();

export const merchantCustomerSeriesSchema = z
  .object({
    customerRef: z.string(),
    bucket: merchantAnalyticsBucketSchema,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    items: z.array(merchantVolumePointSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
