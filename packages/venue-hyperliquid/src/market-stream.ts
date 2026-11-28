/**
 * THE PUBLIC MARKET STREAM: each viewed market's book, trades and candles from one WebSocket to the venue,
 * so a market open on any number of desks costs the server's one IP no REST weight.
 *
 * Read by REST, every desk-viewed market cost the box about 150 to 300 weight a minute (`l2Book` every 2 s,
 * `candleSnapshot` and `recentTrades` every 15 s), so five desks on five markets spent 1,330 of the 1,200 a minute the
 * venue allows one IP (beta 60871f0, 28 Nov 2026 03:28 UTC). A subscription is weighed by no REST read.
 *
 * `answer` is asked first for every shared read. It answers only what a live subscription holds and returns undefined
 * otherwise, and the caller then reads over REST as before. Asking is what subscribes. Answers have the REST shapes,
 * checked live on the test network on 28 Nov 2026:
 * - `l2Book {coin}`: the subscription's own snapshot, sent on subscribing and every few seconds after. Kept while the
 *   newest is under `BOOK_FRESH_MS` old.
 * - `recentTrades {coin}`: the subscription sends the market's last 30 trades on subscribing and each new trade after.
 *   Answered newest first, at most `REST_TRADES`, as the REST read is.
 * - `candleSnapshot {req: {coin, interval, startTime, endTime}}`: a candle subscription sends only the candle a trade
 *   changes, so the history comes from one REST answer (`seed`) read after the subscription went live. Every push after
 *   that keeps the series whole; a request reaching before the seeded start reads REST again and seeds the longer one.
 *
 * The socket is pinged every `PING_MS` (the venue closes a connection that sent nothing for a minute). A socket that
 * closes, errs or has answered nothing for `SILENT_MS` drops everything it held, so a read after it goes to REST until
 * a new subscription is live again. A subscription nobody asked for in `IDLE_MS` is dropped.
 */
import { messageOf, type Json } from './core.js';

/** What the stream needs of a WebSocket: the platform's own (`globalThis.WebSocket`) fits. */
export interface MarketStreamSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface MarketStreamOptions {
  /** The venue's WebSocket address (`wss://api.hyperliquid-testnet.xyz/ws`). */
  readonly url: string;
  readonly connect?: (url: string) => MarketStreamSocket;
  readonly clock?: () => Date;
  /** Runs `tick` every `PING_MS`; tests drive it by hand. Defaults to an unref'd interval. */
  readonly every?: (ms: number, tick: () => void) => () => void;
  readonly warn?: (message: string) => void;
}

/** The newest book snapshot is used while it is younger than this; the venue sends one every ~3 s. */
export const BOOK_FRESH_MS = 10_000;
/** How many trades the REST `recentTrades` read answers (live, 28 Nov 2026). */
export const REST_TRADES = 10;
export const PING_MS = 15_000;
/** A socket that has answered nothing (not even a pong) for this long is treated as gone. */
export const SILENT_MS = 40_000;
/** A subscription nobody asked for in this long is dropped. */
export const IDLE_MS = 120_000;
/** At most this many subscriptions at once (the venue allows 1,000 per IP); past it, reads go to REST. */
const MAX_SUBSCRIPTIONS = 200;
/** After a socket closes, a new one is opened no sooner than this. */
const RECONNECT_MS = 5_000;
/** A seeded candle series holds at most this many candles. */
const MAX_CANDLES = 5_000;

type Candle = { readonly [key: string]: Json };

interface Subscription {
  readonly key: string;
  readonly subscription: { readonly type: string; readonly coin: string; readonly interval?: string };
  /** When the venue confirmed it; null until then. */
  liveSinceMs: number | null;
  askedMs: number;
  book: { text: string; atMs: number } | null;
  /** Newest first, by trade id. */
  trades: Candle[] | null;
  /** By open time; `coveredFromMs` is the earliest open time the series is whole from, null until seeded. */
  candles: Map<number, Candle>;
  coveredFromMs: number | null;
}

