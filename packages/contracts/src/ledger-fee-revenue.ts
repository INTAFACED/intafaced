/**
 * LEDGER FEE REVENUE — what the house fee accounts took in over one window (RC-cex-spot-07).
 *
 * A read over the ledger, served to svc-ops so the venue report can set revenue
 * against the operator-entered costs in the same asset. The ledger answers per
 * venue and asset (project-state OWNER.md item 288; b2 change 3): fees earned
 * (debits to `fees:*` accounts), fees given back (credits out of them:
 * corrections and distributions), the signed difference, and fees collected.
 * Earned is not cash: a builder fee the venue charged is owed to us until the
 * venue pays our builder address. "Collected" counts only Collect entries
 * (`builderFeeReceive`: the venue's own claim record, paid to our builder
 * account at that venue), so a reader never counts as cash what the venue has
 * not paid. A row with no venue is a fee of our own (our own book, payments):
 * no venue pays it, so it has no collected figure. A row with no movement in
 * the window is absent, not zero.
 *
 * Browser-safe: zod only.
 */

import { z } from 'zod';

export const LEDGER_FEE_REVENUE_WINDOW_INVALID = 'ledger.fee_revenue_window_invalid' as const;

const decimal = /^\d+(\.\d{1,18})?$/;
const signedDecimal = /^-?\d+(\.\d{1,18})?$/;

/** Half-open window: `from` inclusive, `to` exclusive, the same boundary as the history read. */
export const ledgerFeeRevenueInputSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});
export type LedgerFeeRevenueInput = z.infer<typeof ledgerFeeRevenueInputSchema>;

export const ledgerFeeRevenueAssetSchema = z.object({
  /** The venue that charged the fee for us (our builder fee), or null for a fee of our own that no venue pays. */
  venueId: z.string().min(1).nullable(),
  assetId: z.string().min(1),
  /** Sum of debits to house fee accounts: fees earned, not yet cash. Decimal string. */
  earned: z.string().regex(decimal),
  /** Sum of credits from house fee accounts. Decimal string. */
  returned: z.string().regex(decimal),
  /** `earned` minus `returned`. May be negative. */
  net: z.string().regex(signedDecimal),
  /**
   * Sum of Collect entries in the window: what the venue paid to our builder account there, by its own claim record.
   * Decimal string; "0" for a venue that paid nothing. Null for a fee of our own (`venueId` null), which nothing collects.
   */
  collected: z.string().regex(decimal).nullable(),
});
export type LedgerFeeRevenueAsset = z.infer<typeof ledgerFeeRevenueAssetSchema>;

export const ledgerFeeRevenueSchema = z.object({
  from: z.string(),
  to: z.string(),
  assets: z.array(ledgerFeeRevenueAssetSchema),
});
export type LedgerFeeRevenue = z.infer<typeof ledgerFeeRevenueSchema>;
