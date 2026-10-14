import { resolveWsCopy, WS_COPY } from '../copy.js';
import { CLOSE_GOING_AWAY, CLOSE_POLICY, CLOSE_TRY_LATER, type DepthHub, type DepthSink, type HubLogger } from '../depth/hub.js';
import { isPublishedHighWaterBytes } from '../high-water-bytes.js';
import type { TradeHub } from '../trade/hub.js';
import type { CandleHub } from './candle-hub.js';
import {
  isPublishedMuxLimit,
  isSlowConsumerReason,
  MUX_MAX_PENDING_OPS,
  parseChannel,
  parseOp,
  subscriptionKey,
  type ChannelSpec,
  type MuxErrorCode,
  type MuxVerb,
  type ParsedOp,
} from './protocol.js';
import type { MarketResolver } from './resolver.js';
import type { TickerHub } from './ticker-hub.js';

/**
 * ONE MULTIPLEXED CONNECTION.
 *
 * A session owns the subscriptions of one socket and nothing else: the hubs own
 * the books, the tape, the tickers and the candles, and every channel is just
 * another sink attached to the hub that already serves the single-market doors.
 * So the depth contract is the legacy contract, untouched — snapshot, then
 * sequenced deltas, a client that lags is repaired with a snapshot — wrapped in
 * an envelope that says which channel and market a frame belongs to.
 *
 *     { "ch": "book", "market": "<id>", "data": <DepthSnapshot | DepthDelta | status> }
 *
 * ── Limits (all enforced here, all owner-published) ─────────────────────────
 *
 *   · `maxSubscriptions`  channels per connection. Over it, that channel is
 *     refused with `subscription_limit`; the connection and its other channels
 *     are untouched.
 *   · `maxOpsPerSecond`   a token bucket over inbound work. A subscribe of N
 *     channels costs N (capped at one second of budget), so a client cannot buy
 *     64 hub attaches for the price of one message. Over budget the socket is
 *     closed 1008 `ws.close.mux_rate_limited` — a client that floods an
 *     unauthenticated port is not worth an error frame per message.
 *   · pending operations are bounded at `MUX_MAX_PENDING_OPS`; a client that
 *     queues past that is not waiting for answers and is closed 1008.
 *
 * Blank = unpublished = refused, like every other ceiling in this service:
 * the socket is closed 1008 with the `*_unset` name, never run on a guess.
 *
 * ── Backpressure ────────────────────────────────────────────────────────────
 *
 * The hubs keep no per-client queue; each applies its own degrade-then-drop
 * policy against THIS socket's buffer (`bufferedBytes` is shared by every
 * channel on it). When any hub gives up on the socket (close 1013 with a
 * "slow consumer" reason) the whole connection is closed 1013 — the other
 * channels share the same unread buffer, so keeping them would only move the
 * problem. Control frames (acks, errors) obey the same high-water check.
 * Every other reason a hub closes ONE channel (unknown market, capacity,
 * upstream down) becomes a typed `error` frame for that channel only.
 */

/** Socket surface a session needs. Real sockets and fakes both satisfy it. */
export interface MuxSocket {
  readonly bufferedBytes: number;
  send(frame: string): void;
  close(code: number, reason: string): void;
}

export interface MuxSessionDeps {
  readonly depth: DepthHub;
  readonly trades: TradeHub;
  readonly tickers: TickerHub;
  readonly candles: CandleHub;
  readonly resolver: MarketResolver;
  /** Owner-published. Unset refuses the connection. */
  readonly maxSubscriptions: number | undefined;
  /** Owner-published. Unset refuses the connection. */
  readonly maxOpsPerSecond: number | undefined;
  /** Owner-published. Unset refuses the connection. */
  readonly highWaterBytes: number | undefined;
  readonly log: HubLogger;
  readonly clock?: () => number;
}

interface Entry {
  readonly key: string;
  readonly spec: ChannelSpec;
  readonly sink: DepthSink;
  readonly marketId: string | null;
  detach: (() => void) | null;
}

type ResultBase = {
  readonly i: number;
  readonly ch?: ChannelSpec['ch'];
  readonly market?: string;
  readonly symbol?: string;
  readonly interval?: string;
};
type Result = ResultBase &
  ({ readonly ok: true; readonly note?: string } | { readonly ok: false; readonly code: MuxErrorCode; readonly message: string });

export class MuxSession {
  readonly #socket: MuxSocket;
  readonly #deps: MuxSessionDeps;
  readonly #clock: () => number;
  readonly #subs = new Map<string, Entry>();
  /** What the client typed → the canonical id, so an unsubscribe by symbol finds the subscription. */
  readonly #aliases = new Map<string, string>();

