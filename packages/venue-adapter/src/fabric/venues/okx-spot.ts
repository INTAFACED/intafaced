import { formatAmount } from '@intafaced/ledger-client/money';
import {
  readDecimal,
  readInteger,
  readLevels,
  readOptionalDecimal,
  unifiedSymbol,
  VenueCapabilityError,
  VenueUnavailableError,
  type BookSubscription,
  type MarketDataAdapter,
  type VenueBookDelta,
  type VenueBookSnapshot,
  type VenueDescriptor,
  type VenueMarket,
  type VenueTrade,
} from '@intafaced/venue-contracts';
import { AsyncFrameQueue, fetchHttpPort, webSocketStreamPort, type HttpPort, type StreamHandle, type StreamPort } from '../transport.js';
import { RateLimitGovernor, type RateLimitPolicy } from '../rate-limit.js';
import { observeStreamRoundTrip, REST_MEASUREMENT, VenueLatencyGrader, WS_MEASUREMENT } from '../latency.js';
import { assertPayoutGradeBook } from '../payout-grade.js';
import type { RestLatencyGrade, WsLatencyGrade } from '@intafaced/venue-contracts';

/**
 * OKX SPOT — the THIRD public MarketDataAdapter.
 *
 * `cross-check.ts` needs three fresh mids. Two venues leave the median
 * inconclusive. This file is the id that makes the median a check.
 *
 * OKX spot, for the same class of reasons Bybit was chosen:
 *   · Decimal STRINGS on REST and WS. `decimal.ts` refuses a JSON number.
 *   · Both halves numbered: REST `seqId`, WS `seqId`/`prevSeqId`.
 *   · Public market data needs no key.
 *   · Deltas are absolute totals with "0" as delete.
 *
 * No SDK, no ccxt. Documented public HTTP/WS through HttpPort/StreamPort.
 *
 * Where OKX differs from the first two (each is load-bearing):
 *   1. Subscribes by MESSAGE, not URL. Receive-only transport is refused.
 *   2. Heartbeat is the raw text ping, not JSON. JSON.stringify('ping') is "ping".
 *   3. Success is code: "0" (a STRING) inside HTTP 200. Rate limit is code 50011.
 *   4. Venue spelling is hyphenated — BTC-USDT, not BTCUSDT.
 *   5. books5 is snapshot-only. The WS channel is books (incremental 400-depth).
 *   6. REST depth is sz on the closed set {1,5,10,50,100,200,400}.
 *   7. A second WS action: snapshot is a feed restart — fail the subscription.
 *
 * Signed spot trade lives in `okx-spot-trade.ts` (HMAC OK-ACCESS). Signed
 * account observation lives in `okx-spot-account.ts`. transferRails stays
 * not_ready — wallet surfaces stay off trade-only keys. Fees are published
 * regular-user spot defaults and travel as indicative: true.
 */

