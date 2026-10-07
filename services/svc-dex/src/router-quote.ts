import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';

/**
 * THE SMART ORDER ROUTER (§8.6).
 *
 * Ranks observed quotes (internal book vs pool). Ranking is not a certified
 * best-execution claim — see `refuseBestExClaim` / quote-door `bestEx`.
 *
 * Two venues can fill the same order and they are not comparable at face value.
 * An AMM quote already includes its price impact but pays gas; a book quote is
 * exact at the top and worse as you consume depth. Comparing headline prices
 * picks the wrong venue routinely.
 *
 * So this module compares **effective price** — what the taker actually ends up
 * with, after impact, fees and gas. That is the only comparison that means
 * anything to the person trading.
 *
 * ── Why this file holds no I/O ──────────────────────────────────────────────
 *
 * Routing is arithmetic over quotes. Keeping it pure means the decision is
 * unit-testable against constructed books and pools, with no chain and no
 * engine, and it means the same code decides identically in a test and in
 * production. Fetching quotes is the caller's job.
 *
 * ── Custody ─────────────────────────────────────────────────────────────────
 *
 * Nothing here moves value. svc-dex is a Protocol Plane service: it may read,
 * quote and route, and it must never post to the ledger — `custody-scan`
 * (Doctrine §16.10) fails the build if this service imports a write recipe.
 * That check is what makes "non-custodial" a property rather than a claim, and
 * it is the reason the DEX ships permissionless (§585).
 */

export type VenueKind = 'book' | 'pool';

export interface VenueQuote {
  readonly venue: string;
  readonly kind: VenueKind;
  /**
   * Base quantity this venue can fill at `quoteAmount`. May be less than
   * requested — a partial quote is honest and a router that ignores it will
   * route the whole order to a venue that cannot take it.
   */
  readonly fillableQty: Amount;
  /** Total quote-asset cost (buy) or proceeds (sell) for `fillableQty`. */
  readonly quoteAmount: Amount;
  /** Taker fee in basis points, charged by the venue on the received asset. */
  readonly feeBps: number;
  /**
   * Estimated settlement cost in the QUOTE asset — gas on a pool, zero on the
   * internal book. Not a rate: a fixed cost, which is exactly why small orders
   * route to the book and large ones can still prefer a pool.
   */
  readonly settlementCost: Amount;
}

export interface RouteRequest {
  readonly side: 'buy' | 'sell';
  /** Base quantity the taker wants. */
  readonly qty: Amount;
}

export interface RouteLeg {
  readonly venue: string;
  readonly kind: VenueKind;
  readonly qty: Amount;
  readonly quoteAmount: Amount;
  /** Quote cost per unit of base, after fees and settlement. Lower is better on a buy. */
  readonly effectivePrice: Amount;
}

export interface Route {
  readonly legs: readonly RouteLeg[];
  readonly filledQty: Amount;
  /** Unfilled remainder. Non-zero means no venue could take the rest. */
  readonly unfilledQty: Amount;
  readonly totalQuoteAmount: Amount;
}

/** A plan is never a fill. Preview arithmetic is never a live quote. */
export type PresentedRouteKind = 'quote' | 'preview';

export interface RouteHonesty {
  readonly kind: PresentedRouteKind;
  /**
   * Fail-closed. True only when the caller proved comparable custody/settlement
   * and chain finality. A missing proof is not executable.
   */
  readonly executable: boolean;
}

const SCALE = 10n ** 18n;
const BPS = 10_000n;

/**
 * Effective price per unit of base, in the quote asset, at 18 decimals.
 *
 * Fees are applied to the side that actually pays them: a buyer receives less
 * base, which raises their cost per unit; a seller receives less quote, which
 * lowers their proceeds per unit. Modelling the fee as a flat adjustment to the
 * quote amount would misprice one side.
 *
 * Settlement cost is added to a buy and subtracted from a sell for the same
 * reason — it is a cost to the taker in both directions. It is charged once
 * on the quantity actually taken. Spreading it across the venue's unused
 * size makes a partial take of a large pool look cheaper than the book.
 */
