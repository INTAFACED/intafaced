import type { VenueMarket } from './market.js';
import type { VenueBookDelta, VenueBookSnapshot } from './book.js';
import type { BorrowRate, FundingRate, VenueTrade } from './rates.js';
import type { TransferRail, VenueBalance, VenueOrder, VenueOrderType, VenuePosition } from './account.js';
import type { RestLatencyGrade, WsLatencyGrade } from './latency.js';
import { VenueCredentialScopeError, VenueCredentialsMissingError } from './errors.js';
import type { Amount } from '@intafaced/ledger-client/money';

/**
 * THE ADAPTER SPLIT — §27's three classes, and why they are three.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SPLIT IS A CREDENTIAL BOUNDARY, NOT A FILING SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MarketDataAdapter` needs NO credentials. Every venue publishes its book, its
 * trades and its funding rate to anyone. So a market-data adapter can be built,
 * run and verified today, against the real venue, by anyone with a network
 * connection — and it either works or it does not.
 *
 * `TradeAdapter` and `AccountAdapter` need API keys the owner must issue from
 * the Venue Vault. They cannot be built "and tested later"; without a key there
 * is no venue on the other end at all.
 *
 * Splitting them at that line is what stops the second fact from being hidden
 * by the first. If all three lived on one interface, an adapter could report
 * itself as "connected" on the strength of its public feed while its trading
 * half was an empty function — and the fabric would look complete. Three
 * interfaces means a registry can say, per venue, exactly which halves exist,
 * and a caller that wants to trade has to ask for the half that needs a key.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WS-FIRST IS IN THE SHAPE, NOT IN A COMMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MarketDataAdapter` has no `pollBook()`. It has `snapshotBook()` — used ONCE
 * to seed, and again after a gap — and `streamBook()`, which yields deltas.
 * There is deliberately no method that returns "the current book by polling",
 * because a fabric that could poll would poll, and a polled book is a book with
 * an unbounded and invisible age between reads.
 *
 * The snapshot/stream pair is also the only shape in which gap detection is
 * possible: a gap is a discontinuity between numbered updates, and a poller has
 * no numbers to compare.
 */

/** Everything the fabric needs to know about a venue before it talks to it. */
export interface VenueDescriptor {
  /** Stable, lowercase, no spaces. The id every report and metric is keyed by. */
  readonly id: string;
  /** For humans. Never parsed. */
  readonly displayName: string;
  /**
   * Which §27 family this is. Drives nothing in the router — it ranks on price —
   * but drives what a health report means: an AMM read at a block height cannot
   * be gap-checked and should not be alerted on as though it could.
   */
  readonly kind: 'internal' | 'external-cex' | 'external-dex' | 'amm' | 'otc' | 'fx-bridge';
  /**
   * True when this venue numbers its depth updates and the numbering can be
   * checked for gaps.
   *
   * False is a legitimate answer (see `book.ts`), and stating it is what lets a
   * consumer that requires gap detection filter rather than assume.
   */
  readonly sequencedDepth: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// MARKET DATA — public, no credentials
// ════════════════════════════════════════════════════════════════════════════

/**
 * A live depth subscription.
 *
 * `close()` is not optional and not a convenience. A venue counts open streams
 * against a per-IP limit, and a fabric that leaks subscriptions gets the whole
 * process disconnected — which reads, from inside, exactly like the venue going
 * down.
 */
export interface BookSubscription {
  /** Deltas in the order the transport delivered them. Gaps are the consumer's to detect. */
  readonly deltas: AsyncIterable<VenueBookDelta>;
  close(): Promise<void>;
}

export interface MarketDataAdapter {
  readonly venue: VenueDescriptor;

  /** Every instrument this venue lists, normalised. */
  markets(): Promise<VenueMarket[]>;

  /**
   * A full book. Used to seed a tracker, and again after a gap — never on a
   * timer. See the header for why there is no polling method.
   */
  snapshotBook(symbol: string, limit?: number): Promise<VenueBookSnapshot>;

  /**
   * Subscribe to incremental depth.
   *
   * The subscription must be opened BEFORE the seeding snapshot is taken and
   * its deltas buffered until the snapshot lands. Doing it the other way round
   * leaves a window between the snapshot and the first delta in which updates
   * are lost with no sequence discontinuity to prove it — the one gap a gap
   * detector cannot see.
   */
  streamBook(symbol: string): Promise<BookSubscription>;