const VENUE: VenueDescriptor = {
  id: 'okx-spot',
  displayName: 'OKX Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

const REST_BASE = 'https://www.okx.com';
const WS_BASE = 'wss://ws.okx.com:8443/ws/v5/public';

/** Documented public books limit: 10 requests / 2 seconds per IP. */
export const OKX_SPOT_RATE_LIMIT: RateLimitPolicy = {
  venueId: VENUE.id,
  capacity: 10,
  windowMs: 2_000,
};

const RATE_LIMIT_CODES = new Set(['50011']);
const DEFAULT_FEE_BPS = { maker: 8, taker: 10 } as const;
const ALLOWED_DEPTH = [1, 5, 10, 50, 100, 200, 400] as const;
const MAX_DEPTH_LIMIT = 400;
const DEFAULT_HEARTBEAT_MS = 20_000;

/** Unset / not a positive int — never invent a 100-level snapshot. */
const SNAPSHOT_BOOK_LIMIT_UNSET = 'venue.snapshot_book.limit_unset' as const;

class SnapshotBookLimitUnsetError extends Error {
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

export interface OkxSpotOptions {
  readonly http?: HttpPort;
  readonly stream?: StreamPort;
  readonly governor?: RateLimitGovernor;
  readonly grader?: VenueLatencyGrader;
  readonly wsGrader?: VenueLatencyGrader;
  readonly restBase?: string;
  readonly wsBase?: string;
  readonly clock?: () => number;
  /** Ping cadence in ms. `0` disables it — for tests only; a live socket needs it. */
  readonly heartbeatMs?: number;
}

export class OkxSpotMarketData implements MarketDataAdapter {
  readonly venue = VENUE;
  readonly governor: RateLimitGovernor;
  readonly grader: VenueLatencyGrader;
  readonly wsGrader: VenueLatencyGrader;

  readonly #http: HttpPort;
  readonly #stream: StreamPort;
  readonly #restBase: string;
  readonly #wsBase: string;
  readonly #clock: () => number;
  readonly #heartbeatMs: number;

  constructor(options: OkxSpotOptions = {}) {
    this.#http = options.http ?? fetchHttpPort();
    this.#restBase = options.restBase ?? REST_BASE;
    this.#wsBase = options.wsBase ?? WS_BASE;
    this.#clock = options.clock ?? Date.now;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.governor = options.governor ?? new RateLimitGovernor(OKX_SPOT_RATE_LIMIT, this.#clock());
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
    const data = await this.#get('/api/v5/public/instruments?instType=SPOT');
    if (!Array.isArray(data)) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'instruments carried no data array');
    }
    const observedAt = new Date(this.#clock());
    return data.map((raw) => this.#market(raw as Record<string, unknown>, observedAt));
  }

  /**
   * A full book.
   *
   * `limit` is required — omitted depth never becomes 100. Venue max 400 is a
   * cap (snapped onto the published sz set), not a default. The owner may pass
   * 100 explicitly.
   */
  async snapshotBook(symbol: string, limit?: number | null): Promise<VenueBookSnapshot> {
    const published = publishedSnapshotLimit(limit);
    if (published === undefined) {
      throw new SnapshotBookLimitUnsetError(
        SNAPSHOT_BOOK_LIMIT_UNSET,
        'snapshotBook limit is unset — caller must pass depth. Never invent 100.',
      );
    }
    const sz = capDepth(published);
    const data = await this.#get(`/api/v5/market/books?instId=${okxSymbolOf(symbol)}&sz=${sz}`);
    if (!Array.isArray(data) || data.length === 0) {
      throw new VenueUnavailableError(
        VENUE.id,
        'not_ready',
        `GET /api/v5/market/books returned code 0 with no book object — the venue declined this instrument. ` +
          'Never treated as an empty book.',
      );
    }
    const book = data[0] as Record<string, unknown>;
    return assertPayoutGradeBook({
      venueId: VENUE.id,
      symbol,
      bids: readLevels(book.bids, 'bids', VENUE.id),
      asks: readLevels(book.asks, 'asks', VENUE.id),
      sequence: readInteger(book.seqId, VENUE.id, 'books.seqId'),
      sequenced: true,
      observedAt: new Date(this.#clock()),
    });
  }

  async streamBook(symbol: string): Promise<BookSubscription> {
    const instId = okxSymbolOf(symbol);
    const { handle, stopHeartbeat } = await this.#subscribe('books', instId, 'streamBook');
    const queue = new AsyncFrameQueue<VenueBookDelta>();
    let snapshots = 0;

    void (async () => {
      try {
        for await (const raw of handle.messages) {
          if (typeof raw === 'string') continue;
          const frame = raw as Record<string, unknown>;
          const refusal = subscribeRefusal(frame);
          if (refusal) {
            queue.fail(new Error(refusedTopic(`books:${instId}`, refusal)));
            return;
          }
          if (!isChannel(frame, 'books', instId)) continue;
          if (!Array.isArray(frame.data)) continue;

          const book = firstDataObject(frame, 'books');
          if (frame.action === 'snapshot') {
            snapshots += 1;
            if (snapshots === 1) continue;
            queue.fail(
              new Error(
                `${VENUE.id} books:${instId}: the venue re-sent a full snapshot mid-stream (seqId=${String(book.seqId)}) — ` +
                  'its feed restarted and its update numbering is void. Failing the subscription so the feed is stopped ' +
                  'and reported, rather than reading the renumbered frames as already-applied and serving a frozen book.',
              ),
            );
            return;
          }
          if (frame.action !== 'update') continue;

          const sequence = readInteger(book.seqId, VENUE.id, 'books.seqId');
          queue.push({
            venueId: VENUE.id,
            symbol,
            sequence: { firstSequence: sequence, lastSequence: sequence },
            bids: wireLevels(book.bids, 'bids'),
            asks: wireLevels(book.asks, 'asks'),
            observedAt: new Date(this.#clock()),
          });
        }
        queue.close();
      } catch (error) {
        queue.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        stopHeartbeat();
      }
    })();

    return {
      deltas: queue,
      close: async () => {
        stopHeartbeat();
        queue.close();
        await handle.close();
      },
    };
  }

  async streamTrades(symbol: string): Promise<{ trades: AsyncIterable<VenueTrade>; close(): Promise<void> }> {
    const instId = okxSymbolOf(symbol);
    const { handle, stopHeartbeat } = await this.#subscribe('trades', instId, 'streamTrades');
    const queue = new AsyncFrameQueue<VenueTrade>();

    void (async () => {
      try {
        for await (const raw of handle.messages) {
          if (typeof raw === 'string') continue;
          const frame = raw as Record<string, unknown>;
          const refusal = subscribeRefusal(frame);
          if (refusal) {
            queue.fail(new Error(refusedTopic(`trades:${instId}`, refusal)));
            return;
          }
          if (!isChannel(frame, 'trades', instId)) continue;
          if (!Array.isArray(frame.data)) continue;
          for (const entry of frame.data as Record<string, unknown>[]) {
            queue.push({
              venueId: VENUE.id,
              symbol,
              tradeId: entry.tradeId === undefined || entry.tradeId === null ? null : String(entry.tradeId),
              price: readDecimal(entry.px, VENUE.id, 'trade.px'),
              amount: readDecimal(entry.sz, VENUE.id, 'trade.sz'),
              takerSide: takerSideOf(entry.side),
              tradedAt: new Date(readInteger(entry.ts, VENUE.id, 'trade.ts')),
              observedAt: new Date(this.#clock()),
            });
          }
        }
        queue.close();
      } catch (error) {
        queue.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        stopHeartbeat();
      }
    })();

    return {
      trades: queue,
      close: async () => {
        stopHeartbeat();
        queue.close();
        await handle.close();
      },
    };
  }

  async #subscribe(channel: string, instId: string, operation: string): Promise<{ handle: StreamHandle; stopHeartbeat: () => void }> {
    const handle = await this.#stream.open(this.#wsBase);
    const send = handle.send?.bind(handle);
    if (!send) {
      await handle.close();
      throw new VenueCapabilityError(
        VENUE.id,
        operation,
        `${VENUE.id}.${operation} needs a StreamPort that can SEND: this venue subscribes by message ` +
          `({"op":"subscribe","args":[{"channel":"${channel}","instId":"${instId}"}]}), not by URL. The transport ` +
          'supplied is receive-only, and a socket opened without a subscription is open, healthy and permanently ' +
          'silent — which is indistinguishable from a quiet market. Refusing instead.',
      );
    }

    await send({ op: 'subscribe', args: [{ channel, instId }] });

    let timer: ReturnType<typeof setInterval> | null = null;
    if (this.#heartbeatMs > 0) {
      timer = setInterval(() => void send('ping').catch(() => undefined), this.#heartbeatMs);
      (timer as { unref?: () => void }).unref?.();
    }

    return {
      handle,
      stopHeartbeat: () => {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };
  }

  async #get(path: string): Promise<unknown> {
    const now = this.#clock();
    const decision = this.governor.tryAcquire(1, now);
    if (!decision.admitted) {
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

    const body = response.body as Record<string, unknown>;
    if (body.code === undefined || body.code === null) {
      this.grader.observe({ roundTripMs, outcome: 'error', at: new Date(this.#clock()) });
      throw new VenueUnavailableError(VENUE.id, 'malformed', `GET ${path} answered 200 with no code`);
    }

    const code = String(body.code);
    const msg = typeof body.msg === 'string' ? body.msg : '';

    if (code !== '0') {
      if (RATE_LIMIT_CODES.has(code)) {
        const retryAfterMs = retryAfterFrom(response.header('Retry-After'));
        this.governor.observeVenueBackoff(retryAfterMs, `code ${code}`, this.#clock());
        this.grader.observe({ roundTripMs, outcome: 'reject', at: new Date(this.#clock()) });
        throw new VenueUnavailableError(
          VENUE.id,
          'rate_limited',
          `${VENUE.id} answered code ${code} (${msg}) inside an HTTP 200; backing off for ${retryAfterMs}ms`,
        );
      }
      this.grader.observe({ roundTripMs, outcome: 'reject', at: new Date(this.#clock()) });
      throw new VenueUnavailableError(
        VENUE.id,
        'not_ready',
        `GET ${path} refused: code ${code} (${msg || 'no message'}) — the venue declined this request. ` +
          'Most often an unknown or delisted symbol; never treated as an empty book.',
      );
    }

    this.grader.observe({ roundTripMs, outcome: 'ok', at: new Date(this.#clock()) });
    return body.data;
  }

  #market(raw: Record<string, unknown>, observedAt: Date): VenueMarket {
    // A blank tick, lot or minimum size is never replaced with an invented value:
    // publishing made-up limits would let an order pass checks the venue never set.
    const tickSz = readOptionalDecimal(raw.tickSz, VENUE.id, 'tickSz');
    const lotSz = readOptionalDecimal(raw.lotSz, VENUE.id, 'lotSz');
    const minSz = readOptionalDecimal(raw.minSz, VENUE.id, 'minSz');
    if (tickSz === null || tickSz === undefined || lotSz === null || lotSz === undefined || minSz === null || minSz === undefined) {
      throw new VenueUnavailableError(
        VENUE.id,
        'malformed',
        `instrument ${String(raw.instId ?? '(no instId)')} has a blank tickSz, lotSz or minSz — limits are not invented`,
      );
    }
    const base = String(raw.baseCcy ?? '');
    const quote = String(raw.quoteCcy ?? '');
    return {
      venueId: VENUE.id,
      symbol: unifiedSymbol(base, quote),
      venueSymbol: String(raw.instId ?? ''),
      type: 'spot',
      base: base.toUpperCase(),
      quote: quote.toUpperCase(),
      settle: null,
      active: raw.state === 'live',
      contractSize: null,
      expiry: null,
      precision: {
        price: tickSz,
        amount: lotSz,
      },
      limits: {
        minAmount: minSz,
        maxAmount: readOptionalDecimal(raw.maxLmtSz, VENUE.id, 'maxLmtSz'),
        minCost: 0n,
        maxLeverageBps: null,
      },
      fees: { makerBps: DEFAULT_FEE_BPS.maker, takerBps: DEFAULT_FEE_BPS.taker, indicative: true },
      observedAt,
    };
  }
}

/** BTC/USDT → BTC-USDT. Hyphenated — concatenating like the first two venues 404s. */
export function okxSymbolOf(unified: string): string {
  return unified.replace(/:/g, '-').replace(/\//g, '-').toUpperCase();
}

export function capDepth(limit: number): number {
  const n = Math.min(Math.max(1, Math.trunc(limit)), MAX_DEPTH_LIMIT);
  let chosen: (typeof ALLOWED_DEPTH)[number] = ALLOWED_DEPTH[0];
  for (const allowed of ALLOWED_DEPTH) {
    if (allowed <= n) chosen = allowed;
  }
  return chosen;
}

export function takerSideOf(raw: unknown): 'buy' | 'sell' | null {
  if (raw === 'buy') return 'buy';
  if (raw === 'sell') return 'sell';
  return null;
}

export function subscribeRefusal(frame: Record<string, unknown>): string | null {
  if (frame.event !== 'error') return null;
  const message = typeof frame.msg === 'string' && frame.msg ? frame.msg : 'subscribe refused with no message';
  const code = frame.code === undefined || frame.code === null ? '' : ` code ${String(frame.code)}`;
  return `${message}${code}`;
}

function refusedTopic(topic: string, reason: string): string {
  return (
    `${VENUE.id} refused the subscription to ${topic}: ${reason}. Failing rather than holding a silent socket ` +
    'open — an unsubscribed connection is indistinguishable from a market with no activity.'
  );
}

function isChannel(frame: Record<string, unknown>, channel: string, instId: string): boolean {
  const arg = frame.arg;
  if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) return false;
  const rec = arg as Record<string, unknown>;
  return rec.channel === channel && rec.instId === instId;
}

function firstDataObject(frame: Record<string, unknown>, channel: string): Record<string, unknown> {
  if (!Array.isArray(frame.data) || frame.data.length === 0 || frame.data[0] === null || typeof frame.data[0] !== 'object') {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `${channel} frame carried no book object`);
  }
  return frame.data[0] as Record<string, unknown>;
}

function wireLevels(raw: unknown, side: 'bids' | 'asks'): (readonly [string, string])[] {
  if (!Array.isArray(raw)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `books delta ${side} is not an array`);
  }
  return raw.map((level) => {
    if (!Array.isArray(level) || level.length < 2) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `books delta ${side} carries a malformed level`);
    }
    const price = readDecimal(level[0], VENUE.id, `${side}.price`);
    const quantity = readDecimal(level[1], VENUE.id, `${side}.quantity`);
    return [formatAmount(price), formatAmount(quantity)] as const;
  });
}

export function retryAfterFrom(header: string | null, fallbackMs = 60_000): number {
  if (!header) return fallbackMs;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.ceil(seconds * 1_000);
}

export { OkxSpotTrade, type OkxSpotTradeOptions } from './okx-spot-trade.js';
export { OkxSpotAccount } from './okx-spot-account.js';
