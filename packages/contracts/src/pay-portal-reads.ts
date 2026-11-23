import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { payAmountStringSchema, payAssetCodeSchema, payMerchantIdSchema, payTimestampSchema } from './merchant-control.js';
import { payListCursorSchema, payListSearchSchema, payMerchantFailureSchema, payPageSchema } from './pay-merchant-reads.js';

/**
 * Merchant portal reads that main did not expose: destination inventory,
 * refund list and detail, a ledger statement, and a payout lifecycle.
 *
 * Money is a decimal string. A field that was never stored is null or a
 * fixed literal (`not_recorded`, `unset`, `not_booked`). Nothing here fills
 * a fee, a cap, or a screening verdict. `default` is set only when the owner
 * marked that destination.
 */

const pageLimitSchema = z.number().int().min(1).max(200).optional();

/**
 * Current hosted-checkout profile (`merchant.profile` / `payment_profiles`).
 * No row is `not_configured`. A row is the JSON and domains that write stored,
 * including an empty object or an empty domain list. This read does not fill
 * a fee, a domain, or a brand. `feeRouting` is null when hidden for this role.
 */
const checkoutSettingsRecordSchema = z.record(z.string(), z.unknown());

export const payCheckoutSettingsGetInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
  })
  .strict();

export const payCheckoutSettingsSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_configured') }).strict(),
  z
    .object({
      status: z.literal('configured'),
      profileId: z.string().guid(),
      checkoutConfig: checkoutSettingsRecordSchema,
      /** Null = hidden for this role (never {}). An empty object is stored data. */
      feeRouting: checkoutSettingsRecordSchema.nullable(),
      domains: z.array(z.string()),
      createdAt: payTimestampSchema,
    })
    .strict(),
]);
export type PayCheckoutSettings = z.infer<typeof payCheckoutSettingsSchema>;

export const payDestinationScreeningSchema = z.literal('not_recorded');
/** `unset` until an owner marks one row. `default` is that mark, never an inferred one. */
export const payDestinationDefaultSchema = z.enum(['unset', 'default']);

/** Saved but not verified; verified and waiting out the hold; payable. */
export const payDestinationStateSchema = z.enum(['unverified', 'held', 'active']);
export type PayDestinationState = z.infer<typeof payDestinationStateSchema>;

export const payPayoutDestinationItemSchema = z
  .object({
    id: z.string().guid(),
    merchantId: payMerchantIdSchema,
    railId: z.string().min(1).max(64),
    kind: z.string().min(1).max(32),
    destinationMasked: z.string().min(1).max(64),
    screeningState: payDestinationScreeningSchema,
    defaultFlag: payDestinationDefaultSchema,
    createdAt: payTimestampSchema,
    lastUsedAt: payTimestampSchema.nullable(),
    /** J-merchant-02 #5: `unverified` (saved, cannot receive a payout), `held` until `activatesAt`, then `active`. */
    state: payDestinationStateSchema,
    /** When a held destination becomes active. Null unless `state` is `held`. */
    activatesAt: payTimestampSchema.nullable(),
  })
  .strict();
export type PayPayoutDestinationItem = z.infer<typeof payPayoutDestinationItemSchema>;

/** `merchant.payoutDestinations.cancelHold`: the owner sends a held destination back to unverified (J-merchant-02 #5). */
export const payDestinationCancelHoldInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    destinationId: z.string().guid(),
  })
  .strict();
/** `changed` is false when the destination was already unverified (a repeat cancel). */
export const payDestinationCancelHoldOutputSchema = z
  .object({
    destinationId: z.string().guid(),
    state: z.literal('unverified'),
    changed: z.boolean(),
  })
  .strict();

/** `merchant.payoutDestinations.add`: the destination as saved, unverified; nothing is paid to it until it is verified. */
export const payDestinationAddOutputSchema = z.object({
  kind: z.string(),
  ref: z.string(),
  railId: z.string(),
  status: z.literal('unverified'),
  activatesAt: z.null(),
});

/** `merchant.payoutDestinations.remove`. */
export const payDestinationRemoveOutputSchema = z.object({ removed: z.literal(true) });

