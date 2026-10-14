/**
 * The one-account strip's numbers, from the same portfolio the Money screen reads (`usePortfolio`).
 * Money stays a decimal string or a scaled bigint: nothing here becomes a JS number.
 */
import { dec, ratio, str, sumOf, times } from '../../../data/decimal';
import type { Decimal, PortfolioSummary } from '../../../data/types';

export interface AvailableUsd {
  /** What can be spent now, valued in USD, counting only holdings that have a price. Null when nothing is known. */
  value: Decimal | null;
  /** True when some holding that has money available could not be priced, so the figure leaves it out. */
  partial: boolean;
}

/**
 * Available in USD = for each priced holding, its USD value times the share of it that is free (not held for open
 * orders). A holding with no price and some free amount makes the figure `partial`; the strip then says how many
 * coins are not counted instead of presenting the sum as complete.
 */
export function availableUsd(portfolio: Pick<PortfolioSummary, 'holdings' | 'totalUsd'>): AvailableUsd {
  const parts: bigint[] = [];
  let partial = false;
  for (const holding of portfolio.holdings) {
    const free = dec(holding.available);
    const total = dec(holding.total);
    if (free === null || total === null || total <= 0n) continue;
    const value = dec(holding.usdValue);
    if (value === null) {
      if (free > 0n) partial = true;
      continue;
    }
    const share = ratio(free, total);
    if (share === null) continue;
    parts.push(times(value, share));
  }
  if (parts.length === 0) return { value: portfolio.totalUsd === null ? null : '0', partial };
  return { value: str(sumOf(parts)), partial };
}
