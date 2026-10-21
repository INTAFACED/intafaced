import type { Amount } from '@intafaced/ledger-client/money';
import type { LiquiditySource, VenueCapability, VenueKind } from '@intafaced/venue-adapter';
import type { VenueKind as RouterVenueKind } from '../router-quote.js';

/**
 * WHERE A PRICE IS ALLOWED TO COME FROM.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS FILE EXISTS TO MAKE IMPOSSIBLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `router-quote.ts` is arithmetic: give it venue quotes and it says where the
 * order should go. Until this module existed, the only thing that supplied those
 * quotes was **the caller** — `dex.quote` took a `quotes: []` array over the
 * wire and routed whatever was in it.
 *
 * That is a calculator, not a quote. A UI wired to it renders a price the user
 * can act on, and that price came from nowhere. **A fabricated price in a
 * trading product is worse than an outage**, because an outage stops a user and
 * an invented number encourages one.
 *
 * So a price may enter this service by exactly one road: a `QuoteVenue`, which
 * has to have really fetched a book from something, and has to say when.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXTENDS `LiquiditySource` RATHER THAN REPLACING IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `packages/venue-adapter` already IS the §27 venue fabric — the "own
 * CCXT-class layer" the spec asks for. `LiquiditySource` carries the venue
 * taxonomy (`internal | external-cex | external-dex | amm | otc`), the
 * capability declaration, and `VenueHealth` with `latencyMs` and `lastUpdate`,
 * which is the "latency grading" §27 names. What it did not have, until this
 * PR, was **a single implementation** — it was an interface with nothing behind
 * it, so nothing was ever aggregated.
 *
 * A parallel port here would have split that in two. So `QuoteVenue` IS a
 * `LiquiditySource`, plus the two things svc-dex's own router needs and the
 * Fiat Plane router does not model:
 *
 *   · `settlementCost` — gas. On the Protocol Plane it is not a rounding error;
 *     it is what makes a small order prefer a book and a large one still prefer
 *     a pool.
 *   · `depth()` — the book WITH the moment we read it, so freshness is a fact
 *     about our read rather than a claim by the venue.
 *
 * Everything in venue-adapter (`isRoutable`, `consolidateBook`, `planRoute`)
 * therefore works on these adapters unchanged.
 *
 * ── The property that must not be broken ────────────────────────────────────
 *
 * `source.ts`'s header states it: the internal book implements the same
 * interface as everyone else, so the router has no notion of "ours" versus
 * "theirs" and cannot quietly favour us. It holds here. Every venue below —
 * on-chain CLOB, our own engine, an external CEX — arrives as the same type and
 * is ranked on effective price alone. There is no internal-preference thumb on
 * the scale anywhere in svc-dex's path.
 *
 * ── No third-party connectivity library ─────────────────────────────────────
 *
 * §27: _"Our own CCXT-class layer, built past it… **No third-party connectivity
 * library in the money path** — Doctrine 5 applies."_ The `ccxt` package is not
 * a dependency of this workspace and must not become one. Two reasons, and the
 * second is the one that would actually cost a user money:
 *
 *   · Doctrine 5 / §27 — the connectivity layer is ours.
 *   · **CCXT's unified `fetchOrderBook` returns JavaScript numbers.** Every
 *     venue below publishes its book as decimal STRINGS; CCXT parses them to
 *     floats before a caller ever sees them. Routing through it would put a
 *     float in front of every price in the platform, which is the one thing
 *     Doctrine forbids without exception. Reading the venue's own strings costs
 *     one adapter each and keeps the last decimal place.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CUSTODY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LiquiditySource` declares `submit()` because it is also the Fiat Plane's
 * execution port. **Every adapter in svc-dex refuses it.** They declare
 * capabilities `['quote', 'orderbook']` and throw `VenueExecutionRefused` if
 * anything calls `submit`, so an execution path cannot appear here by accident:
 * svc-dex is `custodial: false`, and value moves in the user's own smart account
 * under the user's own key. `custody-scan` enforces the other half.
 */

/** Re-exported so adapters and tests speak one vocabulary. */
export type { LiquiditySource, VenueCapability, VenueKind };

export type VenueCapabilityList = readonly VenueCapability[];

/** `[price, quantity]` — scaled bigint, never `number`. */
export type BookLevel = readonly [price: Amount, quantity: Amount];

/**
 * Chain-settlement evidence for a protocol-plane book.
 *
 * Fiat and external-CEX books omit this: they do not settle by block finality.
 * Inclusion is not finality — `unconfirmed` and `unknown` must never become an
 * executable route (PTX-M22-R05/R07).
 */
export type ChainFinality = 'finalized' | 'unconfirmed' | 'unknown';

export interface TimestampedBook {
  readonly venueId: string;
  readonly symbol: string;
  /** Descending by price. */
  readonly bids: readonly BookLevel[];
  /** Ascending by price. */
  readonly asks: readonly BookLevel[];
  /**
   * The venue's own sequence, or `0` where it publishes none.
   *
   * Carried rather than generated. A consumer can only detect a gap on a venue
   * that numbers its updates; handing it a counter we invented would let it
   * believe it could detect one on a venue that gives it no way to.
   */
  readonly sequence: number;
  /**
   * When THIS PROCESS finished reading the data. Our clock, not theirs.
   *
   * A venue that has silently stopped updating still answers, still looks
   * healthy, and still returns a book with a plausible timestamp on it. The only
   * thing that catches that is our own clock at the moment of the read, which is
   * why no adapter may synthesise this from venue-supplied data.
   */
  readonly observedAt: Date;
  /**
   * Protocol-plane books only. Absent on fiat/external-CEX, where chain
   * finality is not the settlement clock.
   */
  readonly chainFinality?: ChainFinality;
}