/** One settlement as `merchantOps.payouts.list` shows it: the reference is masked when it is an address. */
export const payPayoutListItemSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  window: z.string(),
  assetId: payAssetCodeSchema,
  gross: payAmountStringSchema,
  fees: payAmountStringSchema,
  net: payAmountStringSchema,
  status: z.enum(['pending', 'posted', 'paid_out', 'failed']),
  payoutMethod: z.string().nullable(),
  payoutReference: z.string().nullable(),
  createdAt: payTimestampSchema,
});
export type PayPayoutListItem = z.infer<typeof payPayoutListItemSchema>;

/** What a merchant may export (`merchantOps.exports.*`). */
export const PAY_EXPORT_KINDS = ['payments', 'settlements', 'payouts', 'refunds', 'ledger_statement', 'disputes', 'fees'] as const;
export type PayExportKind = (typeof PAY_EXPORT_KINDS)[number];

/** One export job, as `merchantOps.exports.create` answers it. A field not reached yet is null. */
export const payExportJobSchema = z.object({
  jobId: z.string(),
  kind: z.enum(PAY_EXPORT_KINDS),
  filters: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    status: z.string().optional(),
    assetId: assetIdSchema.optional(),
    amountMin: z.string().optional(),
    amountMax: z.string().optional(),
  }),
  columns: z.array(z.string()),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  failureCode: z.string().nullable(),
  fileName: z.string().nullable(),
  sizeBytes: z.string().nullable(),
  rowCount: z.number().int().nullable(),
  sha256: z.string().nullable(),
  requestedBy: z.string(),
  asOf: payTimestampSchema.nullable(),
  generatedAt: payTimestampSchema.nullable(),
  expiresAt: payTimestampSchema.nullable(),
  createdAt: payTimestampSchema,
  completedAt: payTimestampSchema.nullable(),
});
export type PayExportJob = z.infer<typeof payExportJobSchema>;

/** The stored file of a ready export job, as `merchantOps.exports.download` answers it. */
export const payExportDownloadSchema = z.object({
  fileName: z.string(),
  contentType: z.string(),
  content: z.string(),
  sha256: z.string(),
  rowCount: z.number().int(),
});
export type PayExportDownload = z.infer<typeof payExportDownloadSchema>;

/** One row of the merchant's activity feed, as `merchantOps.activity.list` answers it. Details are an allowlist of short labels and amounts. */
export const payActivityItemSchema = z.object({
  id: z.string(),
  occurredAt: payTimestampSchema,
  actorId: z.string(),
  action: z.string(),
  objectType: z.string(),
  objectId: z.string(),
  detail: z.record(z.string(), z.string()),
});
export type PayActivityItem = z.infer<typeof payActivityItemSchema>;

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
    ledgerTxId: z.string().guid().nullable(),
    /** Ledger direction on the pot. A posted refund credits the pot (value leaves). */
    direction: z.enum(['debit', 'credit']).nullable(),
  })
  .strict();

const paymentStatusSchema = z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']);

export const payRefundItemSchema = z
  .object({
    id: z.string().guid(),
    refundId: z.string().min(1).max(200),
    paymentId: z.string().guid(),
    merchantId: payMerchantIdSchema,
    amount: payAmountStringSchema,
    assetId: payAssetCodeSchema,
    /** Not stored on the refund event. Null until a reason is recorded. */
    reason: z.string().min(1).max(200).nullable(),
    /** Not stored on the refund event. Null until an actor id is recorded. */
    actor: z.string().guid().nullable(),
    status: payRefundStatusSchema,
    createdAt: payTimestampSchema,
    settledAt: payTimestampSchema.nullable(),
    source: z.enum(['clearing', 'settled']).nullable(),
    ledgerEffect: payRefundLedgerEffectSchema,
    payment: z
      .object({
        paymentId: z.string().guid(),
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
    paymentId: z.string().guid().optional(),
  })
  .strict();

export const payRefundGetInputSchema = z
  .object({
    refundEventId: z.string().guid(),
  })
  .strict();

export const payStatementKindSchema = z.enum(['payment_captured', 'fee', 'refund', 'chargeback', 'settlement', 'payout', 'reserve']);

export const payStatementAccountSchema = z.enum(['clearing', 'proceeds', 'userAvailable', 'houseFees', 'payoutHold']);

/**
 * A window net may be negative. It is the signed sum of movements, not a
 * balance, so the unsigned amount rule does not apply.
 */
const paySignedAmountStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,18})?$/, 'window nets are signed decimal strings with at most 18 decimal places');

