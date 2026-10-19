import { formatAmount } from '@intafaced/ledger-client/money';
import {
  readDecimal,
  readInteger,
  readLevels,
  unifiedSymbol,
  VenueUnavailableError,
  type BookSubscription,
  type MarketDataAdapter,
  type VenueBookDelta,
  type VenueBookSnapshot,
  type VenueDescriptor,
  type VenueMarket,
  type VenueTrade,
} from '@intafaced/venue-contracts';
import { AsyncFrameQueue, fetchHttpPort, webSocketStreamPort, type HttpPort, type StreamPort } from '../transport.js';
import { RateLimitGovernor, type RateLimitPolicy } from '../rate-limit.js';
import { observeStreamRoundTrip, REST_MEASUREMENT, VenueLatencyGrader, WS_MEASUREMENT } from '../latency.js';
import { assertPayoutGradeBook } from '../payout-grade.js';
import type { RestLatencyGrade, WsLatencyGrade } from '@intafaced/venue-contracts';
export { BinanceSpotTrade, mapBinanceSpotOrder, signBinanceQuery } from './binance-spot-trade.js';
export { BinanceSpotAccount, mapBinanceSpotBalances } from './binance-spot-account.js';

/**
 * BINANCE SPOT — the first venue in the fabric, done properly.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY ONE VENUE AND NOT SIX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six adapters that each fetch a book and normalise a symbol is a week's work
 * and proves nothing: the hard parts of §27 are the parts that only show up
 * when a venue misbehaves, and they are identical across venues. One adapter
 * that is genuinely WS-first, genuinely sequenced, genuinely gap-detected,
 * genuinely rate-governed and genuinely latency-graded establishes all of that
 * machinery; the second venue is then mostly a schema map.
 *
 * Binance first because its depth stream is the one that punishes the mistake
 * hardest — the sequence bookkeeping is entirely on the client, the ranges are
 * batched under load, and the join between the REST snapshot and the WS stream
 * has a window that a naive implementation loses updates in with no symptom.
 * An adapter that is correct here is correct nearly everywhere.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WORKS WITHOUT CREDENTIALS, AND WHAT REFUSES TO PRETEND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `BinanceSpotMarketData` is REAL and needs no keys: markets, snapshots, the
 * depth stream and the trade tape are public, and this adapter talks to the
 * actual venue.
 *
 * `BinanceSpotTrade` and `BinanceSpotAccount` need API keys the owner must
 * issue. Every method on them calls `requireCredentials` FIRST, so with no key
 * configured they throw `VenueCredentialsMissingError` naming the operation and
 * what the owner has to do. They do not return an empty array, they do not
 * return a plausible `rejected` order, and they do not route.
 *
 * With a trade-only key, signed REST is real (`binance-spot-trade.ts`,
 * `binance-spot-account.ts`). `transferRails` stays `not_ready` — wallet
 * permission is refused, not faked. `positions` on spot is `[]`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FEES ARE INDICATIVE AND SAY SO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fee schedule below is Binance's published spot default. It is marked
 * `indicative: true` because the rate an ACCOUNT actually pays depends on its
 * VIP tier and BNB discount, which need credentials to read. A route costed on
 * defaults for an account that pays more is wrong against the user, so the flag
 * travels with the number rather than being assumed away.
 */

