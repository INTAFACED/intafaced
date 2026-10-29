import { z } from 'zod';
import { amount, asset } from '../../schemas';

// Schemas only the money pages read. Each mirrors a service contract and parses tolerantly: unknown keys are
// ignored, and a list may arrive as an array or as a page.
//
// Read from origin/main (0b3d52ad3): merchantOps.payouts.list, settlement.lines, merchantControl.* (limits, tiers,
// pricing history, approval pages), conversion.*, merchantOps.exports.create with all seven kinds.
// Read from feat/pay-portal-be-reads-money: destinations, refunds, statement and payout lifecycle.

const timestamp = z.string().datetime({ offset: true });
const signedAmount = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

// ---- payouts (merchantOps.payouts.list) ----------------------------------------------------------------
export const payoutItemSchema = z.object({
  id: z.string(),
  merchantId: z.string().optional(),
  window: z.string(),
  assetId: asset,
  gross: amount,
  fees: amount,
  net: amount,
  status: z.enum(['pending', 'posted', 'paid_out', 'failed']),
  payoutMethod: z.string().nullable(),
  payoutReference: z.string().nullable(),
  createdAt: timestamp,
});
export type PayoutItem = z.infer<typeof payoutItemSchema>;

// ---- settlement lines (settlement.lines) ---------------------------------------------------------------
export const settlementLineSchema = z.object({
  paymentId: z.string(),
  amount: amount.nullable(),
  assetId: asset,
  createdAt: timestamp,
  includedAmountKnown: z.boolean(),
});
export type SettlementLine = z.infer<typeof settlementLineSchema>;

// mirrors feat/pay-portal-be-reads-money:packages/contracts/src/pay-portal-reads.ts; import from @intafaced/contracts after merge
export const destinationItemSchema = z.object({
  id: z.string(),
  railId: z.string(),
  kind: z.string(),
  destinationMasked: z.string(),
  screeningState: z.string().optional(),
  /** `default` only after the owner marked this row; everything else is `unset`. */
  defaultFlag: z.string().optional(),
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable().optional(),
});
export type DestinationItem = z.infer<typeof destinationItemSchema>;
/** What `merchant.payoutDestinations.remove` answers. */
export const destinationRemovedSchema = z.object({ removed: z.literal(true) });
/** True only for the row the owner marked. A missing flag is "not the default", never a guess. */
export const isDefaultDestination = (d: Pick<DestinationItem, 'defaultFlag'>) => d.defaultFlag === 'default';

// mirrors feat/pay-portal-be-reads-money:packages/contracts/src/pay-portal-reads.ts; import from @intafaced/contracts after merge
export const refundStatuses = ['posted', 'settled', 'reversed'] as const;
export const refundItemSchema = z.object({
  id: z.string(),
  refundId: z.string(),
  paymentId: z.string(),
  amount,
  assetId: asset,
  reason: z.string().nullable().optional(),
  actor: z.string().nullable().optional(),
  status: z.enum(refundStatuses),
  createdAt: timestamp,
  settledAt: timestamp.nullable().optional(),
  source: z.enum(['clearing', 'settled']).nullable().optional(),
  ledgerEffect: z
    .object({
      recorded: z.boolean(),
      pot: z.enum(['clearing', 'merchantProceeds', 'userAvailable']).nullable(),
      ledgerTxId: z.string().nullable().optional(),
      direction: z.enum(['debit', 'credit']).nullable().optional(),
    })
    .optional(),
  payment: z.object({ paymentId: z.string(), status: z.string() }).optional(),
});
export type RefundItem = z.infer<typeof refundItemSchema>;

// mirrors feat/pay-portal-be-reads-money:packages/contracts/src/pay-portal-reads.ts; import from @intafaced/contracts after merge
export const statementLineSchema = z.object({
  id: z.string(),
  at: timestamp,
  assetId: asset,
  kind: z.string(),
  amount,
  account: z.string(),
  direction: z.enum(['debit', 'credit']),
  runningClearing: amount.nullable().optional(),
  runningProceeds: amount.nullable().optional(),
  windowNet: signedAmount.nullable().optional(),
  runningOrder: z.enum(['clear', 'order_ambiguous']),
  runningReason: z.enum(['no_opening', 'order_ambiguous']).nullable().optional(),
  paymentId: z.string().nullable().optional(),
  settlementId: z.string().nullable().optional(),
  ledgerTxId: z.string().optional(),
});
export type StatementLine = z.infer<typeof statementLineSchema>;
const tieSide = z.object({ statement: amount.nullable(), ledger: amount, matches: z.boolean().nullable() });
export const statementPageSchema = z.object({
  items: z.array(statementLineSchema),
  nextCursor: z.string().nullable(),
  runningBalances: z.enum(['within_range', 'from_opening']).optional(),
  opening: z
    .array(z.object({ assetId: asset, clearing: amount, proceeds: amount }))
    .nullable()
    .optional(),
  tieOut: z
    .object({
      reserve: z.string().optional(),
      accounts: z.array(z.object({ assetId: asset, clearing: tieSide, proceeds: tieSide })),
    })
    .optional(),
});
export type StatementPage = z.infer<typeof statementPageSchema>;

