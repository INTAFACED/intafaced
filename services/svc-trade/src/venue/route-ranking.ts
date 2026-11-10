import { add, compare, mul, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { MaybeKnown, VenueAssetAmount, VenueOrderPreview } from '@intafaced/venue-contracts';

/**
 * WHICH VENUE AN ORDER GOES TO (J-derivatives-28 #2; spec D-venue-02). Pure: no venue is read here.
 *
 * Over the venues the person can sign for that are up and that previewed the order, the rule is, in order:
 *   1. a venue whose book fills the whole order now beats one that fills only part of it;
 *   2. between whole fills, the lowest expected total cost of a buy (fill notional + the venue's fee + our builder fee),
 *      or the highest expected proceeds of a sell (fill notional − both fees); between part fills, the larger fill now,
 *      then the same cost rule on what fills;
 *   3. equal on both, the venue id, so a re-preview of the same books names the same venue.
 * A fee the venue does not publish is left out of the cost and named (`unknownFees`): the preview says the cost is on
 * known fees only, never that the fee is zero. A fee in the base asset is valued at the fill's average price; one in any
 * other asset is left out the same way.
 * One order goes to one venue: an order is never split.
 */

export interface RankedCandidate {
  readonly venueId: string;
  readonly preview: VenueOrderPreview;
}

export interface CandidateCost {
  readonly venueId: string;
  /** The base amount that fills now; zero when nothing crosses. `null` when the venue does not say. */
  readonly fillsNow: Amount | null;
  readonly averagePrice: Amount | null;
  readonly fillsWhole: boolean;
  /** Fill notional at the average price, in the quote asset (zero when nothing fills now). */
  readonly notional: Amount;
  /** Known fees in the quote asset: the venue's plus ours. */
  readonly knownFees: Amount;
  /** A buy: notional + known fees. A sell: notional − known fees. */
  readonly total: Amount;
  /** Which fees are not part of `knownFees`: not published, or not in the quote asset. */
  readonly unknownFees: readonly ('venue_fee' | 'builder_fee')[];
}

export type RouteReasonCode =
  /** The only venue left to choose from. */
  | 'only_venue'
  /** The chosen venue fills the whole order now and every other fills only part. */
  | 'fills_whole'
  /** Every venue fills the whole order (or every one only part): the chosen one costs least (a sell: pays most). */
  | 'lowest_cost'
  /** Every venue fills only part: the chosen one fills the most now. */
  | 'fills_most'
  /** Cost and fill equal: the venue id decides, so the choice is stable. */
  | 'tie_by_id';

export interface RankedRoute {
  readonly chosen: CandidateCost;
  readonly others: readonly CandidateCost[];
  readonly reason: RouteReasonCode;
}

/**
 * A fee in the quote asset: as reported when in the quote, at the fill's average price when in the base (a venue that
 * takes a spot buy's fee from the coin bought), zero when it is a known zero; else `null` (not counted, and named).
 */
function inQuote(fee: MaybeKnown<VenueAssetAmount>, assets: MarketAssets, averagePrice: Amount | null): Amount | null {
  if (!fee.known) return null;
  if (fee.value.amount === ZERO) return ZERO;
  if (fee.value.asset === assets.quote) return fee.value.amount;
  if (fee.value.asset === assets.base && averagePrice !== null) return mul(fee.value.amount, averagePrice, 'ceil');
  return null;
}

export interface MarketAssets {
  readonly base: string;
  readonly quote: string;
}

/** One venue's expected cost of the order from its own preview. */
export function costOf(c: RankedCandidate, side: 'buy' | 'sell', size: Amount, assets: MarketAssets): CandidateCost {
  const p = c.preview;
  const fillsNow = p.fill.known ? p.fill.value.amount : null;
  const averagePrice = p.fill.known ? p.fill.value.averagePrice : null;
  const notional = fillsNow !== null && averagePrice !== null ? mul(fillsNow, averagePrice, side === 'buy' ? 'ceil' : 'floor') : ZERO;
  const unknownFees: ('venue_fee' | 'builder_fee')[] = [];
  let knownFees = ZERO;
  const venueFee = inQuote(p.venueFee, assets, averagePrice);
  if (venueFee === null) unknownFees.push('venue_fee');
  else knownFees = add(knownFees, venueFee);
  const builderFee = inQuote(p.builderFee, assets, averagePrice);
  if (builderFee === null) unknownFees.push('builder_fee');
  else knownFees = add(knownFees, builderFee);
  return {
    venueId: c.venueId,
    fillsNow,
    averagePrice,
    fillsWhole: fillsNow !== null && compare(fillsNow, size) >= 0,
    notional,
    knownFees,
    total: side === 'buy' ? add(notional, knownFees) : sub(notional, knownFees),
    unknownFees,
  };
}

/** Cost per unit filled, compared without dividing: a.total/a.fill vs b.total/b.fill as a.total·b.fill vs b.total·a.fill. */
function perUnit(a: CandidateCost, b: CandidateCost): -1 | 0 | 1 {
  const af = a.fillsNow ?? ZERO;
  const bf = b.fillsNow ?? ZERO;
  return compare(mul(a.total, bf), mul(b.total, af));
}

/** Rank the candidates; `null` when there are none. */
export function rankRoute(
  candidates: readonly RankedCandidate[],
  order: { readonly side: 'buy' | 'sell'; readonly amount: Amount },
  assets: MarketAssets,
): RankedRoute | null {
  if (candidates.length === 0) return null;
  const costs = candidates.map((c) => costOf(c, order.side, order.amount, assets));
  // Lower is better for a buy's cost, higher for a sell's proceeds.
  const better = order.side === 'buy' ? 1 : -1;
  const cmp = (a: CandidateCost, b: CandidateCost): number => {
    if (a.fillsWhole !== b.fillsWhole) return a.fillsWhole ? -1 : 1;
    if (!a.fillsWhole) {
      const fa = a.fillsNow ?? ZERO;
      const fb = b.fillsNow ?? ZERO;
      if (compare(fa, fb) !== 0) return compare(fb, fa);
      if (compare(fa, ZERO) === 0) return a.venueId < b.venueId ? -1 : a.venueId > b.venueId ? 1 : 0;
      const u = perUnit(a, b);
      if (u !== 0) return u * better;
    } else {
      const t = compare(a.total, b.total);
      if (t !== 0) return t * better;
    }
    return a.venueId < b.venueId ? -1 : a.venueId > b.venueId ? 1 : 0;
  };
  const sorted = [...costs].sort(cmp);
  const chosen = sorted[0]!;
  const others = sorted.slice(1);
  let reason: RouteReasonCode;
  if (others.length === 0) reason = 'only_venue';
  else {
    const next = others[0]!;
    if (chosen.fillsWhole && !next.fillsWhole) reason = 'fills_whole';
    else if (!chosen.fillsWhole && compare(chosen.fillsNow ?? ZERO, next.fillsNow ?? ZERO) !== 0) reason = 'fills_most';
    else if (chosen.fillsWhole ? compare(chosen.total, next.total) !== 0 : perUnit(chosen, next) !== 0) reason = 'lowest_cost';
    else reason = 'tie_by_id';
  }
  return { chosen, others, reason };
}
