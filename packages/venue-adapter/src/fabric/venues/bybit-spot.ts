import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
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
 * BYBIT SPOT — the SECOND venue, and the first thing that makes grading mean
 * anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A SECOND VENUE AT ALL, AND WHY THIS ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `latency.ts` claims §27's *"every adapter continuously scored … feeding
 * execution routing weights live"*, and `cross-check.ts` claims a median across
 * venues catches the venue that is fresh, sequenced and simply WRONG. Neither
 * claim can be true with one adapter: a grade with nothing to rank against is a
 * number, and a median of one is that one venue's opinion of itself. So the
 * second adapter is not "more coverage" — it is the thing that turns two
 * already-written mechanisms from plausible into checkable.
 *
 * Bybit spot, specifically, for four reasons that are properties of its API
 * rather than preferences:
 *
 *   · **Everything on the wire is a decimal STRING** — book levels, sizes, trade
 *     prints, tick sizes, order minimums — on REST *and* on the websocket. That
 *     matters more than it sounds. `decimal.ts` REFUSES a JSON number, correctly,
 *     and several otherwise-excellent public feeds publish floats in their depth
 *     stream, which would leave `streamBook` able only to throw. A venue whose
 *     own encoding already agrees with Doctrine 5 is a venue we can read without
 *     negotiating with it.
 *   · **Its REST book carries an update id (`u`), and so do its websocket
 *     frames.** That is what lets the EXISTING `SequencedBookTracker` and
 *     `MaintainedBook` drive this adapter unchanged — subscribe, buffer,
 *     snapshot, join, gap-detect — instead of a second, parallel book path with
 *     its own bugs. Venues that number only their stream (or only publish a
 *     checksum) cannot be joined to a REST snapshot at all, and would have
 *     forced either a second book implementation or an honest `sequenced: false`
 *     that made this venue useless for cross-checking Binance.
 *   · **Public market data needs no key**, so the whole of this file is
 *     verifiable against the real venue by anyone with egress — and none of it
 *     touches a credential.
 *   · **Its depth deltas are absolute totals with `"0"` as the only encoding of
 *     removal**, which is already the `VenueBookDelta` contract. No translation,
 *     so nothing to get subtly wrong.
 *
 * No SDK, no `ccxt`, no `bybit-api` package: §27 forbids a third-party
 * connectivity library in the money path, and this file talks to the documented
 * public HTTP and WS surface through the same `HttpPort`/`StreamPort` seam the
 * first venue uses.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE BYBIT DIFFERS FROM BINANCE, AND WHY EACH DIFFERENCE IS LOAD-BEARING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These are not cosmetic. Each one is a way the Binance-shaped assumption would
 * have failed silently here:
 *
 *   1. **It subscribes by MESSAGE, not by URL.** Binance encodes the stream in
 *      the path and never speaks; Bybit opens one socket and sends
 *      `{"op":"subscribe","args":[…]}`. A socket we opened and never subscribed
 *      on is open, healthy and permanently silent — identical, in every metric
 *      here, to a quiet market. Hence `StreamHandle.send`, and hence the loud
 *      refusal below when a transport cannot provide it.
 *   2. **It requires a heartbeat.** The docs say ping every 20 seconds. Without
 *      it the venue closes the connection, which this fabric would read as the
 *      venue going away — an outage we caused.
 *   3. **It reports rate limiting inside a `200`.** `retCode` 10006/10018 in an
 *      otherwise successful HTTP response. An adapter that only inspected the
 *      status line would keep asking and get IP-banned.
 *   4. **There is no `Retry-After`.** Binance tells us when to come back; Bybit
 *      answers `403 access too frequent` and its documentation says to stop and
 *      wait *at least ten minutes*. So the backoff here is a documented floor
 *      rather than a parsed header — see `BYBIT_IP_BACKOFF_MS`.
 *   5. **A partial subscribe rejection arrives with `success: true`.** The
 *      rejected topics are in `data.failTopics`. Checking `success` alone — the
 *      obvious reading — would leave us waiting forever on a topic the venue
 *      already refused. See `subscribeRefusal`.
 *   6. **`orderbook.1` on spot is snapshot-only**, so it cannot be used as a
 *      delta feed at all, and only the 1000-level stream shares the REST `u` numbering, so the stream is that tier (`WS_DEPTH`).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRADING / ACCOUNT — signed, observation-only balances
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Signed place/cancel/fetch lives in `bybit-spot-trade.ts`. Signed SPOT wallet
 * observation lives in `bybit-spot-account.ts`. transferRails stays not_ready.
 * No live key is invented. Public market data still needs none.
 *
 * The fee schedule is Bybit's published non-VIP spot default and is marked
 * `indicative: true` for the reason `market.ts` gives: the rate an ACCOUNT pays
 * depends on its VIP tier, which needs a key to read, and a route costed on
 * defaults for an account that pays more is wrong against the user.
 */

