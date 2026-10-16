import { z } from 'zod';
import { payAmountStringSchema, payAssetCodeSchema, payMerchantIdSchema, payTimestampSchema } from './merchant-control.js';
import { payListCursorSchema, payListSearchSchema, payMerchantFailureSchema, payPageSchema } from './pay-merchant-reads.js';

/**
 * Merchant portal reads that main did not expose: destination inventory,
 * refund list and detail, a ledger statement, and a payout lifecycle.
 *
 * Money is a decimal string. A field that was never stored is null or a
 * fixed literal (`not_recorded`, `unset`, `not_booked`). Nothing here fills
 * a fee, a cap, a screening verdict, or a default destination.
 */

const pageLimitSchema = z.number().int().min(1).max(200).optional();

export const payDestinationScreeningSchema = z.literal('not_recorded');
export const payDestinationDefaultSchema = z.literal('unset');

export const payPayoutDestinationItemSchema = z
  .object({
    id: z.string().uuid(),
    merchantId: payMerchantIdSchema,
    railId: z.string().min(1).max(64),
    kind: z.string().min(1).max(32),
    destinationMasked: z.string().min(1).max(64),
    screeningState: payDestinationScreeningSchema,
    defaultFlag: payDestinationDefaultSchema,
    createdAt: payTimestampSchema,
    lastUsedAt: payTimestampSchema.nullable(),
  })
  .strict();
export type PayPayoutDestinationItem = z.infer<typeof payPayoutDestinationItemSchema>;

export const payPayoutDestinationListInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    limit: pageLimitSchema,
    cursor: payListCursorSchema.optional(),
  })
  .strict();

export const payRefundStatusSchema = z.enum(['posted', 'settled', 'reversed']);
export const payRefundPotSchema = z.enum(['clearing', 'merchantProceeds', 'userAvailable']);

export const payRefundLedgerEffectSchema = z
  .object({
    /** True only when the refund's ledger transaction was read back. */
    recorded: z.boolean(),
    pot: payRefundPotSchema.nullable(),
    ledgerTxId: z.string().uuid().nullable(),
    /** Ledger direction on the pot. A posted refund credits the pot (value leaves). */
    direction: z.enum(['debit', 'credit']).nullable(),
  })
  .strict();

const paymentStatusSchema = z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']);

export const payRefundItemSchema = z
  .object({
    id: z.string().uuid(),
    refundId: z.string().min(1).max(200),
    paymentId: z.string().uuid(),
    merchantId: payMerchantIdSchema,
    amount: payAmountStringSchema,
    assetId: payAssetCodeSchema,
    /** Not stored on the refund event. Null until a reason is recorded. */
    reason: z.string().min(1).max(200).nullable(),
    /** Not stored on the refund event. Null until an actor id is recorded. */
    actor: z.string().uuid().nullable(),
    status: payRefundStatusSchema,
    createdAt: payTimestampSchema,
    settledAt: payTimestampSchema.nullable(),
    source: z.enum(['clearing', 'settled']).nullable(),
    ledgerEffect: payRefundLedgerEffectSchema,
    payment: z
      .object({
        paymentId: z.string().uuid(),
        status: paymentStatusSchema,
      })
      .strict(),
  })
  .strict();
export type PayRefundItem = z.infer<typeof payRefundItemSchema>;

export const payRefundListInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    status: payRefundStatusSchema.optional(),
    limit: pageLimitSchema,
    cursor: payListCursorSchema.optional(),
    search: payListSearchSchema.optional(),
    assetId: payAssetCodeSchema.optional(),
    from: payTimestampSchema.optional(),
    to: payTimestampSchema.optional(),
    paymentId: z.string().uuid().optional(),
  })
  .strict();

export const payRefundGetInputSchema = z
  .object({
    refundEventId: z.string().uuid(),
  })
  .strict();

