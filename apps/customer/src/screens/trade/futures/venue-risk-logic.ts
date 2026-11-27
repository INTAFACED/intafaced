import { formatAmount, parseAmount } from '../../../shared/money';
import type { VenueCollateral, VenueMarket, VenuePosition, VenuePriceBand } from '../../../features/trade/venue-api';

const ONE = parseAmount('1');

/** A scaled fraction as a percent, exact: `0.025` is `2.5`. */
export function percentOf(rate: string): string {
  return formatAmount(parseAmount(rate) * 100n);
}

/** Basis points as a percent, exact: `500` is `5`, `1250` is `12.5`. */
export function bpsToPercent(bps: string): string {
  return formatAmount(parseAmount(bps) / 100n);
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

/**
 * Check a limit price against the venue's published price band (J-derivatives-02 #5 #8). When outside, returns the
 * nearer edge rounded onto `tickSize` inside the band (low rounded up, high rounded down) so the adjusted order is
 * always accepted by the venue.
 */
export function clampToBand(
  price: string,
  band: Pick<VenuePriceBand, 'bandLow' | 'bandHigh'>,
  tickSize: string,
): { outside: false; adjusted: string } | { outside: true; side: 'low' | 'high'; adjusted: string } {
  const p = parseAmount(price);
  const low = parseAmount(band.bandLow);
  const high = parseAmount(band.bandHigh);
  const tick = parseAmount(tickSize);
  if (p < low) {
    const edge = tick > 0n ? ((low + tick - 1n) / tick) * tick : low;
    return { outside: true, side: 'low', adjusted: formatAmount(edge) };
  }
  if (p > high) {
    const edge = tick > 0n ? (high / tick) * tick : high;
    return { outside: true, side: 'high', adjusted: formatAmount(edge) };
  }
  return { outside: false, adjusted: formatAmount(p) };
}

export type SplitPlan =
  { splitable: true; parts: string[]; capLabel: string } | { splitable: false; reason: 'lot_above_cap'; capLabel: string };

/**
 * When an order exceeds the venue's published `maxOrderQty` or `maxOrderNotional` (J-derivatives-02 #5), split `size`
 * into the fewest lot-aligned child orders that each stay within both caps and sum exactly to `size`. Returns `null`
 * when the order fits in one order or the venue publishes neither cap.
 */
export function planSplitOrders(
  size: string,
  price: string,
  market: Pick<VenueMarket, 'baseAsset' | 'quoteAsset' | 'lotSize' | 'maxOrderQty' | 'maxOrderNotional'>,
): SplitPlan | null {
  const qty = parseAmount(size);
  const px = parseAmount(price);
  const lot = parseAmount(market.lotSize);
  if (qty <= 0n || px <= 0n || lot <= 0n) return null;
  const maxQty = market.maxOrderQty ? parseAmount(market.maxOrderQty) : null;
  const maxNotional = market.maxOrderNotional ? parseAmount(market.maxOrderNotional) : null;
  if (maxQty === null && maxNotional === null) return null;

  const notional = (qty * px + ONE - 1n) / ONE;
  const overQty = maxQty !== null && qty > maxQty;
  const overNotional = maxNotional !== null && notional > maxNotional;
  if (!overQty && !overNotional) return null;

  const byQty = maxQty !== null ? (maxQty / lot) * lot : null;
  // Largest lot-aligned base amount whose ceiling notional <= maxNotional.
  let byNotional: bigint | null = null;
  if (maxNotional !== null) {
    let raw = ((maxNotional * ONE) / px / lot) * lot;
    while (raw > 0n && (raw * px + ONE - 1n) / ONE > maxNotional) raw -= lot;
    byNotional = raw;
  }
  const perOrder = byQty !== null && byNotional !== null ? (byQty < byNotional ? byQty : byNotional) : (byQty ?? byNotional ?? 0n);
  const capLabel =
    overNotional && market.maxOrderNotional
      ? `${market.maxOrderNotional} ${market.quoteAsset}`
      : `${market.maxOrderQty} ${market.baseAsset}`;

  if (perOrder <= 0n) return { splitable: false, reason: 'lot_above_cap', capLabel };

  const count = Number((qty + perOrder - 1n) / perOrder);
  const totalLots = qty / lot;
  const baseLots = totalLots / BigInt(count);
  const remainderLots = totalLots % BigInt(count);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const partLots = baseLots + (BigInt(i) < remainderLots ? 1n : 0n);
    parts.push(formatAmount(partLots * lot));
  }
  return { splitable: true, parts, capLabel };
}

export interface ProjectedVenueTier {
  current: number | null;
  projected: number;
  maxLeverageBps: number;
  maintenanceRate: string;
  confirmRequired: boolean;
}

/**
 * The venue margin tier an order (or split batch) places the position in, from the venue's published `marginTiers` and
 * current open positions (J-derivatives-02 #6). Returns `null` when the venue publishes no tiers.
 */
export function projectedVenueTier(
  market: Pick<VenueMarket, 'symbol' | 'marginTiers'>,
  positions: readonly VenuePosition[],
  side: 'buy' | 'sell',
  addSize: string,
  price: string,
  reduceOnly: boolean,
): ProjectedVenueTier | null {
  const tiers = market.marginTiers?.known ? market.marginTiers.value : null;
  if (!tiers || tiers.length === 0) return null;
  const tierIndex = (notional: bigint): number => {
    let idx = 0;
    for (let i = 0; i < tiers.length; i += 1) {
      if (notional >= parseAmount(tiers[i]!.fromNotional)) idx = i;
    }
    return idx + 1;
  };
  const orderSide = side === 'buy' ? 'long' : 'short';
  const held = positions.find((p) => p.symbol === market.symbol && parseAmount(p.size) > 0n);
  const same = held && held.side === orderSide ? held : null;
  const current = same ? tierIndex((parseAmount(same.size) * parseAmount(same.entryPrice) + ONE - 1n) / ONE) : null;
  if (reduceOnly) {
    const t = tiers[(current ?? 1) - 1]!;
    return {
      current,
      projected: current ?? 1,
      maxLeverageBps: t.maxLeverageBps,
      maintenanceRate: t.maintenanceRate,
      confirmRequired: false,
    };
  }
  const totalSize = (same ? parseAmount(same.size) : 0n) + parseAmount(addSize);
  const notional = (totalSize * parseAmount(price) + ONE - 1n) / ONE;
  const projected = tierIndex(notional);
  const t = tiers[projected - 1]!;
  return {
    current,
    projected,
    maxLeverageBps: t.maxLeverageBps,
    maintenanceRate: t.maintenanceRate,
    confirmRequired: projected > (current ?? 1),
  };
}
