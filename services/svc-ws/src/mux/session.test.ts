import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDelta, bookFromSnapshot, type DepthBook, type DepthMessage, type DepthSnapshot, type FillLike } from '@intafaced/market-data';
import { DepthHub } from '../depth/hub.js';
import type { DepthSource } from '../depth/source.js';
import { TradeHub } from '../trade/hub.js';
import { CandleHub } from './candle-hub.js';
import { MUX_MAX_PENDING_OPS } from './protocol.js';
import type { MarketResolver } from './resolver.js';
import { MuxSession, type MuxSessionDeps, type MuxSocket } from './session.js';
import { TickerHub, type TickerRow } from './ticker-hub.js';

const BTC = 'BTC-USDT';
const ETH = 'ETH-USDT';

function snapshot(sequence: number, marketId: string, bids: Array<[string, string]> = [['100', '1']]): DepthSnapshot {
  return { type: 'snapshot', marketId, sequence, bids, asks: [['101', '1']] };
}

class StubSource implements DepthSource {
  async markets(): Promise<readonly string[]> {
    return [BTC, ETH];
  }
  async snapshot(marketId: string): Promise<DepthSnapshot> {
    return snapshot(10, marketId);
  }
}

class FakeSocket implements MuxSocket {
  bufferedBytes = 0;
  readonly frames: any[] = [];
  closed: { code: number; reason: string } | null = null;
  send(frame: string): void {
    this.frames.push(JSON.parse(frame));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  /** Data frames for one channel/market, in order. */
  data(ch: string, market?: string): any[] {
    return this.frames.filter((f) => f.ch === ch && (market === undefined || f.market === market)).map((f) => f.data);
  }
  acks(): any[] {
    return this.frames.filter((f) => f.op === 'ack');
  }
  errors(): any[] {
    return this.frames.filter((f) => f.op === 'error');
  }
}

const SYMBOLS: Record<string, string> = { 'BTC/USDT': BTC, 'ETH/USDT': ETH };

function resolverOver(hub: DepthHub): MarketResolver {
  return {
    async resolve(input) {
      if (!input.includes('/') && (await hub.ensureKnownMarket(input))) {
        const symbol = Object.entries(SYMBOLS).find(([, id]) => id === input)?.[0] ?? null;
        return { id: input, symbol };
      }
      const id = SYMBOLS[input];
      return id ? { id, symbol: input } : null;
    },
  };
}

function fill(sequence: number, marketId = BTC): FillLike {
  return { marketId, makerOrderId: 'm', takerOrderId: 't', price: '100', qty: '1', sequence, ts: '2026-07-29T12:00:01.000Z' } as FillLike;
}

function tickerRow(market: string, last: string): TickerRow {
  return {
    market,
    symbol: market.replace('-', '/'),
    last,
    change24h: null,
    changePct24h: null,
    high: null,
    low: null,
    volume: null,
    quoteVolume: null,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

interface Rig {
  depth: DepthHub;
  trades: TradeHub;
  tickers: TickerHub;
  candles: CandleHub;
  socket: FakeSocket;
  session: MuxSession;
  deps: MuxSessionDeps;
  clock: { now: number };
  send(op: unknown): Promise<void>;
}

function rig(overrides: Partial<MuxSessionDeps> = {}, hubMax = 50, source: DepthSource = new StubSource()): Rig {
  const depth = new DepthHub(source, {
    depthLimit: 50,
    highWaterBytes: 1000,
    maxLagTicks: 3,
    maxConnections: hubMax,
    muxMaxConnections: hubMax,
    marketsRefreshMs: 0,
  });
  const trades = new TradeHub({
    highWaterBytes: 1000,
    maxLagTicks: 3,
    maxConnections: hubMax,
    muxMaxConnections: hubMax,
    recentLimit: 10,
    ensureKnownMarket: (id) => depth.ensureKnownMarket(id),
  });
  const tickers = new TickerHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: hubMax, throttleMs: 1000 });
  const candles = new CandleHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: hubMax });
  const socket = new FakeSocket();
  const clock = { now: 1_000_000 };
  const deps: MuxSessionDeps = {
    depth,
    trades,
    tickers,
    candles,
    resolver: resolverOver(depth),
    maxSubscriptions: 10,
    maxOpsPerSecond: 100,
    highWaterBytes: 1000,
    idleMs: 30_000,
    log: { info: vi.fn(), warn: vi.fn() },
    clock: () => clock.now,
    ...overrides,
  };
  const session = new MuxSession(socket, deps);
  return {
    depth,
    trades,
    tickers,
    candles,
    socket,
    session,
    deps,
    clock,
    async send(op) {
      session.onMessage(typeof op === 'string' ? op : JSON.stringify(op));
      await settle();
    },
  };
}

