import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { ledgerFeeRevenueInputSchema, type LedgerFeeRevenue } from '@intafaced/contracts';
import { parseHistoryRange, type HistoryRange } from './history.js';

/**
 * FEE REVENUE: what the house fee accounts took in over one window.
 *
 * A READ, like `history`: it takes no lock, changes no balance and has no path
 * into `post()`. The one caller is svc-ops, which sets this against the costs an
 * operator entered. Only `fees:*` house accounts count, summed per asset.
 *
 * A debit to a fee account is a fee collected and a credit out of it is a fee
 * given back (a correction, or a distribution such as staking yield). Both are
 * shown, with the signed difference, so a reader never sees a netted figure it
 * cannot take apart. An asset with no fee movement in the window is absent from
 * the answer, not a zero row.
 */

export interface FeeRevenueRow {
  readonly assetId: string;
  readonly collected: Amount;
  readonly returned: Amount;
}

export function parseFeeRevenueInput(body: unknown): HistoryRange {
  const input = ledgerFeeRevenueInputSchema.parse(body);
  return parseHistoryRange(input.from, input.to);
}

export function serializeFeeRevenue(range: HistoryRange, rows: readonly FeeRevenueRow[]): LedgerFeeRevenue {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    assets: rows.map((r) => ({
      assetId: r.assetId,
      collected: formatAmount(r.collected),
      returned: formatAmount(r.returned),
      net: formatAmount(r.collected - r.returned),
    })),
  };
}