  /** Public prints. Absent on venues that do not publish a trade feed. */
  streamTrades?(symbol: string): Promise<{ trades: AsyncIterable<VenueTrade>; close(): Promise<void> }>;

  /** Perpetual venues only. */
  fundingRate?(symbol: string): Promise<FundingRate>;
  borrowRate?(asset: string): Promise<BorrowRate>;

  /**
   * This adapter's own latency grade, from the observations it has actually
   * made (§27:760). Measurement, window and the meaning of `null` are all
   * defined in `latency.ts` — read that before consuming this.
   *
   * ── Why this is on the adapter, and why it is optional ──────────────────
   *
   * §27 wants "every adapter continuously scored". An adapter is the only thing
   * that knows how long its own calls took, so the score has to be readable
   * from the adapter — a grade that exists only inside the fabric, reachable
   * solely by code that constructed the grader itself, is the unreachable-guard
   * failure this repo has hit repeatedly: correct in isolation, wired to
   * nothing.
   *
   * Declaring it HERE rather than on the concrete classes is what makes it
   * reachable in practice. Consumers hold a `MarketDataAdapter`, not a
   * `BinanceSpotMarketData`, so a method that exists only on the class is
   * invisible through the type they actually have.
   *
   * OPTIONAL, and the optionality is meaningful rather than lenient. There are
   * two distinct absences and they must not collapse into one:
   *
   *   · **Method absent** — this adapter does not measure itself at all. A
   *     consumer learns that grading is unavailable here, which is a fact about
   *     our wiring.
   *   · **Method present, `grade: null`** — this adapter measures, and has no
   *     observations yet. A fact about the venue traffic, not about the wiring.
   *
   * Collapsing them would make "we never built grading for this venue" and "we
   * have not called this venue yet" the same reading, and only one of those is
   * fixed by waiting.
   *
   * `now` is injected for the same reason every clock in this package is: a
   * grade is a statement about a window ending at a specific instant, and a
   * function that reads the wall clock cannot be tested against a stale window.
   *
   * This door is **`rest-round-trip`**. Stream handshake is `streamLatencyGrade`.
   * The two are not interchangeable: a fast REST venue can still handshake late.
   */
  latencyGrade?(now?: Date): RestLatencyGrade;