/** The book a browser holds, from the enveloped frames of one market alone. */
function clientBook(socket: FakeSocket, market: string): DepthBook | null {
  let book: DepthBook | null = null;
  for (const message of socket.data('book', market) as DepthMessage[]) {
    if (message.type === 'snapshot') {
      book = bookFromSnapshot(message);
      continue;
    }
    if (message.type !== 'delta') continue;
    if (!book) throw new Error('delta before snapshot');
    const result = applyDelta(book, message);
    if (!result.ok) throw new Error(`client refused a delta: ${result.reason}`);
    book = result.book;
  }
  return book;
}

let r: Rig;

beforeEach(async () => {
  r = rig();
  await r.depth.refreshMarkets();
  expect(r.session.start()).toBe(true);
});

describe('multiplexing — one connection, many channels', () => {
  it('subscribes to book, trades, ticker and candles in one operation, and envelopes every frame', async () => {
    await r.send({
      op: 'subscribe',
      id: 'r1',
      channels: [
        { ch: 'book', market: BTC },
        { ch: 'trades', market: BTC },
        { ch: 'ticker' },
        { ch: 'candles', market: BTC, interval: '1m' },
      ],
    });

    const [ack] = r.socket.acks();
    expect(ack).toMatchObject({ op: 'ack', for: 'subscribe', id: 'r1' });
    expect(ack.results).toEqual([
      { i: 0, ch: 'book', market: BTC, symbol: 'BTC/USDT', ok: true },
      { i: 1, ch: 'trades', market: BTC, symbol: 'BTC/USDT', ok: true },
      { i: 2, ch: 'ticker', ok: true },
      { i: 3, ch: 'candles', market: BTC, symbol: 'BTC/USDT', interval: '1m', ok: true },
    ]);
    expect(r.session.subscriptions).toBe(4);

    // book: the original snapshot, inside the envelope
    expect(r.socket.data('book', BTC)[0]).toMatchObject({ type: 'snapshot', marketId: BTC, sequence: 10 });

    // trades
    r.trades.ingest(fill(1));
    expect(r.socket.data('trades', BTC)).toEqual([expect.objectContaining({ type: 'trade', marketId: BTC, sequence: 1, price: '100' })]);

    // ticker
    r.tickers.ingest([tickerRow(BTC, '100'), tickerRow(ETH, '200')], r.clock.now);
    expect(r.socket.frames.find((f) => f.ch === 'ticker').data.tickers).toHaveLength(2);
    expect(r.socket.frames.find((f) => f.ch === 'ticker')).not.toHaveProperty('market');

    // candles
    r.candles.ingest(BTC, '1m', [{ t: 960_000, o: '1', h: '2', l: '1', c: '2', v: '3' }], r.clock.now);
    expect(r.socket.frames.find((f) => f.ch === 'candles')).toMatchObject({ ch: 'candles', market: BTC, interval: '1m' });
  });

  it('keeps two markets on one socket apart', async () => {
    await r.send({
      op: 'subscribe',
      channels: [
        { ch: 'book', market: BTC },
        { ch: 'book', market: ETH },
      ],
    });
    r.depth.ingest(snapshot(11, BTC, [['100', '2']]));
    expect(r.socket.data('book', BTC)).toHaveLength(2);
    expect(r.socket.data('book', ETH)).toHaveLength(1);
    expect(clientBook(r.socket, BTC)?.sequence).toBe(11);
    expect(clientBook(r.socket, ETH)?.sequence).toBe(10);
  });

  it('is idempotent: subscribing twice holds one seat and reports it', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    expect(r.session.subscriptions).toBe(1);
    expect(r.depth.connections).toBe(1);
    expect(r.socket.acks()[1].results[0]).toMatchObject({ ok: true, note: 'already subscribed' });
  });

  it('unsubscribe stops the frames and gives the hub seat back', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }, { ch: 'trades', market: BTC }, { ch: 'ticker' }] });
    expect(r.depth.connections + r.trades.connections + r.tickers.connections).toBe(3);
    await r.send({ op: 'unsubscribe', channels: [{ ch: 'book', market: BTC }, { ch: 'trades', market: BTC }, { ch: 'ticker' }] });
    expect(r.socket.acks()[1].results.every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect(r.depth.connections + r.trades.connections + r.tickers.connections).toBe(0);
    const before = r.socket.frames.length;
    r.depth.ingest(snapshot(12, BTC));
    r.trades.ingest(fill(2));
    expect(r.socket.frames.length).toBe(before);
  });

  it('answers unsubscribe of something never subscribed with a typed result, and carries on', async () => {
    await r.send({ op: 'unsubscribe', channels: [{ ch: 'book', market: BTC }] });
    expect(r.socket.acks()[0].results[0]).toMatchObject({ ok: false, code: 'not_subscribed' });
    expect(r.socket.closed).toBeNull();
  });

  it('releases every hub seat when the socket closes', async () => {
    await r.send({
      op: 'subscribe',
      channels: [
        { ch: 'book', market: BTC },
        { ch: 'trades', market: ETH },
        { ch: 'ticker' },
        { ch: 'candles', market: BTC, interval: '1h' },
      ],
    });
    r.session.onClose();
    expect(r.depth.connections + r.trades.connections + r.tickers.connections + r.candles.connections).toBe(0);
  });

  it('accepts a unified symbol, reports the canonical id, and unsubscribes by either spelling', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: 'BTC/USDT' }] });
    expect(r.socket.acks()[0].results[0]).toEqual({ i: 0, ch: 'book', market: BTC, symbol: 'BTC/USDT', ok: true });
    expect(r.socket.data('book', BTC)[0]).toMatchObject({ type: 'snapshot' });
    await r.send({ op: 'unsubscribe', channels: [{ ch: 'book', market: 'BTC/USDT' }] });
    expect(r.socket.acks()[1].results[0]).toMatchObject({ ok: true });
    expect(r.depth.connections).toBe(0);

    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    await r.send({ op: 'unsubscribe', channels: [{ ch: 'book', market: 'BTC/USDT' }] });
    expect(r.socket.acks()[3].results[0]).toMatchObject({ ok: true });
  });

  it('one bad entry is a typed result for that entry; the others and the connection are fine', async () => {
    const listingCalls = vi.spyOn(r.deps.resolver, 'resolve');
    await r.send({
      op: 'subscribe',
      channels: [
        { ch: 'book', market: 'NOPE-USDT' },
        { ch: 'book', market: BTC },
        { ch: 'orders', market: BTC },
        { ch: 'candles', market: BTC, interval: '3m' },
      ],
    });
    const results = r.socket.acks()[0].results;
    expect(results[0]).toMatchObject({ i: 0, ok: false, code: 'unknown_market' });
    expect(results[1]).toMatchObject({ i: 1, ok: true });
    expect(results[2]).toMatchObject({ i: 2, ok: false, code: 'unknown_channel' });
    expect(results[3]).toMatchObject({ i: 3, ok: false, code: 'bad_interval' });
    expect(r.socket.closed).toBeNull();
    expect(r.session.subscriptions).toBe(1);
    expect(listingCalls).toHaveBeenCalledTimes(2); // junk never reached the resolver
  });

  it('answers malformed frames with a typed error and keeps the connection', async () => {
    await r.send('{nope');
    await r.send({ op: 'subscribe' });
    await r.send({ op: 'launch', channels: [{}] });
    expect(r.socket.errors().map((e) => e.code)).toEqual(['bad_json', 'bad_request', 'bad_request']);
    r.session.onBinary();
    expect(r.socket.errors().at(-1)).toMatchObject({ code: 'bad_request' });
    expect(r.socket.closed).toBeNull();
  });

  it('processes operations strictly in order', async () => {
    r.session.onMessage(JSON.stringify({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] }));
    r.session.onMessage(JSON.stringify({ op: 'unsubscribe', channels: [{ ch: 'book', market: BTC }] }));
    await settle();
    expect(r.socket.acks().map((a) => a.for)).toEqual(['subscribe', 'unsubscribe']);
    expect(r.socket.acks()[1].results[0].ok).toBe(true);
    expect(r.depth.connections).toBe(0);
  });
});