const VENUE: VenueDescriptor = {
  id: 'binance-spot',
  displayName: 'Binance Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

const REST_BASE = 'https://api.binance.com';
const WS_BASE = 'wss://stream.binance.com:9443/ws';

/**
 * Binance publishes 6000 request-weight per minute per IP. The governor is
 * created with the default 20% headroom, so it will spend 4800 — see
 * `rate-limit.ts` for why that margin is not tuning.
 */
export const BINANCE_SPOT_RATE_LIMIT: RateLimitPolicy = {
  venueId: VENUE.id,
  capacity: 6_000,
  windowMs: 60_000,
};

/** Published spot defaults: 0.1% both sides. Account rates need a key — hence `indicative`. */
const DEFAULT_FEE_BPS = { maker: 10, taker: 10 } as const;

/** Weight the venue charges per depth limit. Counting requests instead would blow the limit. */
function depthWeight(limit: number): number {
  if (limit <= 100) return 5;
  if (limit <= 500) return 25;
  if (limit <= 1_000) return 50;
  return 250;
}

/** Unset / not a positive int — never invent a 1000-level snapshot. */
export const SNAPSHOT_BOOK_LIMIT_UNSET = 'venue.snapshot_book.limit_unset' as const;

export class SnapshotBookLimitUnsetError extends Error {
  readonly code: typeof SNAPSHOT_BOOK_LIMIT_UNSET;

  constructor(code: typeof SNAPSHOT_BOOK_LIMIT_UNSET, message: string) {
    super(message);
    this.name = 'SnapshotBookLimitUnsetError';
    this.code = code;
  }
}

function publishedSnapshotLimit(limit: number | null | undefined): number | undefined {
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? limit : undefined;
}

export interface BinanceSpotOptions {
  readonly http?: HttpPort;
  readonly stream?: StreamPort;
  readonly governor?: RateLimitGovernor;
  readonly grader?: VenueLatencyGrader;
  readonly wsGrader?: VenueLatencyGrader;
  readonly restBase?: string;
  readonly wsBase?: string;
  readonly clock?: () => number;
}

export class BinanceSpotMarketData implements MarketDataAdapter {
  readonly venue = VENUE;
  readonly governor: RateLimitGovernor;
  readonly grader: VenueLatencyGrader;
  readonly wsGrader: VenueLatencyGrader;

  readonly #http: HttpPort;
  readonly #stream: StreamPort;
  readonly #restBase: string;
  readonly #wsBase: string;
  readonly #clock: () => number;

  constructor(options: BinanceSpotOptions = {}) {
    this.#http = options.http ?? fetchHttpPort();
    this.#restBase = options.restBase ?? REST_BASE;
    this.#wsBase = options.wsBase ?? WS_BASE;
    this.#clock = options.clock ?? Date.now;
    this.governor = options.governor ?? new RateLimitGovernor(BINANCE_SPOT_RATE_LIMIT, this.#clock());
    this.grader = options.grader ?? new VenueLatencyGrader(VENUE.id);
    if (this.grader.measurement !== REST_MEASUREMENT) {
      throw new Error(`${VENUE.id} grader must measure ${REST_MEASUREMENT}, got ${this.grader.measurement}`);
    }
    this.wsGrader = options.wsGrader ?? new VenueLatencyGrader(VENUE.id, { measurement: WS_MEASUREMENT });
    if (this.wsGrader.measurement !== WS_MEASUREMENT) {
      throw new Error(`${VENUE.id} wsGrader must measure ${WS_MEASUREMENT}, got ${this.wsGrader.measurement}`);
    }
    this.#stream = observeStreamRoundTrip(options.stream ?? webSocketStreamPort(), this.wsGrader, this.#clock);
  }

  /**
   * This adapter's `rest-round-trip` grade, from the calls it has actually made.
   *
   * Every REST read goes through `#get`, which records an observation on all
   * four of its exits (ok / 429-reject / non-2xx / unreachable), so this is a
   * measurement of real traffic and not a self-report. Before the first call it
   * is UNGRADED — `grade: null`, not `'F'` — because we have not measured this
   * venue, which is a different fact from having measured it and found it bad.
   *
   * Declared on `MarketDataAdapter` so a consumer holding the interface can read
   * it; see that contract for why it is optional there.
   */
  latencyGrade(now: Date = new Date(this.#clock())): RestLatencyGrade {
    return this.grader.grade(now) as RestLatencyGrade;
  }

  /**
   * WebSocket handshake grade. Timed on `StreamPort.open`, not on REST, and not
   * on first-frame silence. Unopened streams stay `grade: null`.
   */
  streamLatencyGrade(now: Date = new Date(this.#clock())): WsLatencyGrade {
    return this.wsGrader.grade(now) as WsLatencyGrade;
  }

  async markets(): Promise<VenueMarket[]> {
    const body = await this.#get('/api/v3/exchangeInfo', 20);
    const symbols = (body as { symbols?: unknown }).symbols;
    if (!Array.isArray(symbols)) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'exchangeInfo carried no symbols array');
    }
    const observedAt = new Date(this.#clock());
    const published: VenueMarket[] = [];
    let refused: VenueUnavailableError | undefined;
    for (const raw of symbols) {
      try {
        published.push(this.#market(raw as Record<string, unknown>, observedAt));
      } catch (error) {
        // A blank filter is refused for that symbol. Leaving it out keeps the
        // symbols that published real filters. Throw only when publishing the
        // rest would mean inventing a tick or a zero minimum — here, when
        // nothing left is publishable.
        if (error instanceof VenueUnavailableError) {
          refused = error;
          continue;
        }
        throw error;
      }
    }
    if (published.length === 0 && refused) throw refused;
    return published;
  }

  /**
   * A full book.
   *
   * `limit` is required — omitted depth never becomes 1000. Venue max 5000 is a
   * cap (an over-limit request is rejected AFTER the weight has been spent),
   * not a default. The owner may pass 1000 explicitly.
   */
  async snapshotBook(symbol: string, limit?: number | null): Promise<VenueBookSnapshot> {
    const published = publishedSnapshotLimit(limit);
    if (published === undefined) {
      throw new SnapshotBookLimitUnsetError(
        SNAPSHOT_BOOK_LIMIT_UNSET,
        'snapshotBook limit is unset — caller must pass depth. Never invent 1000.',
      );
    }
    const capped = Math.min(published, 5_000);
    const body = (await this.#get(`/api/v3/depth?symbol=${venueSymbolOf(symbol)}&limit=${capped}`, depthWeight(capped))) as Record<
      string,
      unknown
    >;

    // D26-P1-T8: a two-sided dust book is refused here, not only in svc-trade's
    // mark gate. Empty / one-sided still pass through as honest absence.
    return assertPayoutGradeBook({
      venueId: VENUE.id,
      symbol,
      bids: readLevels(body.bids, 'bids', VENUE.id),
      asks: readLevels(body.asks, 'asks', VENUE.id),
      sequence: readInteger(body.lastUpdateId, VENUE.id, 'lastUpdateId'),
      sequenced: true,
      // Our clock at the moment the read finished. A venue that has silently
      // stopped updating still returns a plausible timestamp of its own.
      observedAt: new Date(this.#clock()),
    });
  }

  /**
   * The depth stream, at Binance's 100ms cadence.
   *
   * The caller must open this BEFORE taking the seeding snapshot and buffer what
   * arrives — `SequencedBookTracker` does exactly that. Doing it the other way
   * round loses updates in the window between the two with no sequence
   * discontinuity to prove it, which is the one gap a gap detector cannot see.
   */
  async streamBook(symbol: string): Promise<BookSubscription> {
    const venueSymbol = venueSymbolOf(symbol).toLowerCase();
    const handle = await this.#stream.open(`${this.#wsBase}/${venueSymbol}@depth@100ms`);
    const queue = new AsyncFrameQueue<VenueBookDelta>();

    void (async () => {
      try {
        for await (const frame of handle.messages) {
          const event = frame as Record<string, unknown>;
          if (event.e !== 'depthUpdate') continue;
          queue.push({
            venueId: VENUE.id,
            symbol,
            sequence: {
              // `U`/`u` — the range this frame covers. Binance batches under
              // load; treating `u` as the only sequence would read every batched
              // frame as a gap and resnapshot forever.
              firstSequence: readInteger(event.U, VENUE.id, 'U'),
              lastSequence: readInteger(event.u, VENUE.id, 'u'),
            },
            bids: wireLevels(event.b, 'bids'),
            asks: wireLevels(event.a, 'asks'),
            observedAt: new Date(this.#clock()),
          });
        }
        queue.close();
      } catch (error) {
        queue.fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return {
      deltas: queue,
      close: async () => {
        queue.close();
        await handle.close();
      },
    };
  }

  async streamTrades(symbol: string): Promise<{ trades: AsyncIterable<VenueTrade>; close(): Promise<void> }> {
    const venueSymbol = venueSymbolOf(symbol).toLowerCase();
    const handle = await this.#stream.open(`${this.#wsBase}/${venueSymbol}@trade`);
    const queue = new AsyncFrameQueue<VenueTrade>();

    void (async () => {
      try {
        for await (const frame of handle.messages) {
          const event = frame as Record<string, unknown>;
          if (event.e !== 'trade') continue;
          queue.push({
            venueId: VENUE.id,
            symbol,
            tradeId: event.t === undefined || event.t === null ? null : String(event.t),
            price: readDecimal(event.p, VENUE.id, 'trade.price'),
            amount: readDecimal(event.q, VENUE.id, 'trade.quantity'),
            // `m` is "buyer is the maker", so the AGGRESSOR is the seller.
            // Getting this backwards inverts every volume-side signal built on it.
            takerSide: typeof event.m === 'boolean' ? (event.m ? 'sell' : 'buy') : null,
            tradedAt: new Date(readInteger(event.T, VENUE.id, 'trade.time')),
            observedAt: new Date(this.#clock()),
          });
        }
        queue.close();
      } catch (error) {
        queue.fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return {
      trades: queue,
      close: async () => {
        queue.close();
        await handle.close();
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * Every REST read goes through here: governor first, then timed, then the
   * venue's own verdict fed back into the governor.
   *
   * The order matters. Asking the governor AFTER the request would be a
   * governor that only ever reports how badly we have already overspent.
   */
  async #get(path: string, weight: number): Promise<unknown> {
    const now = this.#clock();
    const decision = this.governor.tryAcquire(weight, now);
    if (!decision.admitted) {
      // Excluded and reported, never a silent wait. The caller decides whether
      // it can afford to come back at `retryAfterMs`.
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${decision.detail} (retry in ${decision.retryAfterMs}ms)`);
    }

    const started = this.#clock();
    let response;
    try {
      response = await this.#http.get(`${this.#restBase}${path}`);
    } catch (error) {
      this.grader.observe({ roundTripMs: this.#clock() - started, outcome: 'error', at: new Date(this.#clock()) });
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `GET ${path} failed: ${String(error)}`);
    }

    const roundTripMs = this.#clock() - started;

    if (response.status === 429 || response.status === 418) {
      // The venue has just proven our model of its limit wrong. Believe it over
      // our arithmetic — continuing to spend tokens we think we have is how a
      // soft limit becomes a ban.
      const retryAfterMs = retryAfterFrom(response.header('Retry-After'));
      this.governor.observeVenueBackoff(retryAfterMs, `HTTP ${response.status}`, this.#clock());
      this.grader.observe({ roundTripMs, outcome: 'reject', at: new Date(this.#clock()) });
      throw new VenueUnavailableError(
        VENUE.id,
        'rate_limited',
        `${VENUE.id} answered ${response.status}; backing off for ${retryAfterMs}ms`,
      );
    }

    if (response.status < 200 || response.status >= 300 || response.body === null) {
      this.grader.observe({ roundTripMs, outcome: 'error', at: new Date(this.#clock()) });
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `GET ${path} answered ${response.status}`);
    }

    this.grader.observe({ roundTripMs, outcome: 'ok', at: new Date(this.#clock()) });
    return response.body;
  }

  #market(raw: Record<string, unknown>, observedAt: Date): VenueMarket {
    const base = String(raw.baseAsset ?? '');
    const quote = String(raw.quoteAsset ?? '');
    const filters = Array.isArray(raw.filters) ? (raw.filters as Record<string, unknown>[]) : [];
    const filterOf = (type: string) => filters.find((f) => f.filterType === type);

    const priceFilter = filterOf('PRICE_FILTER');
    const lotSize = filterOf('LOT_SIZE');
    const notional = filterOf('NOTIONAL') ?? filterOf('MIN_NOTIONAL');
    if (!priceFilter || !lotSize || !notional) {
      const missing = [priceFilter ? null : 'PRICE_FILTER', lotSize ? null : 'LOT_SIZE', notional ? null : 'NOTIONAL/MIN_NOTIONAL'].filter(
        (name): name is string => name !== null,
      );
      const venueSymbol = String(raw.symbol ?? '');
      throw new VenueUnavailableError(
        VENUE.id,
        'malformed',
        `${venueSymbol || 'symbol'} is missing ${missing.join(', ')} (status ${String(raw.status ?? '')}). Refusing the symbol rather than inventing a tick, a step, or a zero minimum.`,
      );
    }

    return {
      venueId: VENUE.id,
      symbol: unifiedSymbol(base, quote),
      venueSymbol: String(raw.symbol ?? ''),
      type: 'spot',
      base: base.toUpperCase(),
      quote: quote.toUpperCase(),
      settle: null,
      active: raw.status === 'TRADING',
      contractSize: null,
      expiry: null,
      precision: {
        // A TICK, not a decimal count — see `market.ts`. Binance publishes the
        // tick directly, which is the only reason a count model ever looked
        // adequate: it happens to be a power of ten here and is not elsewhere.
        price: readDecimal(priceFilter.tickSize, VENUE.id, 'tickSize'),
        amount: readDecimal(lotSize.stepSize, VENUE.id, 'stepSize'),
      },
      limits: {
        minAmount: readDecimal(lotSize.minQty, VENUE.id, 'minQty'),
        maxAmount: readDecimal(lotSize.maxQty, VENUE.id, 'maxQty'),
        minCost: readDecimal(notional.minNotional, VENUE.id, 'minNotional'),
        maxLeverageBps: null,
      },
      fees: { makerBps: DEFAULT_FEE_BPS.maker, takerBps: DEFAULT_FEE_BPS.taker, indicative: true },
      observedAt,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────

/** `BTC/USDT` → `BTCUSDT`. The venue's spelling is used when talking TO it, and nowhere else. */
export function venueSymbolOf(unified: string): string {
  return unified.replace(/[/:]/g, '').toUpperCase();
}

/**
 * Wire levels from a delta, kept as strings and kept complete.
 *
 * Zero quantities are PRESERVED here, unlike `readLevels`: in a snapshot a zero
 * level is noise, in a delta it is the only encoding of removal, and dropping
 * one leaves phantom liquidity in the book forever. The tracker validates and
 * canonicalises them.
 */
function wireLevels(raw: unknown, side: 'bids' | 'asks'): (readonly [string, string])[] {
  if (!Array.isArray(raw)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `depthUpdate ${side} is not an array`);
  }
  return raw.map((level) => {
    if (!Array.isArray(level) || level.length < 2) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `depthUpdate ${side} carries a malformed level`);
    }
    // Read them to prove they are decimal strings, then emit the canonical form.
    const price = readDecimal(level[0], VENUE.id, `${side}.price`);
    const quantity = readDecimal(level[1], VENUE.id, `${side}.quantity`);
    return [formatAmount(price), formatAmount(quantity)] as const;
  });
}

/**
 * `Retry-After` → ms, with a floor.
 *
 * The floor is the point: a venue that answers 429 with no header, or with a
 * header we cannot parse, has still told us to stop. Defaulting to zero would
 * mean the backoff we just set expires immediately and we go straight back into
 * the limit that produced it.
 */
export function retryAfterFrom(header: string | null, fallbackMs = 60_000): number {
  if (!header) return fallbackMs;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.ceil(seconds * 1_000);
}
