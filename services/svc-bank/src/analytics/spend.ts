import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { accountForSpace, type SpaceService } from '../spaces/space-service.js';
import type { HistoryRange, LedgerHistory } from './ledger-history.js';

/**
 * SPEND ANALYTICS (§8.1) — computed from the ledger, every time.
 *
 * There is no `monthly_spend` table in this service and there will not be one.
 * Every figure below is a fold over ledger entries in a window; ask twice and
 * you get the same answer because the input has not changed, not because a
 * counter was maintained correctly.
 *
 * That property is worth more than the query cost: a running total is wrong
 * silently, and a user disputing their own spending figure has no way to check
 * a number that exists only in our database. This one they can check, movement
 * by movement, against the book.
 */

export const SPEND_CATEGORIES = ['transfers', 'trading', 'p2p', 'fees', 'withdrawals', 'earn', 'deposits', 'rewards', 'other'] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/**
 * Reason code → category.
 *
 * Reason codes are the ledger's own vocabulary (§4.2: 'trade.fill',
 * 'pay.settlement', 'p2p.escrow.lock', …), which is exactly why the mapping
 * lives here and not in the book: categories are a product opinion that will
 * change, and the ledger's reasons are a permanent record that must not.
 *
 * An unrecognised reason lands in `other` rather than being dropped. A
 * breakdown whose parts do not sum to the total is a breakdown nobody can
 * trust, and `spendSummary` asserts that they do.
 */
export function categorise(reason: string): SpendCategory {
  if (reason.startsWith('bank.transfer')) return 'transfers';
  if (reason.startsWith('bank.earn') || reason.startsWith('token.stake') || reason.startsWith('token.unstake')) return 'earn';
  if (reason.startsWith('trade.') || reason.startsWith('order.')) return 'trading';
  if (reason.startsWith('p2p.')) return 'p2p';
  if (reason.startsWith('fee.') || reason.endsWith('.fee')) return 'fees';
  if (reason.startsWith('withdraw.')) return 'withdrawals';
  if (reason.startsWith('deposit')) return 'deposits';
  if (reason.startsWith('reward') || reason.startsWith('token.yield')) return 'rewards';
  return 'other';
}

export interface SpendSummary {
  readonly userId: string;
  readonly assetId: string;
  readonly from: string;
  readonly to: string;
  /**
   * Value that left the account, by category. Decimal strings.
   * `deposits` also includes value that arrived under a deposit reason.
   * That arrival is not spending, so it is not part of `totalOutflow`.
   */
  readonly outflowByCategory: Readonly<Record<SpendCategory, string>>;
  readonly totalOutflow: string;
  readonly totalInflow: string;
  /** Inflow minus outflow. Signed decimal string. */
  readonly net: string;
  readonly movements: number;
}

export class SpendAnalytics {
  constructor(
    private readonly spaces: SpaceService,
    private readonly history: LedgerHistory,
  ) {}

  /**
   * A user's spending across every space they hold in one asset.
   *
   * Every space is queried separately because each is its own ledger account —
   * the primary space is the user's `available` account and each named space is
   * a sub-account. Transfers BETWEEN a user's own spaces therefore appear as an
   * outflow from one and an inflow to another and net to zero across the set,
   * which is the honest answer: moving your own money is not spending it.
   */
  async spendSummary(input: { userId: string; assetId: string; range: HistoryRange }): Promise<SpendSummary> {
    const spaces = await this.spaces.namedSpaces(input.userId, input.assetId);

    const outflow = new Map<SpendCategory, Amount>();
    let depositInflow: Amount = 0n;
    let totalOutflow = 0n;
    let totalInflow = 0n;
    let movements = 0;

    for (const space of spaces) {
      const entries = await this.history.entriesFor(accountForSpace(space), input.range);
      for (const entry of entries) {
        movements++;
        if (entry.direction === 'credit') {
          // Credit reduces the account — value leaving (§4.2 signed delta).
          totalOutflow += entry.amount;
          const category = categorise(entry.reason);
          outflow.set(category, (outflow.get(category) ?? 0n) + entry.amount);
        } else {
          totalInflow += entry.amount;
          // A deposit arrives as a debit. It is not spending, and it is not a reward.
          if (categorise(entry.reason) === 'deposits') depositInflow += entry.amount;
        }
      }
    }

    const outflowByCategory = Object.fromEntries(
      SPEND_CATEGORIES.map((c) => {
        const left = outflow.get(c) ?? 0n;
        const amount = c === 'deposits' ? left + depositInflow : left;
        return [c, formatAmount(amount)];
      }),
    ) as Record<SpendCategory, string>;

    // The parts that left must equal totalOutflow. Deposit arrivals are reported
    // in the deposits bucket and are not part of this sum.
    const summed = [...outflow.values()].reduce((a, b) => a + b, 0n);
    if (summed !== totalOutflow) {
      throw new Error(`Spend breakdown does not reconcile: parts ${formatAmount(summed)} vs total ${formatAmount(totalOutflow)}`);
    }

    return {
      userId: input.userId,
      assetId: input.assetId,
      from: input.range.from.toISOString(),
      to: input.range.to.toISOString(),
      outflowByCategory,
      totalOutflow: formatAmount(totalOutflow),
      totalInflow: formatAmount(totalInflow),
      net: formatAmount(totalInflow - totalOutflow),
      movements,
    };
  }
}