describe('sequence numbers and resync', () => {
  it('every book frame carries a sequence, and a client rebuilds the exact book from the envelopes', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    r.depth.ingest(snapshot(11, BTC, [['100', '2']]));
    r.depth.ingest(
      snapshot(12, BTC, [
        ['100', '2'],
        ['99', '4'],
      ]),
    );
    const frames = r.socket.data('book', BTC) as DepthMessage[];
    expect(frames.map((f) => f.type)).toEqual(['snapshot', 'delta', 'delta']);
    for (const f of frames) expect(typeof f.sequence).toBe('number');
    expect(frames.filter((f) => f.type === 'delta').map((f) => (f as { fromSequence: number }).fromSequence)).toEqual([10, 11]);
    expect(clientBook(r.socket, BTC)).toEqual(r.depth.bookFor(BTC));
  });

  it('a client that detects a gap asks for a snapshot and the stream continues from it', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    r.depth.ingest(snapshot(11, BTC));
    r.depth.ingest(snapshot(12, BTC, [['100', '2']]));

    // The client "loses" the sequence-12 delta: a browser's applyDelta refuses 13 on top of 11.
    const frames = r.socket.data('book', BTC) as DepthMessage[];
    let book = bookFromSnapshot(frames[0] as DepthSnapshot);
    const lost = frames.pop()!; // sequence 12
    book = (applyDelta(book, frames[1] as never) as { ok: true; book: DepthBook }).book;
    expect(book.sequence).toBe(11);
    r.depth.ingest(snapshot(13, BTC, [['100', '3']]));
    const delta13 = r.socket.data('book', BTC).at(-1) as { fromSequence: number };
    expect(delta13.fromSequence).toBe(12);
    expect(applyDelta(book, delta13 as never)).toMatchObject({ ok: false }); // the gap, detected by the client
    expect(lost.sequence).toBe(12);

    await r.send({ op: 'resync', id: 'fix', channels: [{ ch: 'book', market: BTC }] });
    expect(r.socket.acks().at(-1)).toMatchObject({ for: 'resync', id: 'fix' });
    expect(r.socket.acks().at(-1).results[0]).toMatchObject({ ok: true, note: 'snapshot sent' });
    const repair = r.socket.data('book', BTC).at(-1) as DepthSnapshot;
    expect(repair).toMatchObject({ type: 'snapshot', sequence: 13 });

    // From the repair on, deltas apply again.
    book = bookFromSnapshot(repair);
    r.depth.ingest(
      snapshot(14, BTC, [
        ['100', '3'],
        ['98', '1'],
      ]),
    );
    const next = r.socket.data('book', BTC).at(-1) as { fromSequence: number; sequence: number };
    expect(next.fromSequence).toBe(13);
    const applied = applyDelta(book, next as never);
    expect(applied.ok).toBe(true);
    expect((applied as { book: DepthBook }).book).toEqual(r.depth.bookFor(BTC));
  });

  it('resync while the connect snapshot is still on its way is told so, and no second snapshot is sent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gated: DepthSource = {
      markets: async () => [BTC, ETH],
      snapshot: async (marketId) => {
        await gate;
        return snapshot(10, marketId);
      },
    };
    const slow = rig({}, 50, gated);
    await slow.depth.refreshMarkets();
    slow.session.start();
    await slow.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    await slow.send({ op: 'resync', channels: [{ ch: 'book', market: BTC }] });
    expect(slow.socket.acks()[1].results[0]).toMatchObject({ ok: true, note: 'the connect snapshot is still on its way' });
    expect(slow.socket.data('book', BTC)).toEqual([]);
    release();
    await settle();
    expect(slow.socket.data('book', BTC).filter((f: DepthMessage) => f.type === 'snapshot')).toHaveLength(1);
  });

  it('resync repairs a ticker and candles with their cached state, and says trades have nothing to repair', async () => {
    await r.send({
      op: 'subscribe',
      channels: [{ ch: 'ticker' }, { ch: 'candles', market: BTC, interval: '1m' }, { ch: 'trades', market: BTC }],
    });
    r.tickers.ingest([tickerRow(BTC, '1')], r.clock.now);
    r.candles.ingest(BTC, '1m', [{ t: 960_000, o: '1', h: '2', l: '1', c: '2', v: '3' }], r.clock.now);
    r.socket.frames.length = 0;
    await r.send({
      op: 'resync',
      channels: [{ ch: 'ticker' }, { ch: 'candles', market: BTC, interval: '1m' }, { ch: 'trades', market: BTC }],
    });
    expect(r.socket.frames.find((f) => f.ch === 'ticker').data).toMatchObject({ type: 'snapshot' });
    expect(r.socket.frames.find((f) => f.ch === 'candles').data).toMatchObject({ type: 'candle', t: 960_000 });
    expect(r.socket.acks()[0].results[2]).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('resync of something not subscribed is a typed result', async () => {
    await r.send({ op: 'resync', channels: [{ ch: 'book', market: BTC }] });
    expect(r.socket.acks()[0].results[0]).toMatchObject({ ok: false, code: 'not_subscribed' });
  });
});