export const payStatementLineSchema = z
  .object({
    id: z.string().guid(),
    merchantId: payMerchantIdSchema,
    at: payTimestampSchema,
    assetId: payAssetCodeSchema,
    kind: payStatementKindSchema,
    amount: payAmountStringSchema,
    account: payStatementAccountSchema,
    direction: z.enum(['debit', 'credit']),
    /**
     * Clearing balance after this line, starting from the opening at `from`.
     * Null when `runningReason` is set.
     */
    runningClearing: payAmountStringSchema.nullable(),
    /**
     * Proceeds balance after this line, starting from the opening at `from`.
     * Null when `runningReason` is set.
     */
    runningProceeds: payAmountStringSchema.nullable(),
    /**
     * Signed net of this line's account inside the window, after this line.
     * A debit is positive. Set when `runningBalances` is `within_range` and
     * the line is ordered. Null when an opening was used, or when
     * `runningReason` is `order_ambiguous`. Not a balance.
     */
    windowNet: paySignedAmountStringSchema.nullable(),
    /**
     * `clear` when this line followed ledger order. `order_ambiguous` when
     * same-timestamp lines from different transactions could not be ordered,
     * or a from-opening reconstruction would have gone negative. The page
     * still returns.
     */
    runningOrder: z.enum(['clear', 'order_ambiguous']),
    /**
     * Why the running balances on this line are absent.
     * `no_opening` when the ledger has no balance at `from`.
     * `order_ambiguous` when order or a from-opening reconstruction failed.
     * Null when the running balances are present.
     */
    runningReason: z.enum(['no_opening', 'order_ambiguous']).nullable(),
    paymentId: z.string().guid().nullable(),
    settlementId: z.string().guid().nullable(),
    ledgerTxId: z.string().guid(),
  })
  .strict();
export type PayStatementLine = z.infer<typeof payStatementLineSchema>;

export const payStatementTieAccountSchema = z
  .object({
    assetId: payAssetCodeSchema,
    clearing: z
      .object({
        statement: payAmountStringSchema.nullable(),
        ledger: payAmountStringSchema,
        /** Null when the opening is unknown or the reconstruction was flagged. */
        matches: z.boolean().nullable(),
      })
      .strict(),
    proceeds: z
      .object({
        statement: payAmountStringSchema.nullable(),
        ledger: payAmountStringSchema,
        /** Null when the opening is unknown or the reconstruction was flagged. */
        matches: z.boolean().nullable(),
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
    /**
     * Both bounds are required by the procedure (`pay.statement_range_required`).
     * They stay optional here so a missing bound is that code, not a schema miss.
     * The span is at most 92 days. One request resolves at most 2000 ledger keys.
     */
    from: payTimestampSchema.optional(),
    to: payTimestampSchema.optional(),
  })
  .strict();

export const payStatementOpeningSchema = z
  .object({
    assetId: payAssetCodeSchema,
    clearing: payAmountStringSchema,
    proceeds: payAmountStringSchema,
  })
  .strict();

export const payStatementPageSchema = payPageSchema(payStatementLineSchema).extend({
  /**
   * `within_range` until the ledger exposes a balance at `from`.
   * `from_opening` when that balance was read and the lines start from it.
   */
  runningBalances: z.enum(['within_range', 'from_opening']),
  /** Null when `runningBalances` is `within_range`. */
  opening: z.array(payStatementOpeningSchema).nullable(),
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
export type PayStatementPage = z.infer<typeof payStatementPageSchema>;

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
    id: z.string().guid(),
    /** Null when `timeKnown` is false. The column recorded the fact and not the time. */
    at: payTimestampSchema.nullable(),
    timeKnown: z.boolean(),
    kind: payLifecycleKindSchema,
    approvalId: z.string().guid().nullable(),
    railId: z.string().min(1).max(64).nullable(),
    destinationKind: z.string().min(1).max(32).nullable(),
    destinationMasked: z.string().min(1).max(64).nullable(),
    failure: payMerchantFailureSchema.nullable(),
  })
  .strict()
  .refine((event) => event.timeKnown === (event.at !== null), {
    message: 'A lifecycle event names a timestamp only when the time is known',
  });

export const payPayoutLifecycleSchema = z
  .object({
    settlementId: z.string().guid(),
    /**
     * Derived from `events` in time order. A synthetic event floors this to
     * the settlement status column when that column has no timestamp.
     */
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
    settlementId: z.string().guid(),
  })
  .strict();
