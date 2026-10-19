import { type Amount, ZERO, add, sub, min, mul, div, mulBps, formatAmount } from '@intafaced/ledger-client';
import { allInEffectivePrice, costRefuseToRouteReason, scoreSorCost, type SorCostTerms } from './cost-model.js';
import { isRoutable, type LiquiditySource, type QuoteRequest, type VenueQuote } from './source.js';

/**
 * SMART ORDER ROUTER (ranks observed quotes). Ranking is not a legal
 * best-execution claim — see `refuseBestExClaim`.
 *
 * Ranks every routable venue on the price a user actually gets, splits the
 * order across venues when one cannot fill it alone, and refuses to route into
 * prices that have drifted too far from the best available.
 *
 * §28:770 cost model (D26-P1-X3): when `costTermsByVenue` is supplied, ranking
 * uses all-in cost (fee + expected impact + transfer) and unscored latency /
 * missing terms refuse with weight zero. Without that map, behaviour is the
 * fee-from-quote path (backward compatible). The only structural house thumb
 * remains `internalPreferenceBps` (default 5).
 */

export interface RouteLeg {
  readonly venueId: string;
  readonly amount: Amount;
  /** The venue's quoted price. */
  readonly price: Amount;
  /**
   * Price including that venue's taker fee — what the user actually pays or
   * receives per unit at the venue. This is the TRUE venue figure, never the
   * internally-preferred ranking figure. What we show is what happens.
   *
   * When the §28 complete cost model scored the leg, `allInEffectivePrice` is
   * the ranking figure (fee + impact + transfer); otherwise it equals this.
   */
  readonly effectivePrice: Amount;
  /** All-in ranking price when cost terms were supplied; else same as effectivePrice. */
  readonly allInEffectivePrice: Amount;
  readonly feeBps: number;
  readonly expectedImpactBps?: number;
  readonly transferCostBps?: number;
  readonly kind: string;
}

export interface RoutePlan {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly requestedAmount: Amount;
  readonly routedAmount: Amount;
  /** Requested minus routed — non-zero when the market could not fill it all. */
  readonly unfilledAmount: Amount;
  readonly legs: readonly RouteLeg[];
  /**
   * Quantity-weighted average effective price across every leg.
   * `null` when nothing routed — 0 would read as filled-at-zero.
   */
  readonly averageEffectivePrice: Amount | null;
  /** Total quote-asset value of the routed portion, fees included. */
  readonly totalCost: Amount;
  /**
   * Improvement in bps versus routing the whole order to the single best
   * venue. This is what splitting bought the user.
   */
  readonly improvementBps: number;
  readonly rejected: readonly RejectedVenue[];
}

export interface RejectedVenue {
  readonly venueId: string;
  readonly reason:
    | 'unhealthy'
    | 'stale'
    | 'no_quote'
    | 'slippage'
    | 'venue_cap'
    | 'filled'
    /** §28 complete model: fee / impact / transfer term missing or invalid. */
    | 'incomplete_cost'
    /** §28 / D-S-18: unscored latency → routing weight zero. */
    | 'zero_weight';
  readonly detail?: string;
}

export interface RouterOptions {
  /**
   * Bounded, explicit advantage given to the internal book AT RANKING TIME only
   * (docs/TERMINAL.md §4).
   *
   * Justified by what an internal fill is worth to both sides: the fee accrues
   * to the house and feeds the buyback (§4.3), settlement is a single atomic
   * ledger post rather than a third-party transfer, and no user value ends up
   * sitting at a venue we do not control.
   *
   * It is a tiebreak, not a cover for bad pricing: at the default 5 bps an
   * internal book that is genuinely worse loses, and the user is shown the real
   * effective price either way.
   *
   * D26-P2-06 / D-S-06: a request above the accepted 5 bps is **capped**, never
   * applied. Raising the thumb is an owner product change, not a caller option.
   */
  readonly internalPreferenceBps?: number;
  /** Legs worse than the best effective price by more than this are dropped. */
  readonly maxSlippageBps?: number;
  /** Cap on venues in one route — each leg costs latency and a settlement path. */
  readonly maxVenues?: number;
  readonly maxStalenessMs?: number;
  readonly now?: Date;
  /**
   * §28 complete cost model (D26-P1-X3). When set, every candidate venue must
   * appear with complete terms (fee, expected impact, transfer, graded latency)
   * or it is refused. Ranking uses all-in bps; missing/unscored → weight 0.
   * Omit for the legacy fee-from-quote path.
   */
  readonly costTermsByVenue?: Readonly<Record<string, SorCostTerms>>;
}

