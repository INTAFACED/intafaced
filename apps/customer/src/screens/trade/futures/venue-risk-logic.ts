import { formatAmount, parseAmount } from '../../../shared/money';
import type { VenueCollateral, VenueMarket } from '../../../features/trade/venue-api';

const ONE = parseAmount('1');

/** A scaled fraction as a percent, exact: `0.025` is `2.5`. */
export function percentOf(rate: string): string {
  return formatAmount(parseAmount(rate) * 100n);
}

/**
 * Buying power from the venue's own figures: the free balance of each asset the venue takes as margin, less its haircut,
 * summed. Unknown when any taken asset the person holds has no published haircut (never a guessed one). Nothing else counts.
 */
export function buyingPower(
  taken: readonly VenueCollateral[],
  freeOf: (asset: string) => string,
): { known: true; value: string } | { known: false; asset: string } {
  let total = 0n;
  for (const c of taken) {
    const free = parseAmount(freeOf(c.asset));
    if (free === 0n) continue;
    if (!c.haircut.known) return { known: false, asset: c.asset };
    total += (free * (ONE - parseAmount(c.haircut.value))) / ONE;
  }
  return { known: true, value: formatAmount(total) };
}

/** The room left under the market's open-interest cap, as the venue reports both figures; null where it reports none. */
export function roomLeft(market: VenueMarket): string | null {
  const oi = market.openInterest?.known ? market.openInterest.value : null;
  if (!oi || oi.capSize === null) return null;
  const room = parseAmount(oi.capSize) - parseAmount(oi.size);
  return formatAmount(room > 0n ? room : 0n);
}

/** The assets the venue takes as margin on the market, or null where it publishes no list. */
export function takenAssets(market: VenueMarket): string[] | null {
  return market.collateral?.known ? market.collateral.value.map((c) => c.asset) : null;
}