describe('limits', () => {
  it('refuses the channel past the per-connection ceiling and leaves the rest of the connection alone', async () => {
    const small = rig({ maxSubscriptions: 2 });
    await small.depth.refreshMarkets();
    small.session.start();
    await small.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }, { ch: 'trades', market: BTC }, { ch: 'ticker' }] });
    const results = small.socket.acks()[0].results;
    expect(results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, false]);
    expect(results[2]).toMatchObject({ code: 'subscription_limit' });
    expect(small.socket.closed).toBeNull();
    expect(small.session.subscriptions).toBe(2);

    // Freeing one seat lets the next subscribe through.
    await small.send({ op: 'unsubscribe', channels: [{ ch: 'trades', market: BTC }] });
    await small.send({ op: 'subscribe', channels: [{ ch: 'ticker' }] });
    expect(small.socket.acks()[2].results[0].ok).toBe(true);
  });

  it('does not count a repeated subscribe against the ceiling', async () => {
    const small = rig({ maxSubscriptions: 1 });
    await small.depth.refreshMarkets();
    small.session.start();
    await small.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    await small.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    expect(small.socket.acks()[1].results[0].ok).toBe(true);
  });

  it('closes 1008 when the operation budget is exceeded, releasing everything', async () => {
    const tight = rig({ maxOpsPerSecond: 3 });
    await tight.depth.refreshMarkets();
    tight.session.start();
    await tight.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    tight.session.onMessage('{}');
    tight.session.onMessage('{}');
    expect(tight.socket.closed).toBeNull();
    tight.session.onMessage('{}');
    expect(tight.socket.closed).toMatchObject({ code: 1008 });
    expect(tight.socket.closed?.reason).toMatch(/rate_limited|rate/);
    expect(tight.depth.connections).toBe(0);
  });

  it('refills the budget over time', async () => {
    const tight = rig({ maxOpsPerSecond: 2 });
    tight.session.start();
    tight.session.onMessage('{}');
    tight.session.onMessage('{}');
    tight.clock.now += 1000;
    tight.session.onMessage('{}');
    tight.session.onMessage('{}');
    expect(tight.socket.closed).toBeNull();
  });

  it('charges a subscribe of N channels N tokens: 64 channels against a budget of 2 is refused outright', async () => {
    const tight = rig({ maxOpsPerSecond: 2, maxSubscriptions: 100 });
    await tight.depth.refreshMarkets();
    tight.session.start();
    const sixtyFour = Array.from({ length: 64 }, () => ({ ch: 'ticker' }));
    tight.session.onMessage(JSON.stringify({ op: 'subscribe', channels: sixtyFour }));
    await settle();
    expect(tight.socket.closed).toMatchObject({ code: 1008 });
    expect(tight.socket.acks()).toEqual([]);
    expect(tight.tickers.connections).toBe(0);
  });

  it('spends exactly N tokens on N channels, then refuses the next large operation until the bucket refills', async () => {
    const tight = rig({ maxOpsPerSecond: 10, maxSubscriptions: 100 });
    await tight.depth.refreshMarkets();
    tight.session.start();
    const six = (market: string) =>
      Array.from({ length: 6 }, (_, i) => ({ ch: 'candles', market, interval: (['1m', '5m', '15m', '1h', '4h', '1d'] as const)[i] }));
    await tight.send({ op: 'subscribe', channels: six(BTC) }); // 6 of 10 tokens
    expect(tight.socket.closed).toBeNull();
    expect(tight.session.subscriptions).toBe(6);
    tight.clock.now += 400; // +4 tokens → 8
    await tight.send({ op: 'subscribe', channels: six(ETH) }); // needs 6 → ok, 2 left
    expect(tight.socket.closed).toBeNull();
    await tight.send({ op: 'unsubscribe', channels: six(ETH).slice(0, 3) }); // needs 3 of 2 → closed
    expect(tight.socket.closed).toMatchObject({ code: 1008 });
  });

  it('closes 1008 when a client queues more operations than it is waiting answers for', async () => {
    const hang = rig({
      maxOpsPerSecond: 1000,
      resolver: { resolve: () => new Promise(() => undefined) },
    });
    hang.session.start();
    for (let i = 0; i <= MUX_MAX_PENDING_OPS; i += 1) {
      hang.session.onMessage(JSON.stringify({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] }));
    }
    expect(hang.socket.closed).toMatchObject({ code: 1008 });
  });

  it('refuses to run on an unpublished ceiling: closed 1008 with the *_unset name', () => {
    for (const [override, name] of [
      [{ maxSubscriptions: undefined }, 'mux_max_subscriptions_unset'],
      [{ maxOpsPerSecond: undefined }, 'mux_max_ops_per_second_unset'],
      [{ highWaterBytes: undefined }, 'high_water_bytes_unset'],
    ] as const) {
      const unpublished = rig(override);
      expect(unpublished.session.start()).toBe(false);
      expect(unpublished.socket.closed?.code).toBe(1008);
      expect(unpublished.socket.closed?.reason).toContain(name);
    }
  });

  it('reports a full hub as at_capacity for that channel only', async () => {
    const full = rig({}, 1);
    await full.depth.refreshMarkets();
    full.session.start();
    await full.send({
      op: 'subscribe',
      channels: [
        { ch: 'book', market: BTC },
        { ch: 'book', market: ETH },
        { ch: 'trades', market: BTC },
      ],
    });
    const results = full.socket.acks()[0].results;
    expect(results[0].ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, code: 'at_capacity' });
    expect(results[2].ok).toBe(true);
    expect(full.socket.closed).toBeNull();
  });
});

