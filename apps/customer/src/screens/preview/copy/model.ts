import { compare, dec, ratio, str, toFixedString } from '../../../data/decimal';
import type { SampleRiskBand, SampleTrader } from '../../../preview/fixtures/copy';

/**
 * The sorting and the sums behind the Copy trading Preview. Money and ratios are decimal strings or scaled bigints
 * (data/decimal.ts); no money value becomes a JS number.
 */
export type Period = 'd7' | 'd30' | 'd90';
export type SortKey = 'return' | 'drawdown' | 'followers' | 'winRate';

function byDecimal(a: string, b: string): number {
  return compare(dec(a) ?? 0n, dec(b) ?? 0n);
}

export function ranked(
  traders: readonly SampleTrader[],
  options: { period: Period; sort: SortKey; risk: SampleRiskBand | 'all'; checkedOnly: boolean },
): readonly SampleTrader[] {
  const kept = traders.filter(
    (trader) => (options.risk === 'all' || trader.risk === options.risk) && (!options.checkedOnly || trader.check.status === 'verified'),
  );
  const order = (a: SampleTrader, b: SampleTrader): number => {
    switch (options.sort) {
      case 'return':
        return byDecimal(b.returns[options.period], a.returns[options.period]);
      case 'drawdown':
        return byDecimal(a.drawdown, b.drawdown);
      case 'followers':
        return b.followers - a.followers;
      case 'winRate':
        return byDecimal(b.winRate, a.winRate);
    }
  };
  return [...kept].sort((a, b) => order(a, b) || a.name.localeCompare(b.name));
}

export interface FollowPlan {
  /** Max loss as a share of the amount, a ratio string, or null when the amount is empty. */
  readonly lossRatio: string | null;
  readonly belowMin: boolean;
  readonly overBalance: boolean;
  /** A max loss bigger than the amount makes no sense. */
  readonly lossTooBig: boolean;
  readonly empty: boolean;
  readonly total: string | null;
}

export function planFollow(input: { amount: string; maxLoss: string; minCopy: string; balance: string }): FollowPlan {
  const amount = dec(input.amount);
  const loss = dec(input.maxLoss);
  if (amount === null || amount <= 0n)
    return { lossRatio: null, belowMin: false, overBalance: false, lossTooBig: false, empty: true, total: null };
  const r = loss === null ? null : ratio(loss, amount);
  return {
    lossRatio: r === null ? null : str(r),
    belowMin: compare(amount, dec(input.minCopy) ?? 0n) < 0,
    overBalance: compare(amount, dec(input.balance) ?? 0n) > 0,
    lossTooBig: loss !== null && compare(loss, amount) > 0,
    empty: false,
    total: toFixedString(amount, 2),
  };
}
