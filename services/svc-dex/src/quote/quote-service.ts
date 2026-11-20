import { formatAmount, type Amount } from '@intafaced/ledger-client/money';
import { sweepCost } from '@intafaced/venue-adapter';
import { presentRoute, route, type VenueKind as RouterVenueKind, type VenueQuote } from '../router-quote.js';
import type { DexDoorHonesty } from '@intafaced/contracts/dex-procedures';
import { dexDoorHonesty } from './door-honesty.js';
import { asConsolidatedBook } from './market-data-source.js';
import type { ChainFinality, QuoteVenue, SettlementPlane, VenueUnavailableReason } from './venue.js';
import { isCustodial, planeOf, routerKindOf, VenueUnavailableError } from './venue.js';

/**
 * THE QUOTE PATH — fetch, age-check, sweep, route, or REFUSE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **There is no code path in this file that returns a price it did not source.**
 *
 * No cache, no last-known value, no fallback venue, no "best effort" answer with
 * a warning attached. Every exit is either a route built from books read within
 * `QUOTE_MAX_AGE_MS`, or a `QuoteRefusedError` carrying a machine-readable code
 * and the reason each venue dropped out.
 *
 * That asymmetry is the product decision, not a style choice. A refusal costs a
 * user a retry. A stale or invented price costs them a trade, and they will not
 * know it happened until the fill comes back at a number that was never on any
 * venue. An error is recoverable; a bad fill is not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "BEST OF N" MUST NOT MEAN "THE ONLY ONE THAT ANSWERED"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A cross-venue router degrades quietly by nature: three venues configured, two
 * time out, and the survivor's price is presented as the best of three. It is
 * not — it is the only one, and the user has no way to tell.
 *
 * So the response states it. `venuesConfigured` is how many were asked,
 * `venues` is who priced, `unavailable` is who did not and why, `degraded` is
 * true whenever those two disagree, and `singleVenue` is true when exactly one
 * survived out of more than one. That ranking honesty is not a certified
 * best-execution claim — `bestEx.claimed` stays false until owner law is set.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS REUSED, AND WHY THAT SPLIT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * · `sweepCost` — `@intafaced/venue-adapter`. Walking a book for a quantity is
 *   solved and tested there. A second implementation of the same walk is a
 *   second thing to be wrong.
 * · `route` / `effectivePrice` — this service's `router-quote.ts`. It is the
 *   only router in the repo that models `settlementCost`, and on the Protocol
 *   Plane gas is not a rounding error: it is what makes a small order prefer a
 *   book and a large one still prefer a pool.
 *
 * The division is clean: **venue-adapter gets liquidity, svc-dex decides.** And
 * the decision is on effective price alone — every venue arrives as the same
 * `LiquiditySource`, so nothing here can favour our own book.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STALENESS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `QUOTE_MAX_AGE_MS` (owner-published; never git-default 2000) is enforced HERE, once, against
 * `TimestampedBook.observedAt` — the moment this process finished reading the
 * venue.
 *
 * Measuring at assembly rather than at fetch is the point. A venue that answers
 * in 20ms and a venue that answers in 1900ms produce books of very different
 * ages by the time they are compared, and routing the second against the first
 * as though they were simultaneous is how a router picks a venue whose price has
 * already moved. Both are aged against one clock reading taken after every fetch
 * has landed.
 *
 * A book dated in the FUTURE is refused too. It is tempting to treat a negative
 * age as "very fresh"; it is a broken clock somewhere, and a broken clock is the
 * one condition under which the ceiling silently stops working.
 */

