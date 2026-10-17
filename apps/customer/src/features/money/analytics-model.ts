import { formatAmount, parseAmount } from '../../shared/money';

/**
 * The bank puts deposit arrivals into the `deposits` bucket of `outflowByCategory` (together with any value that left
 * under a deposit reason), but never into `totalOutflow`. Showing that bucket as spending would list money coming in as
 * money going out. This splits it back apart using only the returned figures:
 *
 *   value that left under a deposit reason = totalOutflow - (every other category)
 *   money in from deposits                 = deposits bucket - that
 *
 * If those figures do not reconcile (a part is negative or unreadable), nothing is guessed: the bucket is shown on its
 * own, as reported, and `exact` is false so the screen says so.
 */
export type AnalyticsSplit = {
  /** Categories that sum to the outflow total, in the order the bank returned them. Deposits appear only for value that left. */
  outflow: Array<{ category: string; amount: string }>;
  /** Deposit arrivals: money in, not spending. Null when the bank returned no deposits figure. */
  moneyInDeposits: string | null;
  /** False when the split could not be worked out exactly from the returned figures. */
  exact: boolean;
};

export function splitAnalytics(summary: { outflowByCategory: Readonly<Record<string, string>>; totalOutflow: string }): AnalyticsSplit {
  const entries = Object.entries(summary.outflowByCategory);
  const others = entries.filter(([category]) => category !== 'deposits');
  const bucket = summary.outflowByCategory.deposits ?? null;
  const asOutflow = (rows: typeof others) => rows.map(([category, amount]) => ({ category, amount }));
  if (bucket === null) return { outflow: asOutflow(others), moneyInDeposits: null, exact: true };
  try {
    const total = parseAmount(summary.totalOutflow);
    const sumOthers = others.reduce((sum, [, amount]) => sum + parseAmount(amount), 0n);
    const depositOutflow = total - sumOthers;
    const moneyIn = parseAmount(bucket) - depositOutflow;
    if (depositOutflow < 0n || moneyIn < 0n) throw new Error('does not reconcile');
    return {
      outflow: [...asOutflow(others), ...(depositOutflow > 0n ? [{ category: 'deposits', amount: formatAmount(depositOutflow) }] : [])],
      moneyInDeposits: formatAmount(moneyIn),
      exact: true,
    };
  } catch {
    return { outflow: asOutflow(others), moneyInDeposits: bucket, exact: false };
  }
}