/**
 * Where a fill on this venue would settle, and who would be holding the asset.
 *
 * Derived from `VenueKind` rather than configured, so it cannot drift from what
 * the venue actually is.
 */
export type SettlementPlane = 'protocol' | 'fiat' | 'external';

export function planeOf(kind: VenueKind): SettlementPlane {
  switch (kind) {
    // On-chain: the user's own key holds the asset. This is the sovereign case.
    case 'external-dex':
    case 'amm':
      return 'protocol';
    // Our engine, settled by a ledger post. We hold it.
    case 'internal':
      return 'fiat';
    // Somebody else holds it, and the user needs an account there.
    case 'external-cex':
    case 'otc':
      return 'external';
  }
}

/**
 * True when a fill would leave the asset in someone's custody other than the
 * user's own key.
 *
 * This is the field a caller who wants only sovereign liquidity filters on. It
 * is not about whether WE take custody — an external CEX leg is custodial to the
 * user even though the platform never touches it.
 */
export function isCustodial(kind: VenueKind): boolean {
  return planeOf(kind) !== 'protocol';
}

/** `LiquiditySource`'s taxonomy, reduced to the two shapes the router prices. */
export function routerKindOf(kind: VenueKind): RouterVenueKind {
  return kind === 'amm' ? 'pool' : 'book';
}

/**
 * Why a venue could not be used, in the vocabulary the response reports.
 *
 * `unreachable` and `stale` are deliberately different: one is a venue that did
 * not answer, the other is a venue that answered with something too old to price
 * against. Collapsing them would hide the difference between "the indexer is
 * down" and "the indexer is up and forty seconds behind the chain", and those
 * demand different responses from whoever is on call.
 */
export type VenueUnavailableReason =
  /** No answer, a non-200, or a transport error. */
  | 'unreachable'
  /** Answered, but the payload was not something a price can be read from. */
  | 'malformed'
  /** The venue knows its own data is wrong — a halted indexer, an empty index. */
  | 'not_ready'
  /** Answered with a book older than `QUOTE_MAX_AGE_MS`. */
  | 'stale'
  /** Answered with a book dated in the future. A broken clock is not freshness. */
  | 'clock_skew'
  /** Live, fresh, and nothing resting on the side we need. */
  | 'no_depth'
  /** A price-shaped payload we cannot classify as a quote. */
  | 'unknown'
  /** Protocol book with no finalizedHeight — inclusion is not settlement. */
  | 'missing_finality'
  /** Book sits above the finalized head; MEV/reorg can still revert it. */
  | 'reorg_unconfirmed';

export class VenueUnavailableError extends Error {
  constructor(
    readonly venueId: string,
    readonly reason: VenueUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'VenueUnavailableError';
  }
}

/**
 * Thrown by every svc-dex adapter's `submit`.
 *
 * Not a `NotImplementedError` and not a silent no-op. §28 puts cross-venue
 * execution in `svc-execution`, which does not exist, and executing against an
 * external venue needs Venue Vault credentials nobody has issued. A router that
 * "submitted" into either gap would report a fill that never happened, so the
 * refusal is loud, typed, and tested.
 */
export class VenueExecutionRefused extends Error {
  constructor(
    readonly venueId: string,
    readonly code: 'dex.execution.not_this_service' | 'dex.execution.no_credentials',
    message: string,
  ) {
    super(message);
    this.name = 'VenueExecutionRefused';
  }
}

/**
 * A place a price can honestly come from.
 *
 * `depth()` either returns a book it really fetched, or throws
 * `VenueUnavailableError`. It must never return an empty book to mean "I could
 * not reach the venue" — an empty book is a real market state (nothing resting)
 * and conflating the two turns an outage into a silent no-liquidity answer.
 */
/** A pool is named by chain and address, the same pair the hide list uses. */
export interface PoolRef {
  readonly chainId: number;
  readonly address: string;
}

export interface QuoteVenue extends LiquiditySource {
  /**
   * Taker fee in basis points. A protocol/venue parameter, not a market
   * observation — and disclosed in every response for exactly that reason.
   */
  readonly feeBps: number;
  /**
   * Estimated settlement cost in the QUOTE asset — gas on a pool, zero where we
   * pay no chain fee to settle.
   *
   * Configured, not measured. Stated in `env.ts` rather than guessed at the
   * point of use, because a price component invented where it is consumed is one
   * nobody can audit.
   */
  readonly settlementCost: Amount;
  /**
   * The pool this venue quotes, when it is one. A pool INTAFACED has hidden is dropped from routing; a venue with no `pool` cannot
   * be hidden by pool.
   */
  readonly pool?: PoolRef;

  /** The book, plus when we read it. Throws `VenueUnavailableError`. */
  depth(symbol: string, limit: number): Promise<TimestampedBook>;
}