describe('backpressure — slow clients are dropped with a clear close code', () => {
  it('closes the whole connection 1013 "slow consumer" when a hub gives up on it, and releases every seat', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }, { ch: 'trades', market: BTC }, { ch: 'ticker' }] });
    r.socket.bufferedBytes = 50_000;
    for (let i = 0; i < 4 && r.socket.closed === null; i += 1) r.depth.ingest(snapshot(11 + i, BTC, [['100', String(i + 2)]]));
    expect(r.socket.closed?.code).toBe(1013);
    expect(r.socket.closed?.reason).toMatch(/slow consumer/);
    expect(r.depth.connections + r.trades.connections + r.tickers.connections).toBe(0);
  });

  it('a ticker-only subscriber is dropped the same way', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'ticker' }] });
    r.socket.bufferedBytes = 50_000;
    for (let i = 1; i <= 4 && r.socket.closed === null; i += 1) r.tickers.flush(r.clock.now + i);
    expect(r.socket.closed?.code).toBe(1013);
    expect(r.tickers.connections).toBe(0);
  });

  it('a lagging book is repaired with a snapshot once the socket drains (no close if it recovers in time)', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    r.socket.bufferedBytes = 50_000;
    r.depth.ingest(snapshot(11, BTC, [['100', '2']]));
    r.socket.bufferedBytes = 0;
    r.depth.ingest(snapshot(12, BTC, [['100', '3']]));
    expect(r.socket.closed).toBeNull();
    expect((r.socket.data('book', BTC).at(-1) as DepthMessage).type).toBe('snapshot');
    expect(clientBook(r.socket, BTC)).toEqual(r.depth.bookFor(BTC));
  });

  it('closes 1013 instead of answering a client whose control-frame backlog is unread', async () => {
    r.socket.bufferedBytes = 50_000;
    await r.send({ op: 'subscribe', channels: [{ ch: 'ticker' }] });
    expect(r.socket.closed?.code).toBe(1013);
  });

  it('server shutdown (hub closeAll, 1001) closes the connection with a reason', async () => {
    await r.send({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] });
    r.depth.closeAll(1001, 'shutting down');
    expect(r.socket.closed).toEqual({ code: 1001, reason: 'shutting down' });
  });

  it('a market the listing drops later is an error frame for that channel, not a closed connection', async () => {
    await r.send({
      op: 'subscribe',
      channels: [
        { ch: 'book', market: BTC },
        { ch: 'trades', market: ETH },
      ],
    });
    // Simulate a hub evicting only one channel (e.g. trades seed failure → 1013 "trades unavailable").
    (r.trades as unknown as { closeAll(code: number, reason: string): void }).closeAll(1013, 'trades unavailable');
    expect(r.socket.closed).toBeNull();
    expect(r.socket.errors().at(-1)).toMatchObject({ op: 'error', code: 'unavailable', ch: 'trades', market: ETH });
    expect(r.session.subscriptions).toBe(1);
  });
});

