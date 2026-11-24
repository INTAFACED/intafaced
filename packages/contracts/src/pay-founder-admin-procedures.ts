import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { assetIdSchema } from './asset-id.js';
import { kycTierSchema } from './identity.js';
import { withdrawalAllowanceInputSchema, withdrawalAllowanceSchema } from './withdrawal-allowance.js';
import {
  founderLimitRequestListInputSchema,
  founderLimitRequestListSchema,
  merchantControlGetInputSchema,
  merchantControlProfileSchema,
  payAmountStringSchema,
  payAssetCodeSchema,
  payCapSchema,
  payControlUsageSchema,
  payPayoutFeeSchema,
  payPricingRuleSchema,
  payReserveSchema,
  payRiskTierIdSchema,
  payTimestampSchema,
  payVersionSchema,
} from './merchant-control.js';
import { payCustodyOpenItemsInputSchema, payCustodyOpenItemsReplySchema } from './pay-custody-deposit.js';
import { depositFreezeViewSchema } from './pay-deposit-freezes.js';
import {
  founderDisputeListInputSchema,
  founderDisputeListSchema,
  founderGlobalMetricsInputSchema,
  founderGlobalMetricsSchema,
  founderLiveSummarySchema,
  founderMerchantDrilldownInputSchema,
  founderMerchantDrilldownSchema,
  founderMerchantListInputSchema,
  founderMerchantListSchema,
  founderMerchantSectionInputSchema,
  founderMerchantSectionSchema,
  founderPayoutListInputSchema,
  founderPayoutListSchema,
  founderRecentMerchantsInputSchema,
  founderRecentMerchantsSchema,
  founderRiskSummaryInputSchema,
  founderRiskSummarySchema,
  founderTreasuryExposureSchema,
  founderChangeSubmitInputSchema,
  founderChangeSubmitResultSchema,
  founderChangeConfirmInputSchema,
  founderApprovalQueueInputSchema,
  founderApprovalQueueSchema,
  founderControlAuditListInputSchema,
  founderControlAuditListSchema,
} from './founder-admin.js';
import {
  merchantMetricsInputSchema,
  merchantMetricsSeriesInputSchema,
  merchantMetricsSeriesSchema,
  merchantMetricsSnapshotSchema,
} from './merchant-metrics.js';
import {
  categoryPolicyEventSchema,
  categoryPolicyHistoryInputSchema,
  categoryPolicyListInputSchema,
  categoryPolicyViewSchema,
} from './business-category.js';
import { jsonValueSchema } from './procedure-strict-schema.js';
import { payPageSchema } from './pay-merchant-reads.js';
import { heldDepositViewSchema } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `founderAdmin.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const assetId = z.string().min(1).max(16);

/**
 * Wire shapes for `founderAdmin.limits.*`. Amounts are unsigned decimal strings,
 * never a JSON number. Every input object is `.strict()`.
 */
export const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

/** Both figures, or `null` to clear the limit back to unset (the guard then refuses withdrawals). */
export const limitFiguresSchema = z.object({ perTx: amount, rolling24h: amount }).strict();

export const limitViewSchema = z
  .object({
    tier: kycTierSchema,
    assetId,
    /** `null` is unset: the guard refuses withdrawals for this tier and asset. */
    limit: limitFiguresSchema.nullable(),
    version: z.number().int(),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .strict();

export const tierListInputSchema = z.object({}).strict();

/**
 * Wire shapes W1 needs beyond packages/contracts/src/merchant-control.ts.
 * They live here, not in the contract package, because W1 does not own that
 * package; hoist them there when the apps start importing them.
 *
 * Money is a decimal string. No schema here carries a default number.
 */
export const ARCHETYPES = ['psp', 'broker', 'gaming', 'standard'] as const;

export const archetypeSchema = z.enum(ARCHETYPES);

export const thresholdSchema = z.object({ assetCode: payAssetCodeSchema, amount: payAmountStringSchema }).strict();

export const tierDefinitionSchema = z
  .object({
    id: payRiskTierIdSchema,
    name: z.string().trim().min(1).max(64),
    archetype: archetypeSchema,
    caps: z.array(payCapSchema).min(1).max(32),
    /** Null = this tier holds no rolling reserve. */
    reserve: payReserveSchema.nullable(),
    /** Payouts at or above this amount, per asset, need a second team member. */
    approvalThresholds: z.array(thresholdSchema).min(1).max(32),
    /** Payouts at or above this amount, per asset, also need two distinct founders. */
    founderThresholds: z.array(thresholdSchema).min(1).max(32),
    /** How long an approval request stays valid. Bounds are validation, not defaults. */
    approvalTtlSeconds: z.number().int().min(60).max(2_592_000),
    /**
     * When true, every merchant may read this tier's commercial terms.
     * Omitted means false: the tier stays off the ladder except for the merchant
     * it is assigned to.
     */
    merchantVisible: z.boolean().optional(),
    /**
     * The payout fee the tier publishes to merchants. Null withdraws it (none is
     * published, and merchants read "Not set"); omitted keeps what the tier
     * publishes now, which for a new tier is none. `not_charged` is the only
     * kind, because payouts charge no fee (payment-service/payouts.ts).
     */
    payoutFee: payPayoutFeeSchema.nullable().optional(),
  })
  .strict();

export const tierViewSchema = tierDefinitionSchema
  .extend({
    version: payVersionSchema,
    merchants: z.number().int().min(0),
    merchantVisible: z.boolean(),
    payoutFee: payPayoutFeeSchema.nullable(),
  })
  .strict();

export const limit = z.number().int().min(1).max(200);

/**
 * Wire shapes for custody approval tasks (W-custody-ops-06). Every input object is `.strict()`. No field has a default: a
 * blank one is a parse error. The upper bounds are input safety, not product values.
 */
export const id = z.string().guid();

export const pendingInputSchema = z.object({ limit: limit.optional(), after: id.optional() }).strict();

export const TASK_KINDS = ['custody_transaction', 'config'] as const;

export const CONFIG_SCOPES = ['address_whitelist', 'connections', 'users', 'policy', 'approval_groups'] as const;

export const payload = z.record(z.string(), jsonValueSchema);

export const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const TASK_STATUSES = ['pending', 'approved', 'rejected', 'canceled', 'expired', 'failed', 'executed'] as const;

export const stamp = z.string().datetime({ offset: true });

export const taskViewSchema = z.object({
  id,
  clientRef: z.string(),
  kind: z.enum(TASK_KINDS),
  scope: z.enum(CONFIG_SCOPES).nullable(),
  title: z.string(),
  payload,
  payloadHash: hash,
  initiator: z.string(),
  requiredApprovals: z.number().int(),
  approvalCount: z.number().int(),
  /** Whether the viewer already approved. */
  approvedByMe: z.boolean(),
  status: z.enum(TASK_STATUSES),
  failureCode: z.string().nullable(),
  expiresAt: stamp,
  createdAt: stamp,
  decidedAt: stamp.nullable(),
  executedAt: stamp.nullable(),
});

/** `limit` is optional here so an omitted bound reaches `custody_approval.list_limit_unset` and not a parse error. */
export const listInputSchema = z
  .object({ status: z.enum(TASK_STATUSES).optional(), kind: z.enum(TASK_KINDS).optional(), limit: limit.optional(), after: id.optional() })
  .strict();

export const APPROVER_ROLES = ['founder', 'keyless'] as const;

export const approverViewSchema = z.object({
  userId: z.string(),
  label: z.string(),
  /** `keyless` approvers decide tasks and hold no signing key: nothing here ever gives them one. */
  role: z.enum(APPROVER_ROLES),
  active: z.boolean(),
  setBy: z.string(),
  setAt: stamp,
});

export const taskIdInputSchema = z.object({ taskId: id }).strict();

export const timelineEntrySchema = z.object({
  kind: z.string(),
  actor: z.string(),
  detail: z.record(z.string(), jsonValueSchema),
  at: stamp,
});

export const taskDetailSchema = taskViewSchema.extend({ timeline: z.array(timelineEntrySchema) });

export const userIdSchema = z.string().min(1).max(128);

export const depositAddressStateSchema = z
  .object({
    /** `<networkId>:<address>`: an address belongs to one customer, asset and network. */
    id: z.string(),
    userId: z.string(),
    assetId: assetIdSchema,
    networkId: z.string(),
    address: z.string(),
    /** When an extra address stops being for deposits; null when it never expires. */
    expiresAt: z.string().nullable(),
    frozen: z.boolean(),
    /** The open freeze, when there is one. */
    freezeId: z.string().nullable(),
    freezeReason: z.string().nullable(),
    frozenBy: z.string().nullable(),
    frozenAt: z.string().nullable(),
    /** Deposits to this address held by a freeze now. */
    held: z.number().int(),
  })
  .strict();

export const REGISTRIES = ['venue', 'network', 'wallet_route'] as const;

export const registryKindSchema = z.enum(REGISTRIES);

export const registryHistoryInputSchema = z
  .object({
    registry: registryKindSchema,
    entryKey: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(200),
  })
  .strict();

export const registryEventViewSchema = z
  .object({
    id: z.string().guid(),
    seq: z.string(),
    registry: registryKindSchema,
    entryKey: z.string(),
    action: z.enum(['create', 'update']),
    actorId: z.string(),
    approverId: z.string().nullable(),
    dualControl: z.boolean(),
    before: z.record(z.string(), jsonValueSchema).nullable(),
    after: z.record(z.string(), jsonValueSchema),
    reason: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const pricingRuleListInputSchema = z
  .object({ layer: z.enum(['global', 'tier', 'merchant']).optional(), scopeId: z.string().min(1).max(64).optional() })
  .strict();

/** The contract's rule plus the optional min/max fee the contract does not carry. */
export const controlPricingRuleSchema = payPricingRuleSchema
  .extend({ minFee: payAmountStringSchema.nullable().optional(), maxFee: payAmountStringSchema.nullable().optional() })
  .strict();

export const pricingRuleViewSchema = controlPricingRuleSchema
  .extend({ ruleId: z.string().guid(), version: payVersionSchema, createdAt: payTimestampSchema })
  .strict();

export const PAY_FOUNDER_ADMIN_LIMITS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.limits.list',
  kind: 'query',
  path: 'founderAdmin.limits.list',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: z.array(limitViewSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * One customer's withdrawal allowance for one asset, read the way the guard reads it (J-ops-console-04 #12): base,
 * override in force, used and left. Refuses with the guard's own typed codes, never a guessed figure.
 */
export const PAY_FOUNDER_ADMIN_LIMITS_CUSTOMER = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.limits.customer',
  kind: 'query',
  path: 'founderAdmin.limits.customer',
  access: { caller: 'founder' },
  refusals: { 'pay.guard_withdrawal_limit_unset': 'FORBIDDEN' },
  input: withdrawalAllowanceInputSchema,
  output: withdrawalAllowanceSchema,
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', assetId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CONTROL_TIERS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.control.tiers.list',
  kind: 'query',
  path: 'founderAdmin.control.tiers.list',
  access: { caller: 'founder' },
  refusals: {},
  input: tierListInputSchema,
  output: z.array(tierViewSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CUSTODY_APPROVERS_PENDING = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.custody.approvers.pending',
  kind: 'query',
  path: 'founderAdmin.custody.approvers.pending',
  access: { caller: 'founder' },
  refusals: {},
  input: pendingInputSchema,
  output: z.array(taskViewSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CUSTODY_TASKS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.custody.tasks.list',
  kind: 'query',
  path: 'founderAdmin.custody.tasks.list',
  access: { caller: 'founder' },
  refusals: {},
  input: listInputSchema,
  output: z.array(taskViewSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CUSTODY_APPROVERS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.custody.approvers.list',
  kind: 'query',
  path: 'founderAdmin.custody.approvers.list',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({}).strict(),
  output: z.array(approverViewSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_DEPOSIT_OPEN_ITEMS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.depositOpenItems.list',
  kind: 'query',
  path: 'founderAdmin.depositOpenItems.list',
  access: { caller: 'founder' },
  refusals: {},
  input: payCustodyOpenItemsInputSchema,
  output: payCustodyOpenItemsReplySchema,
  outputChecks: { signed_decimal_holds: { at: ['output.items[].signedAmount', 'output.sums[].net'], says: 'a zero is never negative' } },
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CUSTODY_TASKS_GET = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.custody.tasks.get',
  kind: 'query',
  path: 'founderAdmin.custody.tasks.get',
  access: { caller: 'founder' },
  refusals: {},
  input: taskIdInputSchema,
  output: taskDetailSchema,
  samples: [
    { verdict: 'accept', input: { taskId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_DEPOSIT_FREEZES_ADDRESSES = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.depositFreezes.addresses',
  kind: 'query',
  path: 'founderAdmin.depositFreezes.addresses',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({ userId: userIdSchema }).strict(),
  output: z.array(depositAddressStateSchema),
  samples: [
    { verdict: 'accept', input: { userId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_DEPOSIT_FREEZES_HISTORY = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.depositFreezes.history',
  kind: 'query',
  path: 'founderAdmin.depositFreezes.history',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({ userId: userIdSchema, limit: z.number().int().min(1).max(200).default(50) }).strict(),
  output: z.array(depositFreezeViewSchema),
  samples: [
    { verdict: 'accept', input: { userId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CONTROL_LIMIT_REQUESTS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.control.limitRequests.list',
  kind: 'query',
  path: 'founderAdmin.control.limitRequests.list',
  access: { caller: 'founder' },
  refusals: {},
  input: founderLimitRequestListInputSchema,
  output: founderLimitRequestListSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_MERCHANTS_SECTION = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.merchants.section',
  kind: 'query',
  path: 'founderAdmin.merchants.section',
  access: { caller: 'founder' },
  refusals: { 'pay.merchant_pricing_invalid': 'BAD_REQUEST', 'pay.payment_list_limit_unset': 'BAD_REQUEST' },
  input: founderMerchantSectionInputSchema,
  output: founderMerchantSectionSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', section: 'payments' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_MERCHANTS_RECENT = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.merchants.recent',
  kind: 'query',
  path: 'founderAdmin.merchants.recent',
  access: { caller: 'founder' },
  refusals: {},
  input: founderRecentMerchantsInputSchema,
  output: founderRecentMerchantsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_PAYOUTS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.payouts.list',
  kind: 'query',
  path: 'founderAdmin.payouts.list',
  access: { caller: 'founder' },
  refusals: {},
  input: founderPayoutListInputSchema,
  output: founderPayoutListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_DISPUTES_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.disputes.list',
  kind: 'query',
  path: 'founderAdmin.disputes.list',
  access: { caller: 'founder' },
  refusals: {},
  input: founderDisputeListInputSchema,
  output: founderDisputeListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_LIVE_SUMMARY = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.live.summary',
  kind: 'query',
  path: 'founderAdmin.live.summary',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({}).strict(),
  output: founderLiveSummarySchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_RISK_SUMMARY = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.risk.summary',
  kind: 'query',
  path: 'founderAdmin.risk.summary',
  access: { caller: 'founder' },
  refusals: {},
  input: founderRiskSummaryInputSchema,
  output: founderRiskSummarySchema,
  samples: [
    { verdict: 'accept', input: { topN: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Any merchant's snapshot (the same figures the merchant sees). Founder authority replaces ownership. */
export const PAY_FOUNDER_ADMIN_METRICS_MERCHANT = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.metrics.merchant',
  kind: 'query',
  path: 'founderAdmin.metrics.merchant',
  access: { caller: 'founder' },
  refusals: {},
  input: merchantMetricsInputSchema,
  output: merchantMetricsSnapshotSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', window: { kind: 'preset', preset: 'today' } } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CATEGORY_POLICY_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.categoryPolicy.list',
  kind: 'query',
  path: 'founderAdmin.categoryPolicy.list',
  access: { caller: 'founder' },
  refusals: {},
  input: categoryPolicyListInputSchema,
  output: categoryPolicyViewSchema,
  outputChecks: { reserve_percent_holds: { at: 'output.categories[].reserve.percent', says: 'above 0' } },
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CATEGORY_POLICY_HISTORY = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.categoryPolicy.history',
  kind: 'query',
  path: 'founderAdmin.categoryPolicy.history',
  access: { caller: 'founder' },
  refusals: {},
  input: categoryPolicyHistoryInputSchema,
  output: z.array(categoryPolicyEventSchema),
  outputChecks: { reserve_percent_holds: { at: ['output[].before.reserve.percent', 'output[].after.reserve.percent'], says: 'above 0' } },
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_METRICS_GLOBAL = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.metrics.global',
  kind: 'query',
  path: 'founderAdmin.metrics.global',
  access: { caller: 'founder' },
  refusals: {},
  input: founderGlobalMetricsInputSchema,
  output: founderGlobalMetricsSchema,
  samples: [
    { verdict: 'accept', input: { window: { kind: 'preset', preset: 'today' } } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_MERCHANTS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.merchants.list',
  kind: 'query',
  path: 'founderAdmin.merchants.list',
  access: { caller: 'founder' },
  refusals: {},
  input: founderMerchantListInputSchema,
  output: founderMerchantListSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_METRICS_MERCHANT_SERIES = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.metrics.merchantSeries',
  kind: 'query',
  path: 'founderAdmin.metrics.merchantSeries',
  access: { caller: 'founder' },
  refusals: {},
  input: merchantMetricsSeriesInputSchema,
  output: merchantMetricsSeriesSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        merchantId: '11111111-1111-4111-8111-111111111111',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
        bucket: 'day',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_MERCHANTS_DRILLDOWN = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.merchants.drilldown',
  kind: 'query',
  path: 'founderAdmin.merchants.drilldown',
  access: { caller: 'founder' },
  refusals: {},
  input: founderMerchantDrilldownInputSchema,
  output: founderMerchantDrilldownSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', window: { kind: 'preset', preset: 'today' } } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_REGISTRIES_HISTORY = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.registries.history',
  kind: 'query',
  path: 'founderAdmin.registries.history',
  access: { caller: 'founder' },
  refusals: {},
  input: registryHistoryInputSchema,
  output: z.array(registryEventViewSchema),
  samples: [
    { verdict: 'accept', input: { registry: 'venue', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_TREASURY_EXPOSURE = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.treasury.exposure',
  kind: 'query',
  path: 'founderAdmin.treasury.exposure',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({}).strict(),
  output: founderTreasuryExposureSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_GET = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.control.merchant.get',
  kind: 'query',
  path: 'founderAdmin.control.merchant.get',
  access: { caller: 'founder' },
  refusals: {},
  input: merchantControlGetInputSchema,
  output: merchantControlProfileSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CONTROL_MERCHANT_USAGE = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.control.merchant.usage',
  kind: 'query',
  path: 'founderAdmin.control.merchant.usage',
  access: { caller: 'founder' },
  refusals: {},
  input: merchantControlGetInputSchema,
  output: payControlUsageSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CONTROL_PRICING_RULES = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.control.pricing.rules',
  kind: 'query',
  path: 'founderAdmin.control.pricing.rules',
  access: { caller: 'founder' },
  refusals: {},
  input: pricingRuleListInputSchema,
  output: z.array(pricingRuleViewSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CUSTODY_TASKS_CANCEL = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.custody.tasks.cancel',
  kind: 'mutation',
  path: 'founderAdmin.custody.tasks.cancel',
  access: { caller: 'founder' },
  refusals: {},
  input: taskIdInputSchema,
  output: taskViewSchema,
  samples: [
    { verdict: 'accept', input: { taskId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The answer of `founderAdmin.ops.notes.add` and `.retract`, and each item of `.list`: one `OperatorNoteView`. */
export const operatorNoteSchema = z
  .object({
    noteId: z.string().min(1),
    merchantId: z.string().min(1),
    body: z.string(),
    tags: z.array(z.string()),
    flagged: z.boolean(),
    authorId: z.string().min(1),
    createdAt: z.string().min(1),
    retractedAt: z.string().min(1).nullable(),
    retractedBy: z.string().min(1).nullable(),
    retractReason: z.string().min(1).nullable(),
  })
  .strict();

/**
 * CURSOR PAGINATION for every merchant-operations list.
 *
 * Newest first, keyed on (timestamp, id) so equal timestamps never skip or
 * repeat a row. The cursor is opaque to the client. The timestamp travels as a
 * MICROSECOND string straight from Postgres: a JS `Date` has milliseconds and
 * would drop digits, and a page boundary that drops digits loses rows.
 *
 * WHEN BINDING THAT STRING, WRITE `(${ts}::text)::timestamptz`, NEVER
 * `${ts}::timestamptz`. postgres.js serialises a parameter typed timestamptz
 * through `new Date(...)`, which cuts it to milliseconds and silently skips the
 * rows between the cut and the real boundary (found by a flaky page walk).
 *
 * `limit` is accepted as optional in the input schema so that leaving it out
 * reaches a named refusal instead of a Zod "Required", and is never defaulted
 * (same rule as every svc-pay list: blank is not 50).
 */
export const limitInput = z.number().int().min(1).max(200).optional();

export const cursorInput = z.string().min(1).max(512).optional();

export const PAY_FOUNDER_ADMIN_OPS_NOTES_ADD = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.ops.notes.add',
  kind: 'mutation',
  path: 'founderAdmin.ops.notes.add',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({
    merchantId: id,
    body: z.string().trim().min(1).max(4000),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    flagged: z.boolean().default(false),
  }),
  output: operatorNoteSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', body: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_OPS_NOTES_RETRACT = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.ops.notes.retract',
  kind: 'mutation',
  path: 'founderAdmin.ops.notes.retract',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({ noteId: id, reason: z.string().trim().min(3).max(500) }),
  output: operatorNoteSchema,
  samples: [
    { verdict: 'accept', input: { noteId: '11111111-1111-4111-8111-111111111111', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_OPS_NOTES_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.ops.notes.list',
  kind: 'query',
  path: 'founderAdmin.ops.notes.list',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({
    merchantId: id,
    limit: limitInput,
    cursor: cursorInput,
    flaggedOnly: z.boolean().optional(),
    includeRetracted: z.boolean().optional(),
  }),
  output: payPageSchema(operatorNoteSchema),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_DEPOSIT_TRAVEL_RULE_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.depositTravelRule.list',
  kind: 'query',
  path: 'founderAdmin.depositTravelRule.list',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({ userId: userIdSchema, limit: z.number().int().min(1).max(200).default(50) }).strict(),
  output: z.array(heldDepositViewSchema),
  samples: [
    { verdict: 'accept', input: { userId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CHANGES_SUBMIT = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.changes.submit',
  kind: 'mutation',
  path: 'founderAdmin.changes.submit',
  access: { caller: 'founder' },
  refusals: {},
  input: founderChangeSubmitInputSchema,
  output: founderChangeSubmitResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        merchantId: '11111111-1111-4111-8111-111111111111',
        change: { kind: 'set_tier', tierId: 'sample', archetypeId: 'sample' },
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CHANGES_CONFIRM = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.changes.confirm',
  kind: 'mutation',
  path: 'founderAdmin.changes.confirm',
  access: { caller: 'founder' },
  refusals: {},
  input: founderChangeConfirmInputSchema,
  output: founderChangeSubmitResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        decision: 'confirm',
        reason: 'second founder checked it',
        expectedChangeHash: `sha256:${'a'.repeat(64)}`,
      },
    },
    {
      verdict: 'refuse',
      input: { requestId: '11111111-1111-4111-8111-111111111111', decision: 'confirm', reason: 'no hash given' },
    },
  ],
});

export const PAY_FOUNDER_ADMIN_APPROVALS_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.approvals.list',
  kind: 'query',
  path: 'founderAdmin.approvals.list',
  access: { caller: 'founder' },
  refusals: {},
  input: founderApprovalQueueInputSchema,
  output: founderApprovalQueueSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_FOUNDER_ADMIN_CONTROL_AUDIT_LIST = defineProcedure({
  ...base,
  name: 'pay.founderAdmin.control.audit.list',
  kind: 'query',
  path: 'founderAdmin.control.audit.list',
  access: { caller: 'founder' },
  refusals: {},
  input: founderControlAuditListInputSchema,
  checks: { pay_audit_cursor_holds: { at: 'input.cursor', says: 'cursor exceeds bigint max' } },
  output: founderControlAuditListSchema,
  outputChecks: { pay_audit_cursor_holds: { at: 'output.entries[].seq', says: 'cursor exceeds bigint max' } },
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'pay_audit_cursor_holds', input: { limit: 1, cursor: '' } },
  ],
});