export type QuoteRefusalCode =
  /** Nothing is wired. An operator problem, not a market condition. */
  | 'dex.quote.no_venue_configured'
  /** Every venue failed to answer. The market may be fine; we cannot see it. */
  | 'dex.quote.no_venue_available'
  /** Venues answered, but nothing landed inside the freshness ceiling. */
  | 'dex.quote.stale'
  /** Fresh books, nothing resting on the side asked for. A real market state. */
  | 'dex.quote.no_liquidity'
  /** Owner has not published how many book levels to pull. Never invent 50. */
  | 'dex.quote.depth_unset'
  /** Owner has not published the quote freshness ceiling. Never invent 2000. */
  | 'dex.quote.max_age_unset'
  /** Protocol books with no finalizedHeight. Inclusion is not settlement. */
  | 'dex.quote.missing_finality'
  /** Book sits above finalized head — MEV/reorg can still revert it. */
  | 'dex.quote.reorg_unconfirmed'
  /** A payload we cannot classify as a quote. */
  | 'dex.quote.unknown';

export type NonExecutableReason = 'custodial_settlement' | 'incomparable_settlement' | 'degraded' | 'not_final';

export interface UnavailableVenue {
  readonly venueId: string;
  readonly plane: SettlementPlane;
  readonly reason: VenueUnavailableReason;
  readonly detail: string;
}

/**
 * A refusal to quote.
 *
 * Thrown rather than returned. A caller can ignore a field on a result object;
 * it cannot ignore a rejected promise, and "the client forgot to check `ok`" is
 * not an acceptable way to end up displaying a price.
 *
 * `venues` travels with it because "why can you not quote me" is the first
 * question, and whoever is on call should get the answer from the error rather
 * than from a log search.
 */
export class QuoteRefusedError extends Error {
  constructor(
    readonly code: QuoteRefusalCode,
    message: string,
    readonly venues: readonly UnavailableVenue[] = [],
  ) {
    super(message);
    this.name = 'QuoteRefusedError';
  }
}

/** A venue that priced, as disclosed to the caller. Decimal strings throughout. */
export interface QuotedVenue {
  readonly venueId: string;
  /** `internal | external-cex | external-dex | amm | otc` — §27's taxonomy. */
  readonly venueKind: string;
  /** The two shapes the router prices: a book, or a pool. */
  readonly kind: RouterVenueKind;
  readonly plane: SettlementPlane;
  /**
   * True when a fill here would leave the asset in someone's custody other than
   * the user's own key — our ledger on the internal book, the venue itself on an
   * external CEX.
   *
   * A permissionless caller may be quoted such a venue but cannot execute
   * against it without an account somewhere. Saying so is the difference between
   * an honest quote and a price behind a gate the user was told did not exist.
   */
  readonly custodial: boolean;
  readonly feeBps: number;
  readonly settlementCost: string;
  readonly fillableQty: string;
  readonly quoteAmount: string;
  readonly observedAt: string;
  readonly ageMs: number;
  /** Round-trip of the read that produced this quote. §27 latency grading. */
  readonly latencyMs: number;
}

export interface SourcedQuote extends DexDoorHonesty {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly route: ReturnType<typeof presentRoute>;
  /** Every venue that produced a usable quote, whether or not it won a leg. */
  readonly venues: readonly QuotedVenue[];
  /** Every venue that did not, and why. Never silently omitted. */
  readonly unavailable: readonly UnavailableVenue[];
  /** How many venues were asked. Ranking denominator — not a certified claim. */
  readonly venuesConfigured: number;
  /** True when at least one configured venue could not be priced. */
  readonly degraded: boolean;
  /** True when exactly one venue survived out of more than one asked. */
  readonly singleVenue: boolean;
  /** Observation time of the OLDEST book behind this route. The quote is as of this. */
  readonly asOf: string;
  /** Age of that oldest book. The number the ceiling was applied to. */
  readonly ageMs: number;
  readonly maxAgeMs: number;
  /** True when any leg would settle outside the user's own custody. */
  readonly custodialLegs: boolean;
  /**
   * True only for a comparable, non-custodial, finalized protocol plan.
   * A quote is never a fill. Outage/unknown/missing-finality/reorg never set this.
   */
  readonly executable: boolean;
  /** False when the priced venues do not share a custody/settlement plane. */
  readonly comparableSettlement: boolean;
  readonly nonExecutableReason: NonExecutableReason | null;
}