/** Accepted D-S-06 / TERMINAL §4 house thumb. Default and hard ceiling. */
export const ACCEPTED_INTERNAL_PREFERENCE_BPS = 5 as const;

const DEFAULTS = {
  internalPreferenceBps: ACCEPTED_INTERNAL_PREFERENCE_BPS,
  maxSlippageBps: 50,
  maxVenues: 4,
  maxStalenessMs: 5_000,
} as const;

/**
 * Resolve the ranking-time internal preference.
 *
 * Callers may lower it (including to 0). They cannot raise it: anything above
 * the accepted 5 bps is clamped. Non-finite values fall back to the default
 * rather than opening an unbounded thumb.
 */
export function capInternalPreferenceBps(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return ACCEPTED_INTERNAL_PREFERENCE_BPS;
  }
  if (requested <= 0) return 0;
  return Math.min(ACCEPTED_INTERNAL_PREFERENCE_BPS, requested);
}

/** An explicit undefined, NaN, Infinity or negative option keeps the default instead of overriding it. */
function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * What the user really pays (buy) or receives (sell) per unit.
 *
 * Fees round `ceil` so an estimate is never rosier than reality — a route that
 * under-promises and over-delivers is fine; the reverse is a broken quote.
 */
export function effectivePrice(price: Amount, feeBps: number, side: 'buy' | 'sell'): Amount {
  const fee = mulBps(price, feeBps, 'ceil');
  return side === 'buy' ? add(price, fee) : sub(price, fee);
}

/** Lower is better for a buy, higher for a sell. Normalised so callers sort ascending. */
function rankKey(effective: Amount, side: 'buy' | 'sell'): Amount {
  return side === 'buy' ? effective : -effective;
}

/** The ranking-only adjustment. Never leaves this module. */
function preferenceAdjusted(effective: Amount, side: 'buy' | 'sell', isInternal: boolean, prefBps: number): Amount {
  if (!isInternal || prefBps === 0) return effective;
  const advantage = mulBps(effective < 0n ? -effective : effective, prefBps, 'floor');
  // Make the internal book *look* cheaper to buy from and richer to sell into.
  return side === 'buy' ? sub(effective, advantage) : add(effective, advantage);
}

interface Candidate {
  readonly source: LiquiditySource;
  readonly quote: VenueQuote;
  /** Venue fee-only effective (user-facing). */
  readonly effective: Amount;
  /** All-in effective used for ranking (fee[+impact+transfer] when complete). */
  readonly allIn: Amount;
  readonly ranking: Amount;
  readonly expectedImpactBps?: number;
  readonly transferCostBps?: number;
}

/**
 * Build a route. Pure given its quotes — every decision is inspectable, which
 * is what lets the terminal show the user exactly where their order goes and
 * why (docs/TERMINAL.md §3).
 */