const isObj = (v: unknown): v is { [key: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The subscription a REST read can be answered from, by its key, or null when it is no read the stream serves. */
interface Asked {
  readonly key: string;
  readonly sub: Subscription['subscription'];
  /** A candle read's window, by open time. */
  readonly window?: { readonly startTime: number; readonly endTime: number };
}

function subscriptionOf(body: Record<string, Json>): Asked | null {
  const keys = Object.keys(body).sort().join(',');
  if ((body.type === 'l2Book' || body.type === 'recentTrades') && keys === 'coin,type' && typeof body.coin === 'string') {
    const type = body.type === 'l2Book' ? 'l2Book' : 'trades';
    return { key: `${type}:${body.coin}`, sub: { type, coin: body.coin } };
  }
  if (body.type === 'candleSnapshot' && keys === 'req,type' && isObj(body.req)) {
    const { coin, interval, startTime, endTime } = body.req;
    if (typeof coin !== 'string' || typeof interval !== 'string' || typeof startTime !== 'number' || typeof endTime !== 'number')
      return null;
    return { key: `candle:${coin}:${interval}`, sub: { type: 'candle', coin, interval }, window: { startTime, endTime } };
  }
  return null;
}

function keyOfSubscription(s: unknown): string | null {
  if (!isObj(s) || typeof s.type !== 'string' || typeof s.coin !== 'string') return null;
  if (s.type === 'l2Book' || s.type === 'trades') return `${s.type}:${s.coin}`;
  if (s.type === 'candle' && typeof s.interval === 'string') return `candle:${s.coin}:${s.interval}`;
  return null;
}

export class HyperliquidMarketStream {
  private readonly url: string;
  private readonly connect: (url: string) => MarketStreamSocket;
  private readonly clock: () => Date;
  private readonly every: (ms: number, tick: () => void) => () => void;
  private readonly warn: (message: string) => void;
  private socket: { ws: MarketStreamSocket; open: boolean; heardMs: number } | null = null;
  private stopTicks: (() => void) | null = null;
  private closedAtMs = Number.NEGATIVE_INFINITY;
  private readonly subs = new Map<string, Subscription>();

  constructor(options: MarketStreamOptions) {
    this.url = options.url;
    this.connect = options.connect ?? platformSocket;
    this.clock = options.clock ?? (() => new Date());
    this.every =
      options.every ??
      ((ms, tick) => {
        const timer = setInterval(tick, ms);
        timer.unref?.();
        return () => clearInterval(timer);
      });
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** How many subscriptions are live now (for the minute's log line). */
  get live(): number {
    let n = 0;
    for (const s of this.subs.values()) if (s.liveSinceMs !== null) n += 1;
    return n;
  }

  /** The read's answer as the REST read's JSON text when a live subscription holds it; undefined sends it to REST. */
  answer(body: Record<string, Json>): string | undefined {
    const of = subscriptionOf(body);
    if (of === null) return undefined;
    const now = this.now();
    const sub = this.subs.get(of.key) ?? this.subscribe(of.key, of.sub, now);
    if (sub === null) return undefined;
    sub.askedMs = now;
    if (sub.liveSinceMs === null || !this.socketHealthy(now)) return undefined;
    if (sub.subscription.type === 'l2Book') {
      return sub.book !== null && now - sub.book.atMs < BOOK_FRESH_MS ? sub.book.text : undefined;
    }
    if (sub.subscription.type === 'trades') return sub.trades === null ? undefined : JSON.stringify(sub.trades.slice(0, REST_TRADES));
    const req = of.window;
    if (req === undefined || sub.coveredFromMs === null || req.startTime < sub.coveredFromMs) return undefined;
    const rows = [...sub.candles].filter(([t]) => t >= req.startTime && t <= req.endTime);
    rows.sort(([a], [b]) => a - b);
    return JSON.stringify(rows.map(([, candle]) => candle));
  }

  /**
   * A candle read's REST answer, begun at `startedMs`, seeds its series once its subscription is live: only an answer
   * begun after the venue confirmed the subscription, so no push between the two is missed.
   */
  seed(body: Record<string, Json>, text: string, startedMs: number): void {
    const of = subscriptionOf(body);
    if (of === null || of.window === undefined) return;
    const sub = this.subs.get(of.key);
    if (!sub || sub.liveSinceMs === null || startedMs < sub.liveSinceMs || !this.socketHealthy(this.now())) return;
    let rows: unknown;
    try {
      rows = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    const req = of.window;
    // A window that ends before the current candle is history only: it can't seed the live series.
    if (req.endTime < this.now()) return;
    for (const row of rows) if (isObj(row)) this.keepCandle(sub, row);
    sub.coveredFromMs = sub.coveredFromMs === null ? req.startTime : Math.min(sub.coveredFromMs, req.startTime);
    this.trimCandles(sub);
  }

  /** Closes the socket and drops every subscription. */
  close(): void {
    this.drop();
  }

  private now(): number {
    return this.clock().getTime();
  }

  private socketHealthy(now: number): boolean {
    return this.socket !== null && this.socket.open && now - this.socket.heardMs < SILENT_MS;
  }

  private subscribe(key: string, subscription: Subscription['subscription'], now: number): Subscription | null {
    if (this.subs.size >= MAX_SUBSCRIPTIONS) return null;
    if (this.socket === null) {
      if (now - this.closedAtMs < RECONNECT_MS) return null;
      this.open(now);
      if (this.socket === null) return null;
    }
    const sub: Subscription = {
      key,
      subscription,
      liveSinceMs: null,
      askedMs: now,
      book: null,
      trades: null,
      candles: new Map(),
      coveredFromMs: null,
    };
    this.subs.set(key, sub);
    if (this.socket.open) this.send({ method: 'subscribe', subscription });
    return sub;
  }

  private open(now: number): void {
    let ws: MarketStreamSocket;
    try {
      ws = this.connect(this.url);
    } catch (error) {
      this.closedAtMs = now;
      this.warn(`venue market stream: could not open ${this.url}: ${messageOf(error)}`);
      return;
    }
    const socket = { ws, open: false, heardMs: now };
    this.socket = socket;
    ws.onopen = () => {
      if (this.socket !== socket) return;
      socket.open = true;
      socket.heardMs = this.now();
      for (const sub of this.subs.values()) this.send({ method: 'subscribe', subscription: sub.subscription });
    };
    ws.onmessage = (event) => {
      if (this.socket !== socket) return;
      socket.heardMs = this.now();
      this.onMessage(event.data);
    };
    ws.onclose = () => {
      if (this.socket === socket) this.drop();
    };
    ws.onerror = () => {
      if (this.socket === socket) this.drop();
    };
    this.stopTicks = this.every(PING_MS, () => this.tick());
  }

  private tick(): void {
    const now = this.now();
    if (this.socket === null) return;
    if (this.socket.open && now - this.socket.heardMs >= SILENT_MS) {
      this.warn('venue market stream: the venue answered nothing for 40 s; reads go to REST until it is back');
      this.drop();
      return;
    }
    for (const sub of this.subs.values()) {
      if (now - sub.askedMs < IDLE_MS) continue;
      this.subs.delete(sub.key);
      if (this.socket.open) this.send({ method: 'unsubscribe', subscription: sub.subscription });
    }
    if (this.subs.size === 0) {
      this.drop();
      this.closedAtMs = Number.NEGATIVE_INFINITY;
      return;
    }
    if (this.socket.open) this.send({ method: 'ping' });
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.subs.clear();
    this.stopTicks?.();
    this.stopTicks = null;
    this.closedAtMs = this.now();
    if (socket !== null) {
      socket.ws.onopen = socket.ws.onmessage = socket.ws.onclose = socket.ws.onerror = null;
      try {
        socket.ws.close();
      } catch {
        // already closed
      }
    }
  }

  private send(message: { [key: string]: Json | Subscription['subscription'] }): void {
    try {
      this.socket?.ws.send(JSON.stringify(message));
    } catch {
      this.drop();
    }
  }

  private onMessage(data: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (!isObj(message) || typeof message.channel !== 'string') return;
    const now = this.now();
    const payload = message.data;
    switch (message.channel) {
      case 'subscriptionResponse': {
        if (!isObj(payload) || payload.method !== 'subscribe') return;
        const key = keyOfSubscription(payload.subscription);
        const sub = key === null ? undefined : this.subs.get(key);
        if (sub && sub.liveSinceMs === null) sub.liveSinceMs = now;
        return;
      }
      case 'l2Book': {
        if (!isObj(payload) || typeof payload.coin !== 'string' || !Array.isArray(payload.levels)) return;
        const sub = this.subs.get(`l2Book:${payload.coin}`);
        if (sub?.liveSinceMs != null) sub.book = { text: JSON.stringify(payload), atMs: now };
        return;
      }
      case 'trades': {
        if (!Array.isArray(payload) || payload.length === 0) return;
        const first = payload[0];
        if (!isObj(first) || typeof first.coin !== 'string') return;
        const sub = this.subs.get(`trades:${first.coin}`);
        if (sub?.liveSinceMs == null) return;
        const seen = new Set((sub.trades ?? []).map((t) => String(t.tid)));
        // The venue sends trades oldest first and answers the REST read newest first: reversed, trades of one moment
        // keep the REST read's order through the (stable) sort.
        const fresh = payload.filter((t): t is Candle => isObj(t) && !seen.has(String(t.tid))).reverse();
        const all = [...fresh, ...(sub.trades ?? [])];
        all.sort((a, b) => Number(b.time) - Number(a.time));
        sub.trades = all.slice(0, Math.max(REST_TRADES, 30));
        return;
      }
      case 'candle': {
        if (!isObj(payload) || typeof payload.s !== 'string' || typeof payload.i !== 'string' || typeof payload.t !== 'number') return;
        const sub = this.subs.get(`candle:${payload.s}:${payload.i}`);
        if (sub?.liveSinceMs == null) return;
        this.keepCandle(sub, payload);
        this.trimCandles(sub);
        return;
      }
      default:
        return;
    }
  }

  /** One candle by its open time; of two for the same candle, the one more trades went into is the later. */
  private keepCandle(sub: Subscription, row: Candle): void {
    if (typeof row.t !== 'number') return;
    const had = sub.candles.get(row.t);
    if (had && Number(had.n) > Number(row.n)) return;
    sub.candles.set(row.t, row);
  }

  private trimCandles(sub: Subscription): void {
    for (const t of sub.candles.keys()) if (sub.coveredFromMs !== null && t < sub.coveredFromMs) sub.candles.delete(t);
    if (sub.candles.size <= MAX_CANDLES) return;
    const oldest = [...sub.candles.keys()].sort((a, b) => b - a)[MAX_CANDLES - 1] ?? Number.NEGATIVE_INFINITY;
    for (const t of sub.candles.keys()) if (t < oldest) sub.candles.delete(t);
    // Whole from the oldest kept only if it was whole before; pushes alone never make a series whole.
    if (sub.coveredFromMs !== null) sub.coveredFromMs = oldest;
  }
}

/** The platform's own WebSocket (`globalThis.WebSocket`) as the stream's socket. */
function platformSocket(url: string): MarketStreamSocket {
  const ws = new globalThis.WebSocket(url);
  const socket: MarketStreamSocket = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = () => socket.onclose?.();
  ws.onerror = () => socket.onerror?.();
  return socket;
}