export interface SourceQuoteRequest {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly qty: Amount;
}

export interface SourceQuoteDeps {
  readonly venues: readonly QuoteVenue[];
  /**
   * Quote freshness ceiling (ms). Also the per-venue fetch timeout.
   * Unset / not an int in 100..30000 → `dex.quote.max_age_unset`. Never invent 2000.
   */
  readonly maxAgeMs?: number;
  /**
   * Book depth to request from each venue. Unset / not a positive int →
   * `dex.quote.depth_unset`. Never invent 50.
   */
  readonly depth?: number;
  /** Injected in tests. Read ONCE, after every fetch has landed. */
  readonly now?: () => Date;
}

interface Priced {
  readonly venue: QuoteVenue;
  readonly quote: VenueQuote;
  readonly observedAt: Date;
  readonly ageMs: number;
  readonly latencyMs: number;
  readonly chainFinality: ChainFinality | undefined;
}

/**
 * Which refusal to give when nothing priced.
 *
 * Ordered by what the operator most needs to know. "Fresh books with no depth"
 * is a market condition and beats a staleness report that would send someone
 * hunting a clock problem that is not there. Staleness beats unreachability for
 * the same reason: a venue that answered and was too slow is a different
 * incident from one that never answered at all.
 */
function refusalFor(unavailable: readonly UnavailableVenue[]): QuoteRefusalCode {
  if (unavailable.some((u) => u.reason === 'no_depth')) return 'dex.quote.no_liquidity';
  if (unavailable.some((u) => u.reason === 'stale' || u.reason === 'clock_skew')) return 'dex.quote.stale';
  if (unavailable.some((u) => u.reason === 'missing_finality')) return 'dex.quote.missing_finality';
  if (unavailable.some((u) => u.reason === 'reorg_unconfirmed')) return 'dex.quote.reorg_unconfirmed';
  if (unavailable.some((u) => u.reason === 'unknown')) return 'dex.quote.unknown';
  return 'dex.quote.no_venue_available';
}

/**
 * Protocol-plane books need chain-finality evidence. Missing or unconfirmed
 * evidence is dropped here, not priced: a route built from it would look like
 * an executable fill on a reorg-reversible observation.
 */
function protocolFinalityGap(venue: QuoteVenue, chainFinality: ChainFinality | undefined): UnavailableVenue | null {
  if (planeOf(venue.kind) !== 'protocol') return null;
  const plane = planeOf(venue.kind);
  if (chainFinality === undefined || chainFinality === 'unknown') {
    return {
      venueId: venue.id,
      plane,
      reason: 'missing_finality',
      detail: 'protocol book has no finalizedHeight — inclusion is not settlement',
    };
  }
  if (chainFinality === 'unconfirmed') {
    return {
      venueId: venue.id,
      plane,
      reason: 'reorg_unconfirmed',
      detail: 'protocol book sits above finalized head — MEV/reorg can still revert it',
    };
  }
  return null;
}

function honestyFor(
  contributing: readonly Priced[],
  degraded: boolean,
): { executable: boolean; comparableSettlement: boolean; nonExecutableReason: NonExecutableReason | null } {
  const planes = new Set(contributing.map((p) => planeOf(p.venue.kind)));
  const comparableSettlement = planes.size === 1;
  if (!comparableSettlement) {
    return { executable: false, comparableSettlement: false, nonExecutableReason: 'incomparable_settlement' };
  }
  if (degraded) {
    return { executable: false, comparableSettlement, nonExecutableReason: 'degraded' };
  }
  if (contributing.some((p) => isCustodial(p.venue.kind))) {
    return { executable: false, comparableSettlement, nonExecutableReason: 'custodial_settlement' };
  }
  if (contributing.some((p) => planeOf(p.venue.kind) === 'protocol' && p.chainFinality !== 'finalized')) {
    return { executable: false, comparableSettlement, nonExecutableReason: 'not_final' };
  }
  return { executable: true, comparableSettlement, nonExecutableReason: null };
}