  #closed = false;
  #tokens = 0;
  #lastRefill = 0;
  #pendingOps = 0;
  #chain: Promise<void> = Promise.resolve();
  /** While a hub `attach` is running, a synchronous refusal is captured here instead of sent. */
  #attaching: { key: string; refusal: { code: number; reason: string } | null } | null = null;

  constructor(socket: MuxSocket, deps: MuxSessionDeps) {
    this.#socket = socket;
    this.#deps = deps;
    this.#clock = deps.clock ?? Date.now;
  }

  get subscriptions(): number {
    return this.#subs.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Refuses (and closes) when a ceiling this session depends on is unpublished. */
  start(): boolean {
    const { maxSubscriptions, maxOpsPerSecond, highWaterBytes } = this.#deps;
    if (!isPublishedHighWaterBytes(highWaterBytes)) return this.#refuse(WS_COPY.highWaterBytesUnset);
    if (!isPublishedMuxLimit(maxSubscriptions)) return this.#refuse(WS_COPY.muxMaxSubscriptionsUnset);
    if (!isPublishedMuxLimit(maxOpsPerSecond)) return this.#refuse(WS_COPY.muxMaxOpsUnset);
    this.#tokens = maxOpsPerSecond;
    this.#lastRefill = this.#clock();
    return true;
  }

  #refuse(copyKey: string): false {
    this.#closeSocket(CLOSE_POLICY, resolveWsCopy(copyKey));
    return false;
  }

