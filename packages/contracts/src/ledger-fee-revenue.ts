/**
 * LEDGER FEE REVENUE — what the house fee accounts took in over one window (RC-cex-spot-07).
 *
 * A read over the custodial ledger, served to svc-ops so the venue report can
 * set revenue against the operator-entered costs in the same asset. The ledger
 * answers per asset: fees collected (debits to `fees:*` accounts), fees given
 * back (credits to them: corrections and distributions) and the signed
 * difference. An asset with no fee movement in the window is absent, not zero.
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
  assetId: z.string().min(1),
  /** Sum of debits to house fee accounts. Decimal string. */
  collected: z.string().regex(decimal),
  /** Sum of credits from house fee accounts. Decimal string. */
  returned: z.string().regex(decimal),
  /** `collected` minus `returned`. May be negative. */
  net: z.string().regex(signedDecimal),
});
export type LedgerFeeRevenueAsset = z.infer<typeof ledgerFeeRevenueAssetSchema>;

export const ledgerFeeRevenueSchema = z.object({
  from: z.string(),
  to: z.string(),
  assets: z.array(ledgerFeeRevenueAssetSchema),
});
export type LedgerFeeRevenue = z.infer<typeof ledgerFeeRevenueSchema>;