export const payStatementKindSchema = z.enum(['payment_captured', 'fee', 'refund', 'chargeback', 'settlement', 'payout', 'reserve']);

export const payStatementAccountSchema = z.enum(['clearing', 'proceeds', 'userAvailable', 'houseFees', 'payoutHold']);

export const payStatementLineSchema = z
  .object({
    id: z.string().uuid(),
    merchantId: payMerchantIdSchema,
    at: payTimestampSchema,
    assetId: payAssetCodeSchema,
    kind: payStatementKindSchema,
    amount: payAmountStringSchema,
    account: payStatementAccountSchema,
    direction: z.enum(['debit', 'credit']),
    /** Clearing balance of this asset after this line. Decimal string. */
    runningClearing: payAmountStringSchema,
    /** Proceeds available balance of this asset after this line. Decimal string. */
    runningProceeds: payAmountStringSchema,
    paymentId: z.string().uuid().nullable(),
    settlementId: z.string().uuid().nullable(),
    ledgerTxId: z.string().uuid(),
  })
  .strict();
export type PayStatementLine = z.infer<typeof payStatementLineSchema>;

export const payStatementTieAccountSchema = z
  .object({
    assetId: payAssetCodeSchema,
    clearing: z
      .object({
        statement: payAmountStringSchema,
        ledger: payAmountStringSchema,
        matches: z.boolean(),
      })
      .strict(),
    proceeds: z
      .object({
        statement: payAmountStringSchema,
        ledger: payAmountStringSchema,
        matches: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const payStatementListInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    limit: pageLimitSchema,
    cursor: payListCursorSchema.optional(),
    assetId: payAssetCodeSchema.optional(),
    from: payTimestampSchema.optional(),
    to: payTimestampSchema.optional(),
  })
  .strict();

export const payStatementPageSchema = payPageSchema(payStatementLineSchema).extend({
  tieOut: z
    .object({
      /**
       * No ledger recipe books a merchant rolling reserve. The statement does
       * not invent reserve lines. `not_booked` is that fact, not a zero balance.
       */
      reserve: z.literal('not_booked'),
      accounts: z.array(payStatementTieAccountSchema),
    })
    .strict(),
});

export const payLifecycleKindSchema = z.enum([
  'settlement.opened',
  'settlement.posted',
  'settlement.released',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.voided',
  'approval.expired',
  'approval.consumed',
  'payout.admitted',
  'rail.sent',
  'rail.confirmed',
  'rail.refused',
  'payout.reversed',
]);

export const payLifecycleStatusSchema = z.enum(['pending', 'posted', 'paid_out', 'failed']);

export const payLifecycleEventSchema = z
  .object({
    id: z.string().uuid(),
    at: payTimestampSchema,
    kind: payLifecycleKindSchema,
    approvalId: z.string().uuid().nullable(),
    railId: z.string().min(1).max(64).nullable(),
    destinationKind: z.string().min(1).max(32).nullable(),
    destinationMasked: z.string().min(1).max(64).nullable(),
    failure: payMerchantFailureSchema.nullable(),
  })
  .strict();

export const payPayoutLifecycleSchema = z
  .object({
    settlementId: z.string().uuid(),
    /** Derived from `events` in time order. Not copied from the settlement status column. */
    status: payLifecycleStatusSchema,
    screening: payDestinationScreeningSchema,
    fee: payAmountStringSchema.nullable(),
    destination: z
      .object({
        railId: z.string().min(1).max(64),
        kind: z.string().min(1).max(32),
        destinationMasked: z.string().min(1).max(64),
      })
      .strict()
      .nullable(),
    failure: payMerchantFailureSchema.nullable(),
    events: z.array(payLifecycleEventSchema),
  })
  .strict();
export type PayPayoutLifecycle = z.infer<typeof payPayoutLifecycleSchema>;

export const payPayoutLifecycleInputSchema = z
  .object({
    settlementId: z.string().uuid(),
  })
  .strict();