export async function planRoute(
  request: QuoteRequest,
  sources: readonly LiquiditySource[],
  options: RouterOptions = {},
): Promise<RoutePlan> {
  const opts = {
    ...DEFAULTS,
    now: options.now,
    costTermsByVenue: options.costTermsByVenue,
    maxSlippageBps: finiteNonNegative(options.maxSlippageBps, DEFAULTS.maxSlippageBps),
    maxVenues: positiveInteger(options.maxVenues, DEFAULTS.maxVenues),
    maxStalenessMs: finiteNonNegative(options.maxStalenessMs, DEFAULTS.maxStalenessMs),
    // Cap after spread so a caller cannot silently raise the house thumb.
    internalPreferenceBps: capInternalPreferenceBps(options.internalPreferenceBps),
  };
  const now = opts.now ?? new Date();
  const rejected: RejectedVenue[] = [];
  const candidates: Candidate[] = [];

  // ── Gather ────────────────────────────────────────────────────────────────
  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      if (!isRoutable(source, now, opts.maxStalenessMs)) {
        const health = source.health();
        return {
          source,
          rejection: {
            venueId: source.id,
            reason: health.healthy ? ('stale' as const) : ('unhealthy' as const),
            detail: health.reason ?? `last update ${now.getTime() - health.lastUpdate.getTime()}ms ago`,
          },
        };
      }
      const quote = await source.quote(request);
      return { source, quote };
    }),
  );

  for (const [i, result] of settled.entries()) {
    const source = sources[i]!;

    if (result.status === 'rejected') {
      // A venue that throws is a venue that is down. Route around it.
      rejected.push({ venueId: source.id, reason: 'no_quote', detail: String(result.reason) });
      continue;
    }

    const value = result.value;
    if ('rejection' in value && value.rejection) {
      rejected.push(value.rejection);
      continue;
    }

    const quote = 'quote' in value ? value.quote : null;
    // amount<=0 already refused; price 0/negative is the same hole — a free-looking
    // mid would rank first on a buy.
    if (!quote || quote.amount <= 0n || quote.price <= 0n) {
      rejected.push({ venueId: source.id, reason: 'no_quote' });
      continue;
    }
    if (quote.expiresAt.getTime() <= now.getTime()) {
      rejected.push({ venueId: source.id, reason: 'stale', detail: 'quote expired' });
      continue;
    }

    const feeOnly = effectivePrice(quote.price, quote.feeBps, request.side);
    // The fee can eat the whole price on a sell; a non-positive effective price is not a quote.
    if (feeOnly <= 0n) {
      rejected.push({ venueId: source.id, reason: 'no_quote', detail: 'effective price after fee is not positive' });
      continue;
    }
    let allIn = feeOnly;
    let expectedImpactBps: number | undefined;
    let transferCostBps: number | undefined;

    if (opts.costTermsByVenue) {
      const terms = opts.costTermsByVenue[source.id];
      if (!terms) {
        rejected.push({
          venueId: source.id,
          reason: 'incomplete_cost',
          detail: 'no SorCostTerms for venue — refuse rather than assume zeros',
        });
        continue;
      }
      const scored = scoreSorCost(terms);
      if (!scored.ok) {
        rejected.push({
          venueId: source.id,
          reason: costRefuseToRouteReason(scored.reason),
          detail: `${scored.reason}: ${scored.detail}`,
        });
        continue;
      }
      allIn = allInEffectivePrice(quote.price, scored.totalCostBps, request.side);
      expectedImpactBps = scored.expectedImpactBps;
      transferCostBps = scored.transferCostBps;
    }

    if (allIn <= 0n) {
      rejected.push({ venueId: source.id, reason: 'no_quote', detail: 'all-in effective price is not positive' });
      continue;
    }
    const adjusted = preferenceAdjusted(allIn, request.side, source.kind === 'internal', opts.internalPreferenceBps);

    candidates.push({
      source,
      quote,
      effective: feeOnly,
      allIn,
      ranking: rankKey(adjusted, request.side),
      expectedImpactBps,
      transferCostBps,
    });
  }

  if (candidates.length === 0) {
    return emptyPlan(request, rejected);
  }

  // ── Rank ──────────────────────────────────────────────────────────────────
  candidates.sort((a, b) => {
    if (a.ranking !== b.ranking) return a.ranking < b.ranking ? -1 : 1;
    // Equal price: prefer the internal book, then the faster venue.
    const aInternal = a.source.kind === 'internal' ? 0 : 1;
    const bInternal = b.source.kind === 'internal' ? 0 : 1;
    if (aInternal !== bInternal) return aInternal - bInternal;
    return a.source.health().latencyMs - b.source.health().latencyMs;
  });

  const best = candidates[0]!;
  // Slippage guard uses all-in when the complete model is on, else fee-only —
  // same figure the ranker used, never the preference-adjusted one.
  const bestAllIn = best.allIn;

  // ── Fill ──────────────────────────────────────────────────────────────────
  const legs: RouteLeg[] = [];
  let remaining = request.amount;

  for (const candidate of candidates) {
    if (remaining <= 0n) {
      rejected.push({ venueId: candidate.source.id, reason: 'filled' });
      continue;
    }
    if (legs.length >= opts.maxVenues) {
      rejected.push({ venueId: candidate.source.id, reason: 'venue_cap' });
      continue;
    }

    // Slippage is measured against the best TRUE all-in price, not the
    // preference-adjusted one — otherwise the thumb on the scale would widen
    // the tolerance for everyone else too.
    const drift = priceDriftBps(bestAllIn, candidate.allIn, request.side);
    if (drift > opts.maxSlippageBps) {
      rejected.push({ venueId: candidate.source.id, reason: 'slippage', detail: `${drift} bps worse than best` });
      continue;
    }

    const take = min(remaining, candidate.quote.amount);
    legs.push({
      venueId: candidate.source.id,
      amount: take,
      price: candidate.quote.price,
      effectivePrice: candidate.effective,
      allInEffectivePrice: candidate.allIn,
      feeBps: candidate.quote.feeBps,
      expectedImpactBps: candidate.expectedImpactBps,
      transferCostBps: candidate.transferCostBps,
      kind: candidate.source.kind,
    });
    remaining = sub(remaining, take);
  }

  const routedAmount = sub(request.amount, remaining);
  // Report fee-only total to the user (venue cash); ranking already used all-in.
  const totalCost = legs.reduce((sum, leg) => add(sum, mul(leg.effectivePrice, leg.amount)), ZERO);
  const averageEffectivePrice = routedAmount > 0n ? div(totalCost, routedAmount) : null;
  const averageAllIn =
    routedAmount > 0n
      ? div(
          legs.reduce((sum, leg) => add(sum, mul(leg.allInEffectivePrice, leg.amount)), ZERO),
          routedAmount,
        )
      : ZERO;

  return {
    symbol: request.symbol,
    side: request.side,
    requestedAmount: request.amount,
    routedAmount,
    unfilledAmount: remaining,
    legs,
    averageEffectivePrice,
    totalCost,
    improvementBps: improvementVersusSingleVenue(legs, bestAllIn, averageAllIn, request.side),
    rejected,
  };
}

