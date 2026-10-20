import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { LEDGER_FEE_REVENUE_WINDOW_INVALID, ledgerFeeRevenueInputSchema, type LedgerFeeRevenue } from '@intafaced/contracts';
import { LedgerError } from '@intafaced/ledger-client';
import type { HistoryRange } from './history.js';

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
  const range = { from: new Date(input.from), to: new Date(input.to) };
  // An empty or inverted window is a question that cannot be asked, not a zero.
  if (!(range.from < range.to)) {
    throw new LedgerError(
      'Fee revenue window must start before it ends: `from` is inclusive, `to` is exclusive',
      LEDGER_FEE_REVENUE_WINDOW_INVALID,
    );
  }
  return range;
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