// mirrors feat/pay-portal-be-reads-money:packages/contracts/src/pay-portal-reads.ts; import from @intafaced/contracts after merge
export const lifecycleEventSchema = z.object({
  id: z.string(),
  at: timestamp.nullable(),
  timeKnown: z.boolean(),
  // A kind this screen does not know is kept and shown plainly, never dropped.
  kind: z.string(),
  approvalId: z.string().nullable().optional(),
  railId: z.string().nullable().optional(),
  destinationKind: z.string().nullable().optional(),
  destinationMasked: z.string().nullable().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
});
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;
export const lifecycleSchema = z.object({
  settlementId: z.string(),
  status: z.enum(['pending', 'posted', 'paid_out', 'failed']),
  screening: z.string().optional(),
  fee: amount.nullable().optional(),
  destination: z.object({ railId: z.string(), kind: z.string(), destinationMasked: z.string() }).nullable().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
  events: z.array(lifecycleEventSchema),
});
export type Lifecycle = z.infer<typeof lifecycleSchema>;

// ---- limits, tiers and pricing history (merchantControl.*) ---------------------------------------------
const capSchema = z.union([
  z.object({ kind: z.enum(['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout']), assetCode: asset, limit: amount }),
  z.object({ kind: z.literal('beneficiaries_per_day'), limit: z.number().int().min(0) }),
]);
export type Cap = z.infer<typeof capSchema>;
const limitRequest = z.object({
  requestId: z.string(),
  caps: z.union([z.array(capSchema), z.object({ raw: z.unknown(), capsReadable: z.literal(false) })]),
  reason: z.string(),
  status: z.string(),
  requestedBy: z.string().optional(),
  createdAt: timestamp,
});
export type LimitRequest = z.infer<typeof limitRequest>;
export const limitOpenSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('pending'), request: limitRequest }),
]);
export type LimitOpen = z.infer<typeof limitOpenSchema>;
export const limitIncreaseResultSchema = limitRequest.extend({ outcome: z.enum(['stored', 'already_open']) });
export const limitWithdrawResultSchema = z.object({ requestId: z.string(), status: z.string() });
/**
 * The tier ladder (merchantControl.tiers.list, #4919): every tier INTAFACED shows merchants, with its commercial terms.
 * `ownTierId` is null when this merchant is on none of the listed tiers.
 */
export const tierListSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_configured'), ownTierId: z.null() }),
  z.object({
    status: z.literal('configured'),
    ownTierId: z.string().nullable(),
    tiers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        archetype: z.string().optional(),
        caps: z.array(capSchema),
        reserve: z.object({ rollingReserveBps: z.number().nullable(), holdDays: z.number().nullable() }).nullable().optional(),
        version: z.string().optional(),
      }),
    ),
  }),
]);
export type TierList = z.infer<typeof tierListSchema>;
export type TierSummary = Extract<TierList, { status: 'configured' }>['tiers'][number];
const band = z.object({ fromAmount: amount, feeBps: z.number(), flatFee: amount.nullable().optional() });
export const pricingHistorySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_configured'), events: z.array(z.unknown()) }),
  z.object({
    status: z.literal('configured'),
    events: z.array(
      z.object({
        ruleId: z.string(),
        layer: z.enum(['global', 'tier', 'merchant']),
        assetCode: asset,
        bands: z.array(band),
        spreadBps: z.number().nullable().optional(),
        version: z.string().optional(),
        createdAt: timestamp,
        supersededAt: timestamp.nullable().optional(),
      }),
    ),
  }),
]);
export type PricingHistory = z.infer<typeof pricingHistorySchema>;

// ---- conversion (conversion.*, sandbox only) -----------------------------------------------------------
export const conversionStatuses = [
  'quoted',
  'intent_committed',
  'placing',
  'placed',
  'partially_filled',
  'filled',
  'failed',
  'reversed',
  'expired',
] as const;
export const conversionQuoteSchema = z.object({
  quoteId: z.string(),
  settlementId: z.string(),
  fromAsset: asset,
  toAsset: asset,
  fromAmount: amount,
  rate: amount,
  feeAmount: amount,
  spreadAmount: amount,
  minimumOutput: amount,
  expectedOutput: amount,
  expiresAt: timestamp,
});
export type ConversionQuote = z.infer<typeof conversionQuoteSchema>;
export const conversionOrderSchema = z.object({
  conversionId: z.string(),
  settlementId: z.string(),
  status: z.string(),
  fromAsset: asset,
  toAsset: asset,
  fromAmount: amount,
  filledFromAmount: amount,
  filledToAmount: amount,
  failureCode: z.string().nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ConversionOrder = z.infer<typeof conversionOrderSchema>;

// ---- exports (merchantOps.exports.create) --------------------------------------------------------------
export const exportStartedSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  status: z.string(),
  createdAt: timestamp.optional(),
});

/** What `settlement.payout` and `settlement.release` answer. */
export const payoutDoneSchema = z.object({ id: z.string(), status: z.string() });

/** merchantControl.reserve (M-money-out-01): the reserve rule and what is recorded against it. Nothing is withheld. */
export const reserveViewSchema = z.object({
  rule: z.object({ rollingReserveBps: z.number().int().min(0), holdDays: z.number().int().min(0) }).nullable(),
  holding: z.literal('recorded_not_withheld'),
  payoutsRefused: z.boolean(),
  assets: z.array(
    z.object({
      assetCode: asset,
      recordedAmount: amount,
      entries: z.number().int().min(0),
      nextReleaseAt: timestamp.nullable(),
      lastReleaseAt: timestamp.nullable(),
    }),
  ),
  readAt: timestamp,
});
export type ReserveView = z.infer<typeof reserveViewSchema>;