describe('idle sockets', () => {
  it('a connection with no subscription expires after idleMs; a subscription resets it; dropping the last starts it again', async () => {
    const idle = rig({ idleMs: 5_000 });
    await idle.depth.refreshMarkets();
    idle.session.start();
    expect(idle.session.idleExpired(idle.clock.now + 4_999)).toBe(false);
    expect(idle.session.idleExpired(idle.clock.now + 5_000)).toBe(true);

    await idle.send({ op: 'subscribe', channels: [{ ch: 'ticker' }] });
    expect(idle.session.idleExpired(idle.clock.now + 60_000)).toBe(false);

    idle.clock.now += 20_000;
    await idle.send({ op: 'unsubscribe', channels: [{ ch: 'ticker' }] });
    expect(idle.session.idleExpired(idle.clock.now + 4_999)).toBe(false);
    expect(idle.session.idleExpired(idle.clock.now + 5_000)).toBe(true);

    idle.session.closeIdle();
    expect(idle.socket.closed?.code).toBe(1008);
    expect(idle.socket.closed?.reason).toContain('mux_idle');
    expect(idle.session.idleExpired(idle.clock.now + 60_000)).toBe(false); // already closed
  });

  it('does not expire while an operation is still in flight', async () => {
    const hang = rig({ idleMs: 1_000, resolver: { resolve: () => new Promise(() => undefined) } });
    hang.session.start();
    hang.session.onMessage(JSON.stringify({ op: 'subscribe', channels: [{ ch: 'book', market: BTC }] }));
    expect(hang.session.idleExpired(hang.clock.now + 60_000)).toBe(false);
  });
});