/** How much worse `price` is than `best`, in bps. Never negative. */
export function priceDriftBps(best: Amount, price: Amount, side: 'buy' | 'sell'): number {
  const worse = side === 'buy' ? sub(price, best) : sub(best, price);
  if (worse <= 0n) return 0;
  // No reference price to measure against: the drift is unbounded, never zero.
  if (best === 0n) return Number.POSITIVE_INFINITY;
  const magnitude = best < 0n ? -best : best;
  // (worse / best) * 10_000, computed in scaled space then reduced to a number.
  return Number(div(mul(worse, 10_000n * 10n ** 18n), magnitude) / 10n ** 18n);
}

function improvementVersusSingleVenue(
  legs: readonly RouteLeg[],
  bestEffective: Amount,
  averageEffective: Amount,
  side: 'buy' | 'sell',
): number {
  // Splitting can only ever be worse than the single best price (we take the
  // best venue first). Report honestly: the number is the cost of the split,
  // expressed as a negative improvement.
  if (legs.length <= 1 || bestEffective === 0n) return 0;
  return -priceDriftBps(bestEffective, averageEffective, side);
}

function emptyPlan(request: QuoteRequest, rejected: readonly RejectedVenue[]): RoutePlan {
  return {
    symbol: request.symbol,
    side: request.side,
    requestedAmount: request.amount,
    routedAmount: ZERO,
    unfilledAmount: request.amount,
    legs: [],
    averageEffectivePrice: null,
    totalCost: ZERO,
    improvementBps: 0,
    rejected,
  };
}

/** Human-readable route explanation — what the terminal shows before you confirm. */
export function explainRoute(plan: RoutePlan): string {
  if (plan.legs.length === 0) {
    return `No route for ${formatAmount(plan.requestedAmount)} ${plan.symbol}: ${
      plan.rejected.map((r) => `${r.venueId} (${r.reason})`).join(', ') || 'no venues available'
    }`;
  }

  const lines = plan.legs.map(
    (leg) =>
      `  ${formatAmount(leg.amount)} @ ${formatAmount(leg.price)} on ${leg.venueId}` +
      ` (${leg.feeBps} bps → ${formatAmount(leg.effectivePrice)} effective)`,
  );

  if (plan.unfilledAmount > 0n) {
    lines.push(`  ${formatAmount(plan.unfilledAmount)} unfilled — insufficient depth`);
  }

  return (
    `${plan.side} ${formatAmount(plan.routedAmount)} ${plan.symbol} across ${plan.legs.length} venue(s)\n` +
    lines.join('\n') +
    (plan.averageEffectivePrice === null ? '' : `\n  average ${formatAmount(plan.averageEffectivePrice)}`)
  );
}
