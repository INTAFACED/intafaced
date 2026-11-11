import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { LEDGER_FEE_REVENUE_WINDOW_INVALID, ledgerFeeRevenueInputSchema, type LedgerFeeRevenue } from '@intafaced/contracts';
import { LedgerError } from '@intafaced/ledger-client';
import type { HistoryRange } from './history.js';

/**
 * FEE REVENUE: what the house fee accounts earned over one window, and what the venues paid us of it.
 *
 * A READ, like `history`: it takes no lock, changes no balance and has no path
 * into `post()`. The one caller is svc-ops, which sets this against the costs an
 * operator entered. Answered per venue and asset (project-state OWNER.md item 288; b2 change 3):
 *
 * - earned: debits to `fees:*` house accounts. A builder fee is earned when the venue charges it on a fill, and is owed
 *   to us (`venue-builder-fee:<venue>`) until the venue pays it, so earned is never cash on its own.
 * - returned: credits out of `fees:*` (a correction, or a distribution such as staking yield), and the signed difference.
 * - collected: Collect entries only (`builderFeeReceive`, reason `trade.builder_fee.received`), what the venue paid to our
 *   builder account there by its own claim record. The word "collected" means nothing else in this read.
 *
 * A fee's venue is the venue its transaction owes it from (its `venue-builder-fee:<venue>` leg). A fee with no such leg
 * is a fee of our own (our own book, payments): its venue is null and it has no collected figure, since no venue pays
 * it. A venue with earned fees and no Collect in the window reads collected "0", the ledger's own answer. A row with no
 * movement in the window is absent, not a zero row.
 */

/** The `ownerId` prefix of what a venue owes us in builder fees (`venueBuilderFeeReceivable`). */
export const VENUE_BUILDER_FEE_PREFIX = 'venue-builder-fee:';
/** The `ownerId` prefix of our builder account at a venue, an own-funds place (`venueBuilderAccount`). */
export const VENUE_BUILDER_ACCOUNT_PREFIX = 'venue-builder-account:';
/** The reason `builderFeeReceive` (Collect) posts under; `fee-revenue-postgres.test.ts` checks it against the recipe. */
export const BUILDER_FEE_COLLECT_REASON = 'trade.builder_fee.received';

export interface FeeRevenueRow {
  readonly venueId: string | null;
  readonly assetId: string;
  readonly earned: Amount;
  readonly returned: Amount;
  /** Null exactly when `venueId` is null. */
  readonly collected: Amount | null;
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
      venueId: r.venueId,
      assetId: r.assetId,
      earned: formatAmount(r.earned),
      returned: formatAmount(r.returned),
      net: formatAmount(r.earned - r.returned),
      collected: r.collected === null ? null : formatAmount(r.collected),
    })),
  };
}