  /** One inbound text frame. Never throws. */
  onMessage(text: string): void {
    if (this.#closed) return;
    const parsed = parseOp(text);
    if (!this.#takeBudget(parsed.ok ? parsed.channels.length : 1)) {
      this.#closeSocket(CLOSE_POLICY, resolveWsCopy(WS_COPY.muxRateLimited));
      return;
    }
    if (!parsed.ok) {
      this.#sendError(parsed.code, parsed.message, parsed.id);
      return;
    }
    if (this.#pendingOps >= MUX_MAX_PENDING_OPS) {
      this.#closeSocket(CLOSE_POLICY, resolveWsCopy(WS_COPY.muxBacklog));
      return;
    }
    this.#pendingOps += 1;
    // Strictly in order: subscribe-then-unsubscribe must mean what it says even
    // though resolving a market is asynchronous.
    this.#chain = this.#chain
      .then(() => this.#run(parsed))
      .catch((err: unknown) => {
        this.#deps.log.warn({ err: String(err) }, 'ws: mux operation failed');
        this.#sendError('unavailable', 'operation failed', parsed.id);
      })
      .finally(() => {
        this.#pendingOps -= 1;
      });
  }

  /** The inbound frame was not text. */
  onBinary(): void {
    if (this.#closed) return;
    if (!this.#takeBudget(1)) {
      this.#closeSocket(CLOSE_POLICY, resolveWsCopy(WS_COPY.muxRateLimited));
      return;
    }
    this.#sendError('bad_request', 'binary frames are not accepted; send JSON text', undefined);
  }

  /** The socket is gone. Releases every hub seat. Idempotent. */
  onClose(): void {
    this.#closed = true;
    this.#releaseAll();
  }

  // ── Budget ───────────────────────────────────────────────────────────────

  #takeBudget(cost: number): boolean {
    const rate = this.#deps.maxOpsPerSecond;
    if (!isPublishedMuxLimit(rate)) return false;
    const now = this.#clock();
    const elapsed = Math.max(0, now - this.#lastRefill);
    this.#lastRefill = now;
    this.#tokens = Math.min(rate, this.#tokens + (elapsed / 1000) * rate);
    // A big operation costs at most one second of budget, so it can always be afforded once.
    const price = Math.min(Math.max(1, cost), rate);
    if (this.#tokens < price) return false;
    this.#tokens -= price;
    return true;
  }

  // ── Operations ───────────────────────────────────────────────────────────

  async #run(op: Extract<ParsedOp, { ok: true }>): Promise<void> {
    const results: Result[] = [];
    for (let i = 0; i < op.channels.length; i += 1) {
      if (this.#closed) return;
      const parsed = parseChannel(op.channels[i]);
      if (!parsed.ok) {
        results.push({ i, ok: false, code: parsed.code, message: parsed.message });
        continue;
      }
      results.push(await this.#apply(op.verb, parsed.spec, i));
    }
    if (this.#closed) return;
    const ack: Record<string, unknown> = { op: 'ack', for: op.verb };
    if (op.id !== undefined) ack.id = op.id;
    ack.results = results;
    this.#sendControl(JSON.stringify(ack));
  }

  async #apply(verb: MuxVerb, spec: ChannelSpec, i: number): Promise<Result> {
    try {
      switch (verb) {
        case 'subscribe':
          return await this.#subscribe(spec, i);
        case 'unsubscribe':
          return this.#unsubscribe(spec, i);
        case 'resync':
          return this.#resync(spec, i);
      }
    } catch (err) {
      this.#deps.log.warn({ err: String(err), ch: spec.ch }, 'ws: mux channel operation failed');
      return fail(i, spec, null, 'unavailable', 'the market listing could not be read');
    }
  }

  async #subscribe(spec: ChannelSpec, i: number): Promise<Result> {
    let marketId: string | null = null;
    let symbol: string | null = null;
    if (spec.market !== undefined) {
      const resolved = await this.#deps.resolver.resolve(spec.market);
      if (this.#closed) return fail(i, spec, null, 'unavailable', 'connection closing');
      if (resolved === null) return fail(i, spec, null, 'unknown_market', 'no such market');
      marketId = resolved.id;
      symbol = resolved.symbol;
    }

    const key = subscriptionKey(spec, marketId);
    if (this.#subs.has(key)) return ok(i, spec, marketId, symbol, 'already subscribed');

    const max = this.#deps.maxSubscriptions;
    if (isPublishedMuxLimit(max) && this.#subs.size >= max) {
      return fail(i, spec, marketId, 'subscription_limit', `this connection may hold at most ${max} subscriptions`);
    }

    const sink = this.#sinkFor(key, spec, marketId);
    const entry: Entry = { key, spec, sink, marketId, detach: null };
    this.#attaching = { key, refusal: null };
    const detach = this.#attach(spec, marketId, sink);
    const refusal = this.#attaching.refusal;
    this.#attaching = null;

    if (detach === null) {
      const reason = refusal?.reason ?? 'refused';
      if (refusal && refusal.code === CLOSE_TRY_LATER && reason === resolveWsCopy(WS_COPY.atCapacity)) {
        return fail(i, spec, marketId, 'at_capacity', 'the server is at capacity for this channel; try again later');
      }
      return fail(i, spec, marketId, 'unavailable', reason);
    }
    entry.detach = detach;
    this.#subs.set(key, entry);
    if (marketId !== null && spec.market !== undefined && spec.market !== marketId) this.#aliases.set(spec.market, marketId);
    if (marketId !== null && symbol !== null) this.#aliases.set(symbol, marketId);
    return ok(i, spec, marketId, symbol);
  }

  #attach(spec: ChannelSpec, marketId: string | null, sink: DepthSink): (() => void) | null {
    switch (spec.ch) {
      case 'book':
        return this.#deps.depth.attach(marketId as string, sink);
      case 'trades':
        return this.#deps.trades.attach(marketId as string, sink);
      case 'candles':
        return this.#deps.candles.attach(marketId as string, spec.interval, sink, this.#clock());
      case 'ticker':
        return this.#deps.tickers.attach(marketId, sink, this.#clock());
    }
  }

  #lookup(spec: ChannelSpec): { key: string; entry: Entry | undefined; marketId: string | null } {
    const marketId = spec.market === undefined ? null : (this.#aliases.get(spec.market) ?? spec.market);
    const key = subscriptionKey(spec, marketId);
    return { key, entry: this.#subs.get(key), marketId };
  }

  #unsubscribe(spec: ChannelSpec, i: number): Result {
    const { key, entry, marketId } = this.#lookup(spec);
    if (!entry) return fail(i, spec, marketId, 'not_subscribed', 'no such subscription on this connection');
    this.#drop(key, entry);
    return ok(i, spec, marketId, null);
  }

  #resync(spec: ChannelSpec, i: number): Result {
    const { entry, marketId } = this.#lookup(spec);
    if (!entry) return fail(i, spec, marketId, 'not_subscribed', 'no such subscription on this connection');
    switch (spec.ch) {
      case 'book': {
        const outcome = this.#deps.depth.resync(entry.sink);
        return outcomeResult(i, spec, marketId, outcome === 'not_subscribed' ? 'absent' : outcome);
      }
      case 'candles':
        return outcomeResult(i, spec, marketId, this.#deps.candles.resync(entry.sink, this.#clock()));
      case 'ticker':
        return outcomeResult(i, spec, marketId, this.#deps.tickers.resync(entry.sink, this.#clock()));
      case 'trades':
        return fail(i, spec, marketId, 'unsupported', 'trades are a tape of independent prints; there is nothing to resync');
    }
  }

  // ── Sinks ────────────────────────────────────────────────────────────────

  #sinkFor(key: string, spec: ChannelSpec, marketId: string | null): DepthSink {
    const head =
      `{"ch":${JSON.stringify(spec.ch)}` +
      (marketId === null ? '' : `,"market":${JSON.stringify(marketId)}`) +
      (spec.ch === 'candles' ? `,"interval":${JSON.stringify(spec.interval)}` : '');
    const socket = this.#socket;
    return {
      get bufferedBytes() {
        return socket.bufferedBytes;
      },
      send: (frame: string) => {
        if (this.#closed) return;
        socket.send(`${head},"data":${frame}}`);
      },
      close: (code: number, reason: string) => this.#onChannelClosed(key, spec, marketId, code, reason),
    };
  }

  /** A hub gave up on one of this connection's sinks. */
  #onChannelClosed(key: string, spec: ChannelSpec, marketId: string | null, code: number, reason: string): void {
    if (this.#attaching?.key === key) {
      // Refused inside `attach`: the subscribe result reports it.
      this.#attaching.refusal = { code, reason };
      return;
    }
    if (code === CLOSE_GOING_AWAY) {
      this.#closeSocket(CLOSE_GOING_AWAY, reason);
      return;
    }
    if (code === CLOSE_TRY_LATER && isSlowConsumerReason(reason)) {
      this.#closeSocket(CLOSE_TRY_LATER, reason);
      return;
    }
    const entry = this.#subs.get(key);
    if (entry) {
      entry.detach?.();
      this.#subs.delete(key);
    }
    const error: MuxErrorCode = code === CLOSE_POLICY && reason === resolveWsCopy(WS_COPY.unknownMarket) ? 'unknown_market' : 'unavailable';
    this.#sendControl(
      JSON.stringify({
        op: 'error',
        code: error,
        message: reason,
        ch: spec.ch,
        ...(marketId === null ? {} : { market: marketId }),
        ...(spec.ch === 'candles' ? { interval: spec.interval } : {}),
      }),
    );
  }

  #drop(key: string, entry: Entry): void {
    this.#subs.delete(key);
    entry.detach?.();
    for (const [alias, id] of this.#aliases) if (id === entry.marketId && !this.#hasOtherFor(id)) this.#aliases.delete(alias);
  }

  #hasOtherFor(marketId: string): boolean {
    for (const entry of this.#subs.values()) if (entry.marketId === marketId) return true;
    return false;
  }

  #releaseAll(): void {
    for (const entry of [...this.#subs.values()]) entry.detach?.();
    this.#subs.clear();
    this.#aliases.clear();
  }

  // ── Frames out ───────────────────────────────────────────────────────────

  #sendError(code: MuxErrorCode, message: string, id: string | undefined): void {
    this.#sendControl(JSON.stringify({ op: 'error', code, message, ...(id === undefined ? {} : { id }) }));
  }

  #sendControl(frame: string): void {
    if (this.#closed) return;
    const limit = this.#deps.highWaterBytes;
    if (isPublishedHighWaterBytes(limit) && this.#socket.bufferedBytes > limit) {
      this.#closeSocket(CLOSE_TRY_LATER, `slow consumer: outbound buffer over ${limit} bytes`);
      return;
    }
    try {
      this.#socket.send(frame);
    } catch {
      this.#closeSocket(CLOSE_GOING_AWAY, 'send failed');
    }
  }

  #closeSocket(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseAll();
    try {
      this.#socket.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  /** Server shutdown or kill-switch: tell the client why, release everything. */
  close(code: number, reason: string): void {
    this.#closeSocket(code, reason);
  }
}

function ok(i: number, spec: ChannelSpec, marketId: string | null, symbol: string | null, note?: string): Result {
  return {
    i,
    ch: spec.ch,
    ...(marketId === null ? {} : { market: marketId }),
    ...(symbol === null ? {} : { symbol }),
    ...(spec.ch === 'candles' ? { interval: spec.interval } : {}),
    ok: true,
    ...(note === undefined ? {} : { note }),
  };
}

function fail(i: number, spec: ChannelSpec, marketId: string | null, code: MuxErrorCode, message: string): Result {
  return {
    i,
    ch: spec.ch,
    ...(marketId === null ? {} : { market: marketId }),
    ...(spec.ch === 'candles' ? { interval: spec.interval } : {}),
    ok: false,
    code,
    message,
  };
}

function outcomeResult(
  i: number,
  spec: ChannelSpec,
  marketId: string | null,
  outcome: 'sent' | 'pending' | 'deferred' | 'absent' | 'not_subscribed',
): Result {
  switch (outcome) {
    case 'sent':
      return ok(i, spec, marketId, null, 'snapshot sent');
    case 'pending':
      return ok(i, spec, marketId, null, 'the connect snapshot is still on its way');
    case 'deferred':
      return ok(i, spec, marketId, null, 'socket is over its buffer limit; the snapshot follows once it drains');
    case 'absent':
    case 'not_subscribed':
      return ok(i, spec, marketId, null, 'nothing to send: no live state is held for this channel');
  }
}