function publishedQuoteDepth(depth: number | undefined): number | undefined {
  return typeof depth === 'number' && Number.isInteger(depth) && depth >= 1 ? depth : undefined;
}

function publishedQuoteMaxAgeMs(maxAgeMs: number | undefined): number | undefined {
  return typeof maxAgeMs === 'number' && Number.isInteger(maxAgeMs) && maxAgeMs >= 100 && maxAgeMs <= 30_000 ? maxAgeMs : undefined;
}

export async function sourceQuote(deps: SourceQuoteDeps, request: SourceQuoteRequest): Promise<SourcedQuote> {
  if (request.qty <= 0n) throw new RangeError('quote quantity must be positive');

  const depth = publishedQuoteDepth(deps.depth);
  if (depth === undefined) {
    throw new QuoteRefusedError('dex.quote.depth_unset', 'DEX_QUOTE_DEPTH is unset — owner must publish book depth. Never invent 50.');
  }

  const maxAgeMs = publishedQuoteMaxAgeMs(deps.maxAgeMs);
  if (maxAgeMs === undefined) {
    throw new QuoteRefusedError(
      'dex.quote.max_age_unset',
      'QUOTE_MAX_AGE_MS is unset — owner must publish quote freshness. Never invent 2000.',
    );
  }

  if (deps.venues.length === 0) {
    throw new QuoteRefusedError(
      'dex.quote.no_venue_configured',
      'No quote venue is configured. svc-dex will not answer with a price it did not source.',
    );
  }

  // Every venue in parallel. `allSettled`, not `all`: one venue being down must
  // not take the quote with it — that is the whole reason to route across
  // several — but it must still be REPORTED rather than dropped.
  const settled = await Promise.allSettled(deps.venues.map((venue) => venue.depth(request.symbol, depth)));

  // One clock reading, after everything has landed. See the header.
  const now = (deps.now ?? (() => new Date()))();

  const unavailable: UnavailableVenue[] = [];
  const priced: Priced[] = [];

  for (const [index, result] of settled.entries()) {
    const venue = deps.venues[index]!;
    const plane = planeOf(venue.kind);

    if (result.status === 'rejected') {
      const err: unknown = result.reason;
      unavailable.push({
        venueId: venue.id,
        plane,
        reason: err instanceof VenueUnavailableError ? err.reason : 'unreachable',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const book = result.value;
    const ageMs = now.getTime() - book.observedAt.getTime();

    if (ageMs < 0) {
      unavailable.push({
        venueId: venue.id,
        plane,
        reason: 'clock_skew',
        detail: `book is dated ${-ageMs}ms in the future — a clock is wrong and the staleness ceiling cannot be trusted`,
      });
      continue;
    }

    // THE CEILING. `QUOTE_MAX_AGE_MS`, applied to the one path that produces a
    // price. A venue past it is dropped; if that empties the set, the request is
    // refused below rather than answered from whatever is left over.
    if (ageMs > maxAgeMs) {
      unavailable.push({
        venueId: venue.id,
        plane,
        reason: 'stale',
        detail: `book is ${ageMs}ms old, ceiling is ${maxAgeMs}ms`,
      });
      continue;
    }

    const finalityGap = protocolFinalityGap(venue, book.chainFinality);
    if (finalityGap) {
      unavailable.push(finalityGap);
      continue;
    }

    const sweep = sweepCost(asConsolidatedBook(book), request.side, request.qty);
    if (sweep.filled <= 0n) {
      unavailable.push({
        venueId: venue.id,
        plane,
        reason: 'no_depth',
        detail: `nothing resting on the ${request.side === 'buy' ? 'ask' : 'bid'} side`,
      });
      continue;
    }

    priced.push({
      venue,
      observedAt: book.observedAt,
      ageMs,
      latencyMs: venue.health().latencyMs,
      chainFinality: book.chainFinality,
      quote: {
        venue: venue.id,
        kind: routerKindOf(venue.kind),
        // A partial sweep is reported as a partial quote. The router splits on
        // it; pretending the venue can fill the whole size is how an order gets
        // routed somewhere that cannot take it.
        fillableQty: sweep.filled,
        quoteAmount: sweep.cost,
        feeBps: venue.feeBps,
        settlementCost: venue.settlementCost,
      },
    });
  }

  if (priced.length === 0) {
    const code = refusalFor(unavailable);
    throw new QuoteRefusedError(code, `No venue could price ${request.symbol}: ${describe(unavailable)}`, unavailable);
  }

  const plan = route(
    { side: request.side, qty: request.qty },
    priced.map((p) => p.quote),
  );

  // Defensive: every priced venue had depth, so this cannot normally trip. It
  // stays because "filled nothing" must never be presentable as a route — a
  // zero-cost, zero-quantity result reads like a free trade.
  if (plan.filledQty <= 0n) {
    throw new QuoteRefusedError('dex.quote.no_liquidity', `No venue could fill any of ${request.symbol}`, unavailable);
  }

  const routedVenues = new Set(plan.legs.map((leg) => leg.venue));
  const contributing = priced.filter((p) => routedVenues.has(p.venue.id));
  const oldest = contributing.reduce((worst, p) => (p.ageMs > worst.ageMs ? p : worst), contributing[0]!);
  const degraded = unavailable.length > 0;
  const honesty = honestyFor(contributing, degraded);
  const door = dexDoorHonesty({
    internalBookEnabled: deps.venues.some((v) => v.kind === 'internal'),
    internalBookPriced: priced.some((p) => p.venue.kind === 'internal'),
    ammVenueWired: deps.venues.some((v) => v.kind === 'amm'),
    // Operator `DEX_EXTERNAL_VENUES` only — not intachain-clob (`external-dex`).
    externalVenueWired: deps.venues.some((v) => v.kind === 'external-cex' || v.kind === 'otc' || v.kind === 'amm'),
  });

  return {
    symbol: request.symbol,
    side: request.side,
    route: presentRoute(plan, { kind: 'quote', executable: honesty.executable }),
    venues: priced.map((p) => ({
      venueId: p.venue.id,
      venueKind: p.venue.kind,
      kind: routerKindOf(p.venue.kind),
      plane: planeOf(p.venue.kind),
      custodial: isCustodial(p.venue.kind),
      feeBps: p.venue.feeBps,
      settlementCost: formatAmount(p.venue.settlementCost),
      fillableQty: formatAmount(p.quote.fillableQty),
      quoteAmount: formatAmount(p.quote.quoteAmount),
      observedAt: p.observedAt.toISOString(),
      ageMs: p.ageMs,
      latencyMs: p.latencyMs,
    })),
    unavailable,
    venuesConfigured: deps.venues.length,
    degraded,
    singleVenue: priced.length === 1 && deps.venues.length > 1,
    asOf: oldest.observedAt.toISOString(),
    ageMs: oldest.ageMs,
    maxAgeMs,
    custodialLegs: contributing.some((p) => isCustodial(p.venue.kind)),
    executable: honesty.executable,
    comparableSettlement: honesty.comparableSettlement,
    nonExecutableReason: honesty.nonExecutableReason,
    ...door,
  };
}

function describe(unavailable: readonly UnavailableVenue[]): string {
  if (unavailable.length === 0) return 'no venues were reachable';
  return unavailable.map((u) => `${u.venueId} (${u.reason}: ${u.detail})`).join('; ');
}