const VENUE: VenueDescriptor = {
  id: 'bybit-spot',
  displayName: 'Bybit Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

const REST_BASE = 'https://api.bybit.com';
const WS_BASE = 'wss://stream.bybit.com/v5/public/spot';

/**
 * Bybit publishes a flat 600 requests per 5-second window per IP for its public
 * surface, and counts REQUESTS rather than weight — a 1000-level book costs the
 * same as a one-level one.
 *
 * So there is no `depthWeight` equivalent here, and its absence is deliberate:
 * inventing a weight curve would be modelling a limit the venue does not
 * publish, and a governor tuned to a fiction is a governor that is confidently
 * wrong in whichever direction the fiction leans.
 *
 * Created with the default 20% headroom, so it will spend 480 of the 600 — see
 * `rate-limit.ts` for why that margin is not tuning.
 */
export const BYBIT_SPOT_RATE_LIMIT: RateLimitPolicy = {
  venueId: VENUE.id,
  capacity: 600,
  windowMs: 5_000,
};

/**
 * How long to stand down when Bybit says we are asking too often.
 *
 * TEN MINUTES, from the venue's own documentation: *"terminate all HTTP sessions
 * and wait for at least 10 minutes"*. Unlike Binance there is no `Retry-After`
 * to read, so there is nothing to parse and nothing to shorten it with.
 *
 * Erring long is the cheap direction. Ten minutes of a venue excluded and
 * reported costs us one venue's contribution to a median; coming back early
 * against an IP ban costs us the venue entirely, at the moment we are already in
 * trouble.
 */
export const BYBIT_IP_BACKOFF_MS = 600_000;

/**
 * `retCode`s that mean "you are asking too often", inside an HTTP 200.
 *
 * 10006 — too many visits, endpoint rate limit. 10018 — IP rate limit exceeded.
 * Both are the venue overruling our arithmetic, exactly as a 429 is, and both
 * arrive in a response the status line calls a success.
 */
const RATE_LIMIT_RET_CODES = new Set([10_006, 10_018]);

/** Published non-VIP spot defaults: 0.1% both sides. Account rates need a key — hence `indicative`. */
const DEFAULT_FEE_BPS = { maker: 10, taker: 10 } as const;

/**
 * Spot's own ceiling on `limit`. Requests past it are rejected AFTER the request
 * has been counted against the IP limit, so a typo would cost us a slot and
 * return nothing — the same argument as Binance's cap.
 */
const MAX_DEPTH_LIMIT = 1_000;

/** Unset / not a positive int — never invent a 200-level snapshot. */
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

/**
 * Websocket depth tier. Spot offers 1, 50, 200 and 1000; only 1000 is used.
 *
 * Bybit documents the REST orderbook `u` as corresponding to `u` in the
 * 1000-level stream ("Get Orderbook", spot). The tracker joins the REST snapshot
 * to the stream by that number, so any other tier compares two different
 * numberings and can report `live` on a book that was never joined. `orderbook.1`
 * is also snapshot-only on spot and would never emit a delta.
 */
const WS_DEPTH = 1_000;

/** The venue closes a connection it has not heard from. Its docs say every 20s. */
const DEFAULT_HEARTBEAT_MS = 20_000;

export interface BybitSpotOptions {
  readonly http?: HttpPort;
  readonly stream?: StreamPort;
  readonly governor?: RateLimitGovernor;
  readonly grader?: VenueLatencyGrader;
  readonly wsGrader?: VenueLatencyGrader;
  readonly restBase?: string;
  readonly wsBase?: string;
  readonly clock?: () => number;
  /** Websocket depth tier. Only 1000 joins the REST snapshot's `u`; anything else is refused, see `WS_DEPTH`. */
  readonly wsDepth?: 1_000;
  /** Ping cadence in ms. `0` disables it — for tests only; a live socket needs it. */
  readonly heartbeatMs?: number;
}

export class BybitSpotMarketData implements MarketDataAdapter {
  readonly venue = VENUE;
  readonly governor: RateLimitGovernor;
  readonly grader: VenueLatencyGrader;
  readonly wsGrader: VenueLatencyGrader;

  readonly #http: HttpPort;
  readonly #stream: StreamPort;
  readonly #restBase: string;
  readonly #wsBase: string;
  readonly #clock: () => number;
  readonly #wsDepth: number;
  readonly #heartbeatMs: number;

  constructor(options: BybitSpotOptions = {}) {
    this.#http = options.http ?? fetchHttpPort();
    this.#restBase = options.restBase ?? REST_BASE;
    this.#wsBase = options.wsBase ?? WS_BASE;
    this.#clock = options.clock ?? Date.now;
    this.#wsDepth = options.wsDepth ?? WS_DEPTH;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.governor = options.governor ?? new RateLimitGovernor(BYBIT_SPOT_RATE_LIMIT, this.#clock());
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
   * Bybit's grade is the one that makes grading mean anything: with a single
   * venue a grade has no peer to be compared against, and #1148 landed this
   * adapter for exactly that reason. Before the first call it is UNGRADED —
   * `grade: null`, not `'F'` — because "we have not called Bybit" and "Bybit is
   * slow" are different facts with different fixes.
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

  /**
   * Every spot instrument, normalised.
   *
   * Spot is documented as UNPAGINATED, and this method relies on that. It also
   * checks it — see the `nextPageCursor` refusal, which is the difference between
   * relying on a documented fact and assuming one.
   */
  async markets(): Promise<VenueMarket[]> {
    const result = await this.#get('/v5/market/instruments-info?category=spot');
    const list = (result as { list?: unknown }).list;
    if (!Array.isArray(list)) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'instruments-info carried no list array');
    }

    const cursor = (result as { nextPageCursor?: unknown }).nextPageCursor;
    if (typeof cursor === 'string' && cursor.trim() !== '') {
      // Spot does not paginate today. If it starts, this list is a PAGE, and a
      // page returned as the universe reads as a mass delisting: every market
      // past the cut looks absent rather than unread. Refusing beats returning a
      // partial universe that nothing downstream can tell from a complete one.
      throw new VenueUnavailableError(
        VENUE.id,
        'malformed',
        `instruments-info returned a pagination cursor ("${cursor}") — spot is documented as unpaginated, so this ` +
          'market list is TRUNCATED. Refusing rather than reporting a page as the whole universe.',
      );
    }

    const observedAt = new Date(this.#clock());
    return list.map((raw) => this.#market(raw as Record<string, unknown>, observedAt));
  }

  /**
   * A full book, with the venue's update id so it can be joined to the stream.
   *
   * `limit` is required — omitted depth never becomes 200. Venue max 1000 is a
   * cap (an over-limit request is rejected AFTER the slot has been spent), not
   * a default. The owner may pass 200 explicitly.
   */
  async snapshotBook(symbol: string, limit?: number | null): Promise<VenueBookSnapshot> {
    const published = publishedSnapshotLimit(limit);
    if (published === undefined) {
      throw new SnapshotBookLimitUnsetError(
        SNAPSHOT_BOOK_LIMIT_UNSET,
        'snapshotBook limit is unset — caller must pass depth. Never invent 200.',
      );
    }
    const capped = Math.min(published, MAX_DEPTH_LIMIT);
    const result = (await this.#get(`/v5/market/orderbook?category=spot&symbol=${bybitSymbolOf(symbol)}&limit=${capped}`)) as Record<
      string,
      unknown
    >;

    // D26-P1-T8: a two-sided dust book is refused here, not only in svc-trade's
    // mark gate. Empty / one-sided still pass through as honest absence.
    return assertPayoutGradeBook({
      venueId: VENUE.id,
      symbol,
      bids: readLevels(result.b, 'bids', VENUE.id),
      asks: readLevels(result.a, 'asks', VENUE.id),
      // `u`, the update id — the field that makes the join arithmetic possible.
      // NOT `seq`, which Bybit documents as a cross-topic ordering hint rather
      // than a per-book counter, and which therefore cannot be checked for gaps.
      sequence: readInteger(result.u, VENUE.id, 'orderbook.u'),
      sequenced: true,
      // Our clock at the moment the read finished. `ts` and `cts` are the venue's
      // own, and a venue that has silently stopped updating still returns a
      // plausible timestamp of its own.
      observedAt: new Date(this.#clock()),
    });
  }

  /**
   * The depth stream.
   *
   * Opened BEFORE the seeding snapshot and buffered by `SequencedBookTracker`,
   * for the reason `book-feed.ts` argues at length.
   *
   * The venue's own first frame is a full `snapshot`, and it is SKIPPED rather
   * than emitted: a `VenueBookDelta` carries absolute totals and cannot express
   * "every level not mentioned is gone", so replaying a full book as a delta
   * would leave every stale level behind it in place. The REST snapshot seeds the
   * tracker; the join condition then reconciles the two, whichever is ahead.
   *
   * A SECOND snapshot frame is the venue telling us it restarted its feed (the
   * documented `u = 1` case). Its numbering is void from that point, so the
   * subscription FAILS. That is deliberately louder than it looks: a restarted
   * feed whose sequence has gone backwards makes the tracker read every following
   * frame as `already-applied`, which freezes the book at the last good sequence
   * while every status field still says `live`. Failing hands `MaintainedBook` a
   * stopped feed — excluded and reported — instead of a frozen book that looks
   * healthy.
   */
  async streamBook(symbol: string): Promise<BookSubscription> {
    if (this.#wsDepth !== WS_DEPTH) {
      throw new VenueUnavailableError(
        VENUE.id,
        'not_ready',
        `streamBook needs the ${WS_DEPTH}-level stream: the REST snapshot's update id is numbered against it, ` +
          `so a ${this.#wsDepth}-level stream cannot be joined.`,
      );
    }
    const topic = `orderbook.${this.#wsDepth}.${bybitSymbolOf(symbol)}`;
    const { handle, stopHeartbeat } = await this.#subscribe(topic, 'streamBook');
    const queue = new AsyncFrameQueue<VenueBookDelta>();
    let snapshots = 0;

    void (async () => {
      try {
        for await (const raw of handle.messages) {
          const frame = raw as Record<string, unknown>;

          const refusal = subscribeRefusal(frame, topic);
          if (refusal) {
            queue.fail(new Error(refusedTopic(topic, refusal)));
            return;
          }
          if (frame.topic !== topic) continue;

          const data = frame.data;
          if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            queue.fail(new Error(`${VENUE.id} ${topic}: frame carried no orderbook object`));
            return;
          }

          if (frame.type === 'snapshot') {
            snapshots += 1;
            if (snapshots === 1) continue;
            queue.fail(
              new Error(
                `${VENUE.id} ${topic}: the venue re-sent a full snapshot mid-stream (u=${String(
                  (data as Record<string, unknown>).u,
                )}) — its feed restarted and its update numbering is void. Failing the subscription so the ` +
                  'feed is stopped and reported, rather than reading the renumbered frames as already-applied ' +
                  'and serving a frozen book that still reports itself live.',
              ),
            );
            return;
          }
          if (frame.type !== 'delta') continue;

          const book = data as Record<string, unknown>;
          // Bybit numbers each frame individually and publishes no coalesced
          // range, so the range collapses to a point. That is honest rather than
          // lossy: with `first === last`, the tracker's `firstSequence > current + 1`
          // gap rule reads as exactly "a message was missed".
          const sequence = readInteger(book.u, VENUE.id, 'orderbook.u');
          queue.push({
            venueId: VENUE.id,
            symbol,
            sequence: { firstSequence: sequence, lastSequence: sequence },
            bids: wireLevels(book.b, 'bids'),
            asks: wireLevels(book.a, 'asks'),
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

  /**
   * The public trade tape.
   *
   * `S` is documented as the side of the TAKER, so it is read straight through.
   * Worth stating because the first venue's equivalent (`m`, "buyer is the
   * maker") has to be inverted, and a copy-paste between the two would flip
   * every volume-side signal built on the tape with no error anywhere.
   *
   * `data` is an ARRAY here — one frame carries several prints.
   */
  async streamTrades(symbol: string): Promise<{ trades: AsyncIterable<VenueTrade>; close(): Promise<void> }> {
    const topic = `publicTrade.${bybitSymbolOf(symbol)}`;
    const { handle, stopHeartbeat } = await this.#subscribe(topic, 'streamTrades');
    const queue = new AsyncFrameQueue<VenueTrade>();

    void (async () => {
      try {
        for await (const raw of handle.messages) {
          const frame = raw as Record<string, unknown>;

          const refusal = subscribeRefusal(frame, topic);
          if (refusal) {
            queue.fail(new Error(refusedTopic(topic, refusal)));
            return;
          }
          if (frame.topic !== topic) continue;
          if (!Array.isArray(frame.data)) {
            queue.fail(new Error(`${VENUE.id} ${topic}: frame carried no trade array`));
            return;
          }

          for (const entry of frame.data as Record<string, unknown>[]) {
            queue.push({
              venueId: VENUE.id,
              symbol,
              tradeId: entry.i === undefined || entry.i === null ? null : String(entry.i),
              price: readDecimal(entry.p, VENUE.id, 'trade.price'),
              amount: readDecimal(entry.v, VENUE.id, 'trade.size'),
              takerSide: takerSideOf(entry.S),
              tradedAt: new Date(readInteger(entry.T, VENUE.id, 'trade.time')),
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

  // ────────────────────────────────────────────────────────────────────────

  /**
   * Open the socket, subscribe, and start the heartbeat.
   *
   * The `send` check is the whole reason this is a method rather than three lines
   * inlined twice. A transport that cannot speak cannot subscribe, and a
   * subscription that never went out produces a socket that is open and silent —
   * so the refusal is loud and names the capability, rather than returning a
   * subscription that will never yield a frame.
   */
  async #subscribe(topic: string, operation: string): Promise<{ handle: StreamHandle; stopHeartbeat: () => void }> {
    const handle = await this.#stream.open(this.#wsBase);
    const send = handle.send?.bind(handle);
    if (!send) {
      await handle.close();
      throw new VenueCapabilityError(
        VENUE.id,
        operation,
        `${VENUE.id}.${operation} needs a StreamPort that can SEND: this venue subscribes by message ` +
          `({"op":"subscribe","args":["${topic}"]}), not by URL. The transport supplied is receive-only, and a ` +
          'socket opened without a subscription is open, healthy and permanently silent — which is ' +
          'indistinguishable from a quiet market. Refusing instead.',
      );
    }

    await send({ op: 'subscribe', args: [topic] });

    // The venue closes a connection it has not heard from. Left out, the fabric
    // would read our own missing heartbeat as the venue going away.
    let timer: ReturnType<typeof setInterval> | null = null;
    if (this.#heartbeatMs > 0) {
      timer = setInterval(() => void send({ op: 'ping' }).catch(() => undefined), this.#heartbeatMs);
      // Never hold the process open for a heartbeat.
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

  /**
   * Every REST read: governor first, then timed, then the venue's own verdict fed
   * back into the governor.
   *
   * The order matters for the reason `binance-spot.ts` states — asking the
   * governor afterwards is a governor that only reports how badly we have already
   * overspent. What is different here is that the venue's verdict is in TWO
   * places, the status line and `retCode`, and only checking the first is how a
   * 200 walks us into an IP ban.
   */
  async #get(path: string): Promise<unknown> {
    const now = this.#clock();
    // One slot per request: Bybit's public limit counts requests, not weight.
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

    // 403 is Bybit's IP-limit answer ("access too frequent"); 429 is what a proxy
    // or edge in front of it may answer instead. Either way we have been told to
    // stop, and there is no header to tell us for how long.
    if (response.status === 403 || response.status === 429) {
      this.#backOff(`HTTP ${response.status}`, roundTripMs);
      throw new VenueUnavailableError(
        VENUE.id,
        'rate_limited',
        `${VENUE.id} answered ${response.status} (access too frequent); backing off for ${BYBIT_IP_BACKOFF_MS}ms — ` +
          'the venue publishes no Retry-After, so this is its documented ten-minute floor, not a guess.',
      );
    }

    if (response.status < 200 || response.status >= 300 || response.body === null) {
      this.grader.observe({ roundTripMs, outcome: 'error', at: new Date(this.#clock()) });
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `GET ${path} answered ${response.status}`);
    }

    const body = response.body as Record<string, unknown>;
    if (typeof body.retCode !== 'number') {
      this.grader.observe({ roundTripMs, outcome: 'error', at: new Date(this.#clock()) });
      throw new VenueUnavailableError(VENUE.id, 'malformed', `GET ${path} answered 200 with no numeric retCode`);
    }

    const retCode = body.retCode;
    const retMsg = typeof body.retMsg === 'string' ? body.retMsg : '';

    if (retCode !== 0) {
      if (RATE_LIMIT_RET_CODES.has(retCode)) {
        // The venue has just proven our model of its limit wrong, in a response
        // the status line calls a success. Believe it over our arithmetic.
        this.#backOff(`retCode ${retCode}`, roundTripMs);
        throw new VenueUnavailableError(
          VENUE.id,
          'rate_limited',
          `${VENUE.id} answered retCode ${retCode} (${retMsg}) inside an HTTP 200; backing off for ${BYBIT_IP_BACKOFF_MS}ms`,
        );
      }

      // A REJECT, not an error: the venue answered promptly and declined the
      // request. That is what `latency.ts` grades separately from a failure, and
      // an unknown symbol scored as an outage would blame the venue for our typo.
      this.grader.observe({ roundTripMs, outcome: 'reject', at: new Date(this.#clock()) });
      // `not_ready` rather than `malformed`: the payload is well-formed and the
      // venue is fine — it is declining to serve THIS instrument, which is what
      // an unknown or delisted symbol looks like. The exclusion vocabulary in
      // `errors.ts` is shared across every venue and is deliberately not widened
      // here for one venue's error taxonomy; the code and message carry the rest.
      throw new VenueUnavailableError(
        VENUE.id,
        'not_ready',
        `GET ${path} refused: retCode ${retCode} (${retMsg || 'no message'}) — the venue declined this request. ` +
          'Most often an unknown or delisted symbol; never treated as an empty book.',
      );
    }

    const result = body.result;
    if (result === null || typeof result !== 'object') {
      this.grader.observe({ roundTripMs, outcome: 'error', at: new Date(this.#clock()) });
      throw new VenueUnavailableError(VENUE.id, 'malformed', `GET ${path} answered retCode 0 with no result object`);
    }

    this.grader.observe({ roundTripMs, outcome: 'ok', at: new Date(this.#clock()) });
    return result;
  }

  #backOff(reason: string, roundTripMs: number): void {
    this.governor.observeVenueBackoff(BYBIT_IP_BACKOFF_MS, reason, this.#clock());
    this.grader.observe({ roundTripMs, outcome: 'reject', at: new Date(this.#clock()) });
  }

  #market(raw: Record<string, unknown>, observedAt: Date): VenueMarket {
    const base = String(raw.baseCoin ?? '');
    const quote = String(raw.quoteCoin ?? '');
    const lot = (raw.lotSizeFilter ?? {}) as Record<string, unknown>;
    const price = (raw.priceFilter ?? {}) as Record<string, unknown>;

    return {
      venueId: VENUE.id,
      symbol: unifiedSymbol(base, quote),
      venueSymbol: String(raw.symbol ?? ''),
      type: 'spot',
      base: base.toUpperCase(),
      quote: quote.toUpperCase(),
      settle: null,
      // Spot publishes `Trading` and nothing else today. A halted market is
      // marked inactive rather than dropped, so a caller can say WHY there is no
      // liquidity instead of showing an empty list.
      active: raw.status === 'Trading',
      contractSize: null,
      expiry: null,
      precision: {
        // A TICK and a LOT STEP, both published as decimal strings — see
        // `market.ts` for why a decimal count cannot express either. The 1e-8
        // fallback matches the first venue's rather than inventing a second
        // convention; it only applies to an instrument that published neither.
        price: readOptionalDecimal(price.tickSize, VENUE.id, 'priceFilter.tickSize') ?? parseAmount('0.00000001'),
        amount: readOptionalDecimal(lot.basePrecision, VENUE.id, 'lotSizeFilter.basePrecision') ?? parseAmount('0.00000001'),
      },
      limits: {
        minAmount: readOptionalDecimal(lot.minOrderQty, VENUE.id, 'lotSizeFilter.minOrderQty') ?? 0n,
        // `maxLimitOrderQty` first: the venue marks `maxOrderQty` deprecated, and
        // reading the deprecated field alone would silently stop resolving the
        // day it is removed. `null` rather than zero where neither exists —
        // `market.ts`: zero is a real limit.
        maxAmount:
          readOptionalDecimal(lot.maxLimitOrderQty, VENUE.id, 'lotSizeFilter.maxLimitOrderQty') ??
          readOptionalDecimal(lot.maxOrderQty, VENUE.id, 'lotSizeFilter.maxOrderQty'),
        // The limit that actually bites on spot — a notional floor, in quote units.
        minCost: readOptionalDecimal(lot.minOrderAmt, VENUE.id, 'lotSizeFilter.minOrderAmt') ?? 0n,
        maxLeverageBps: null,
      },
      fees: { makerBps: DEFAULT_FEE_BPS.maker, takerBps: DEFAULT_FEE_BPS.taker, indicative: true },
      observedAt,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TRADING AND ACCOUNT — signed trade + signed SPOT wallet observation
// ════════════════════════════════════════════════════════════════════════════

export { BybitSpotTrade, mapBybitSpotOrder, signBybitV5 } from './bybit-spot-trade.js';
export { BybitSpotAccount, mapBybitSpotCoins } from './bybit-spot-account.js';

// ──────────────────────────────────────────────────────────────────────────────

/**
 * `BTC/USDT` → `BTCUSDT`. The venue's spelling is used when talking TO it, and
 * nowhere else.
 *
 * Identical to Binance's transformation today, and duplicated on purpose rather
 * than shared: which characters a venue's own spelling drops is a fact about
 * that venue, and a shared helper would make one venue's rename silently rewrite
 * every request we send to the other.
 */
export function bybitSymbolOf(unified: string): string {
  return unified.replace(/[/:]/g, '').toUpperCase();
}

/**
 * `Buy`/`Sell` → the aggressor, or `null`.
 *
 * `null` rather than a default side when the field is missing or unrecognised.
 * `rates.ts`: a null aggressor is a true statement, and a guessed one poisons
 * every volume-side signal computed downstream while looking like a fact.
 */
export function takerSideOf(raw: unknown): 'buy' | 'sell' | null {
  if (raw === 'Buy') return 'buy';
  if (raw === 'Sell') return 'sell';
  return null;
}

/**
 * Has the venue refused this topic? Returns the reason, or `null`.
 *
 * TWO shapes, and the second is the trap. A flat rejection arrives as
 * `success: false` with `ret_msg`. But a PARTIAL rejection — the common case when
 * one topic in a batch is wrong — arrives as `success: TRUE` with the rejected
 * topics listed in `data.failTopics`. Reading `success` alone, which is the
 * obvious implementation, leaves us waiting forever on a topic the venue has
 * already told us it will never send.
 *
 * Exported so it can be tested against both shapes directly, without a socket.
 */
export function subscribeRefusal(frame: Record<string, unknown>, topic: string): string | null {
  if (frame.success === false) {
    const message = typeof frame.ret_msg === 'string' && frame.ret_msg ? frame.ret_msg : 'subscribe refused with no message';
    return message;
  }

  const data = frame.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const failTopics = (data as { failTopics?: unknown }).failTopics;
  if (!Array.isArray(failTopics)) return null;
  return failTopics.map(String).includes(topic) ? `venue listed ${topic} in failTopics` : null;
}

/** One message for a refused subscription, so it cannot drift between the two streams. */
function refusedTopic(topic: string, reason: string): string {
  return (
    `${VENUE.id} refused the subscription to ${topic}: ${reason}. Failing rather than holding a silent socket ` +
    'open — an unsubscribed connection is indistinguishable from a market with no activity.'
  );
}

/**
 * Wire levels from a delta, kept as strings and kept complete.
 *
 * Zero quantities are PRESERVED, unlike `readLevels`: Bybit documents `"0"` as
 * delete, which is the same convention `VenueBookDelta` already requires, and
 * dropping one would leave phantom liquidity in the book forever. The tracker
 * validates and canonicalises them.
 */
function wireLevels(raw: unknown, side: 'bids' | 'asks'): (readonly [string, string])[] {
  if (!Array.isArray(raw)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', `orderbook delta ${side} is not an array`);
  }
  return raw.map((level) => {
    if (!Array.isArray(level) || level.length < 2) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `orderbook delta ${side} carries a malformed level`);
    }
    // Read them to prove they are decimal strings, then emit the canonical form.
    const price = readDecimal(level[0], VENUE.id, `${side}.price`);
    const quantity = readDecimal(level[1], VENUE.id, `${side}.quantity`);
    return [formatAmount(price), formatAmount(quantity)] as const;
  });
}