export function effectivePrice(quote: VenueQuote, side: 'buy' | 'sell', takeQty?: Amount): Amount {
  const take = takeQty ?? quote.fillableQty;
  if (quote.fillableQty <= 0n || take <= 0n) throw new RangeError('cannot price a quote with no fillable quantity');

  // Pro-rate only the venue notional. Settlement stays whole.
  const variable = (quote.quoteAmount * take) / quote.fillableQty;
  const feeBps = BigInt(quote.feeBps);

  if (side === 'buy') {
    // Buyer pays the taken notional plus gas, and receives base minus fee.
    const received = take - (take * feeBps) / BPS;
    if (received <= 0n) throw new RangeError('venue fee consumes the entire fill');
    return ((variable + quote.settlementCost) * SCALE) / received;
  }

  // Seller delivers the taken base, receives notional minus fee, minus gas.
  const proceeds = variable - (variable * feeBps) / BPS - quote.settlementCost;
  return (proceeds * SCALE) / take;
}

/**
 * Rank observed quotes across venues, splitting when one cannot fill alone.
 *
 * Greedy by effective price. Not provably optimal — a true optimum would have
 * to model how each venue's price moves as it is consumed, which needs a depth
 * curve rather than a single quote. Greedy over honest per-venue quotes is the
 * right first version, and the comment is here so nobody later mistakes it for
 * something cleverer than it is.
 *
 * Ties break on venue id, so routing is a function of the quote SET rather than
 * of whatever order they happened to arrive in. Two identical requests must
 * route identically or a fill becomes unreproducible.
 */
export function route(request: RouteRequest, quotes: readonly VenueQuote[]): Route {
  if (request.qty <= 0n) throw new RangeError('route quantity must be positive');

  const open = quotes.filter((q) => q.fillableQty > 0n);
  const legs: RouteLeg[] = [];
  let remaining = request.qty;
  let totalQuote = 0n;

  while (remaining > 0n && open.length > 0) {
    // Rank on the quantity this step would actually take, so a fixed settlement
    // cost is not diluted across size the order will not consume.
    const ranked = open
      .map((quote) => {
        const take = quote.fillableQty < remaining ? quote.fillableQty : remaining;
        return { quote, take, price: effectivePrice(quote, request.side, take) };
      })
      .sort((a, b) => {
        // Buy: cheapest first. Sell: highest proceeds first.
        const better = request.side === 'buy' ? a.price - b.price : b.price - a.price;
        if (better !== 0n) return better < 0n ? -1 : 1;
        return a.quote.venue < b.quote.venue ? -1 : a.quote.venue > b.quote.venue ? 1 : 0;
      });

    const best = ranked[0]!;
    // Pro-rate the venue notional only. Settlement is paid once, in full.
    // Exact integer arithmetic: no rounding to a float, ever.
    const variable = (best.quote.quoteAmount * best.take) / best.quote.fillableQty;
    const legQuote =
      request.side === 'buy' ? variable + best.quote.settlementCost : variable - best.quote.settlementCost;

    legs.push({
      venue: best.quote.venue,
      kind: best.quote.kind,
      qty: best.take,
      quoteAmount: legQuote,
      effectivePrice: best.price,
    });
    remaining -= best.take;
    totalQuote += legQuote;
    open.splice(open.indexOf(best.quote), 1);
  }

  return { legs, filledQty: request.qty - remaining, unfilledQty: remaining, totalQuoteAmount: totalQuote };
}

/** Render a route for an API response — decimal strings, never numbers. */
export function presentRoute(r: Route, honesty: RouteHonesty = { kind: 'quote', executable: false }) {
  return {
    // Fail-closed: a caller that ignores `kind` still cannot treat this as a fill,
    // and a missing honesty argument cannot become executable:true.
    kind: honesty.kind,
    executable: honesty.executable,
    legs: r.legs.map((l) => ({
      venue: l.venue,
      kind: l.kind,
      qty: formatAmount(l.qty),
      quoteAmount: formatAmount(l.quoteAmount),
      effectivePrice: formatAmount(l.effectivePrice),
    })),
    filledQty: formatAmount(r.filledQty),
    unfilledQty: formatAmount(r.unfilledQty),
    totalQuoteAmount: formatAmount(r.totalQuoteAmount),
  };
}

export { parseAmount };