  /**
   * This adapter's WebSocket handshake grade (`ws-round-trip`).
   *
   * Timed from immediately before `StreamPort.open` to the returned handle (or
   * a thrown open). Unopened streams stay `grade: null` — silence is not a
   * letter, and a quiet book is not a slow handshake. Depth-delta delivery lag
   * is a different number and is not this method.
   *
   * Optional for the same two-absences reason as `latencyGrade`.
   */
  streamLatencyGrade?(now?: Date): WsLatencyGrade;
}

// ════════════════════════════════════════════════════════════════════════════
// TRADING — credentials required, and the requirement is enforced
// ════════════════════════════════════════════════════════════════════════════

/** History search around a conversion claim. Times are unix milliseconds. */
export interface ClosedOrderWindow {
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly orderId?: string | null;
}

/**
 * A place-order request.
 *
 * `clientOrderId` is REQUIRED and has no default. A generated one would be
 * generated per call, and a per-call id is not an idempotency key — it is a
 * unique string that makes a retry place a second order. The caller owns the id
 * because only the caller knows which attempts are the same intent.
 */
export interface PlaceOrderRequest {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: VenueOrderType;
  readonly amount: Amount;
  /** Required on a limit order, refused on a market order. */
  readonly price?: Amount;
  readonly clientOrderId: string;
  /** True to refuse the order rather than take liquidity. */
  readonly postOnly?: boolean;
  readonly reduceOnly?: boolean;
  /**
   * Limit time in force. Absent means the venue adapter's resting default
   * (GTC). Conversion sends IOC so a price under the floor cannot rest.
   */
  readonly timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface TradeAdapter {
  readonly venue: VenueDescriptor;
  placeOrder(request: PlaceOrderRequest): Promise<VenueOrder>;
  /** By client id, not venue id — a `pending` order has no venue id to cancel by. */
  cancelOrder(symbol: string, clientOrderId: string): Promise<VenueOrder>;
  fetchOrder(symbol: string, clientOrderId: string): Promise<VenueOrder>;
  /**
   * A closed spot order, which some venues drop from the realtime list.
   * Absent on venues whose `fetchOrder` already returns closed orders.
   * `null` is a confirmed miss. Any other failure throws.
   * `window` is the claim interval a history search must cover before a miss
   * is real. Binance uses it for allOrders and myTrades.
   */
  fetchClosedOrder?(symbol: string, clientOrderId: string, window?: ClosedOrderWindow): Promise<VenueOrder | null>;
  openOrders(symbol?: string): Promise<VenueOrder[]>;
}

export interface AccountAdapter {
  readonly venue: VenueDescriptor;
  /** See `account.ts`: an OBSERVATION of a third party's records. Never a ledger input. */
  balances(): Promise<VenueBalance[]>;
  positions(): Promise<VenuePosition[]>;
  transferRails(asset: string): Promise<TransferRail[]>;
}

// ════════════════════════════════════════════════════════════════════════════
// CREDENTIALS
// ════════════════════════════════════════════════════════════════════════════

/**
 * A scope we are willing to hold a key for.
 *
 * `withdraw` is not in this union, and that is the enforcement. §27: *"connect
 * keys must be trade-only"*. Expressing the refusal as a missing union member
 * means a key with withdrawal permission cannot be described in our types at
 * all, let alone stored — and `assertTradeOnly` catches the runtime case where
 * a venue reports the permission on a key we were handed.
 */
export type VenueScope = 'read' | 'trade';

export interface VenueCredentials {
  readonly venueId: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly passphrase?: string;
  /** As reported by the venue for this key. Not as requested when it was made. */
  readonly scopes: readonly string[];
}

/**
 * `_` and `-` fold away, so `universal_transfer` and `universal-transfer` are
 * one token. A blank fold is not a scope.
 */
function foldedScope(scope: string): string {
  return scope.trim().toLowerCase().replace(/[_-]+/g, '');
}

/** After the fold, a scope means withdraw or transfer when either stem is in it. `transfers` contains `transfer`. */
function scopeMovesFunds(scope: string): boolean {
  const folded = foldedScope(scope);
  return folded.includes('withdraw') || folded.includes('transfer');
}

/**
 * Refuse a key that can move funds out of the user's venue account.
 *
 * Called at LOAD time, not at use time. A key we never accepted cannot be
 * misused by a bug we have not written yet — and by the time a withdrawal call
 * is on the stack, the safe moment has passed. An empty list, or a list of
 * blank scopes, is not trade-only: there is nothing to show the key cannot
 * withdraw.
 */
export function assertTradeOnly(credentials: VenueCredentials): void {
  const scopes = credentials.scopes;
  const blank = scopes.length === 0 || scopes.every((scope) => foldedScope(scope) === '');
  if (blank) {
    throw new VenueCredentialScopeError(
      credentials.venueId,
      scopes,
      `${credentials.venueId}: refusing a key with no scopes — ` +
        'connect keys must be trade-only (§27 Venue Vault). Re-issue the key without withdrawal rights.',
    );
  }
  const refused = scopes.filter(scopeMovesFunds);
  if (refused.length > 0) {
    throw new VenueCredentialScopeError(
      credentials.venueId,
      refused,
      `${credentials.venueId}: refusing a key with ${refused.join(', ')} permission — ` +
        'connect keys must be trade-only (§27 Venue Vault). Re-issue the key without withdrawal rights.',
    );
  }
}

/**
 * The gate every credentialed call goes through.
 *
 * Throws rather than returning `null`, and the message names the operation and
 * says what the owner has to do. The alternative — a plausible `rejected` order
 * — is the single worst failure mode available to this package: a router that
 * "tried" a venue and got a rejection routes the rest elsewhere and calls the
 * result a fill, and nothing anywhere says that no key existed.
 */
export function requireCredentials(venueId: string, operation: string, credentials: VenueCredentials | null | undefined): VenueCredentials {
  if (!credentials) {
    throw new VenueCredentialsMissingError(
      venueId,
      operation,
      `${venueId}.${operation} needs API credentials and none are configured. ` +
        'Public market data works without keys; trading and account state do not. ' +
        'The owner must issue a TRADE-ONLY key for this venue and load it through the Venue Vault (§27). ' +
        'This call is refused rather than simulated — a fabricated order status is worse than an outage.',
    );
  }
  assertTradeOnly(credentials);
  return credentials;
}
