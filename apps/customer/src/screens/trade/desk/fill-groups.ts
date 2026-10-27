import type { Trade } from '@intafaced/exchange-contract/schemas';
import { div } from '@intafaced/money-math';
import { formatAmount, parseAmount } from '../../../shared/money';

/** The fills of one order, newest first, with what they add up to. A fill that names no order is a group of its own. */
export interface FillGroup {
  readonly order: string | null;
  readonly fills: readonly Trade[];
  /** The base amount of every fill together. */
  readonly amount: string;
  /** The quote total of every fill together. */
  readonly cost: string;
  /** Total over amount, rounded half-up, or null when the amount is zero. */
  readonly average: string | null;
  /**
   * The fees together, over the fills that paid one (a fill with no fee adds nothing), when they were all in one coin;
   * null when none paid a fee or they paid in different coins, never a sum across coins.
   */
  readonly fee: { readonly cost: string; readonly currency: string } | null;
  /** The maker rebates together, the same way: null when none was paid or they were paid in different coins. */
  readonly rebate: { readonly cost: string; readonly currency: string } | null;
}

/** One coin's total of these amounts, or null when there are none or they are in different coins. */
function oneCoinTotal(amounts: readonly { cost: string; currency: string }[]): { cost: string; currency: string } | null {
  const currency = amounts[0]?.currency;
  if (currency === undefined || !amounts.every((one) => one.currency === currency)) return null;
  return { cost: formatAmount(amounts.reduce((sum, one) => sum + parseAmount(one.cost), 0n)), currency };
}

/**
 * Activity's trade history, grouped by order: an order that filled in parts is one group with all its fills. Groups are
 * newest first by their newest fill, fills newest first inside a group. Amounts are added as exact decimals.
 */
export function groupFillsByOrder(rows: readonly Trade[]): FillGroup[] {
  const newest = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  const byOrder = new Map<string, Trade[]>();
  const groups: Trade[][] = [];
  for (const fill of newest) {
    const known = fill.order ? byOrder.get(fill.order) : undefined;
    if (known) {
      known.push(fill);
      continue;
    }
    const group = [fill];
    if (fill.order) byOrder.set(fill.order, group);
    groups.push(group);
  }
  return groups.map((fills) => {
    const amount = fills.reduce((sum, fill) => sum + parseAmount(fill.amount), 0n);
    const cost = fills.reduce((sum, fill) => sum + parseAmount(fill.cost), 0n);
    const fee = oneCoinTotal(fills.flatMap((fill) => (fill.fee ? [fill.fee] : [])));
    const rebate = oneCoinTotal(fills.flatMap((fill) => (fill.rebate ? [fill.rebate] : [])));
    return {
      order: fills[0]!.order,
      fills,
      amount: formatAmount(amount),
      cost: formatAmount(cost),
      average: amount > 0n ? formatAmount(div(cost, amount, 'half-up')) : null,
      fee,
      rebate,
    };
  });
}
