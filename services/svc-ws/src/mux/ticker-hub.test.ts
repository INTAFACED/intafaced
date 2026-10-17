import { describe, expect, it } from 'vitest';
import { CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink } from '../depth/hub.js';
import { TickerHub, TICKER_UNAVAILABLE, type TickerHubOptions, type TickerRow } from './ticker-hub.js';

class FakeSink implements DepthSink {
  bufferedBytes = 0;
  readonly frames: any[] = [];
  closed: { code: number; reason: string } | null = null;
  send(frame: string): void {
    this.frames.push(JSON.parse(frame));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

function row(market: string, last: string, extra: Partial<TickerRow> = {}): TickerRow {
  return {
    market,
    symbol: `${market}/USDT`,
    last,
    change24h: '1',
    changePct24h: '0.5',
    high: '110',
    low: '90',
    volume: '12',
    quoteVolume: '1200',
    ...extra,
  };
}

function hub(overrides: Partial<TickerHubOptions> = {}): TickerHub {
  return new TickerHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: 4, throttleMs: 1000, ...overrides });
}

describe('TickerHub — the throttle', () => {
  it('sends a market at most once per throttle window, with its newest values', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(null, sink, 0);
    h.ingest([row('BTC', '100')], 0);
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]).toMatchObject({ type: 'update', tickers: [{ market: 'BTC', last: '100' }] });

    // Ten changes inside the window: nothing leaves.
    for (let t = 100; t <= 900; t += 100) h.ingest([row('BTC', String(100 + t))], t);
    expect(sink.frames).toHaveLength(1);

    // The window ends: exactly one frame, carrying the LAST value, not the ten between.
    h.flush(1000);
    expect(sink.frames).toHaveLength(2);
    expect(sink.frames[1].tickers).toEqual([expect.objectContaining({ market: 'BTC', last: '1000' })]);

    // Flushing again with nothing new sends nothing.
    h.flush(2500);
    expect(sink.frames).toHaveLength(2);
  });

  it('throttles each market on its own clock and batches the eligible ones into one frame', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(null, sink, 0);
    h.ingest([row('BTC', '1'), row('ETH', '1')], 0);
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0].tickers.map((r: TickerRow) => r.market).sort()).toEqual(['BTC', 'ETH']);

    h.ingest([row('BTC', '2'), row('ETH', '1')], 600); // only BTC changed
    h.ingest([row('BTC', '2'), row('ETH', '2')], 900); // ETH changes later
    expect(sink.frames).toHaveLength(1);

    h.flush(1000); // BTC's window is over (0 → 1000); ETH was last sent at 0 too, so both are due
    expect(sink.frames).toHaveLength(2);
    expect(sink.frames[1].tickers.map((r: TickerRow) => `${r.market}:${r.last}`).sort()).toEqual(['BTC:2', 'ETH:2']);

    h.ingest([row('BTC', '3'), row('ETH', '2')], 1500); // BTC changed 500 ms after its last send
    h.flush(1999);
    expect(sink.frames).toHaveLength(2);
    h.flush(2000);
    expect(sink.frames).toHaveLength(3);
    expect(sink.frames[2].tickers).toEqual([expect.objectContaining({ market: 'BTC', last: '3' })]);
  });

  it('never re-sends a market that did not change', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(null, sink, 0);
    h.ingest([row('BTC', '5')], 0);
    for (let t = 1000; t <= 5000; t += 1000) h.ingest([row('BTC', '5')], t);
    expect(sink.frames).toHaveLength(1);
  });

  it('hands a new subscriber the cached state at once, not after the next poll', () => {
    const h = hub();
    const first = new FakeSink();
    h.attach(null, first, 0);
    h.ingest([row('BTC', '1'), row('ETH', '2')], 0);

    const late = new FakeSink();
    h.attach(null, late, 300);
    expect(late.frames).toHaveLength(1);
    expect(late.frames[0]).toMatchObject({ type: 'snapshot' });
    expect(late.frames[0].tickers).toHaveLength(2);
  });

  it('a single-market subscriber only ever sees that market', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach('ETH', sink, 0);
    h.ingest([row('BTC', '1'), row('ETH', '2')], 0);
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0].tickers).toEqual([expect.objectContaining({ market: 'ETH' })]);
  });

  it('drops a market the source stopped listing instead of serving a stale price', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(null, sink, 0);
    h.ingest([row('BTC', '1'), row('ETH', '2')], 0);
    h.ingest([row('BTC', '1')], 1000);
    const late = new FakeSink();
    h.attach(null, late, 1000);
    expect(late.frames[0].tickers.map((r: TickerRow) => r.market)).toEqual(['BTC']);
  });

  it('keeps null as null — an unpublished field is never turned into zero', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(null, sink, 0);
    h.ingest([row('NEW', '5', { high: null, low: null, volume: null, quoteVolume: null, changePct24h: null, change24h: null })], 0);
    expect(sink.frames[0].tickers[0]).toMatchObject({ high: null, low: null, volume: null, changePct24h: null });
  });
});

describe('TickerHub — absence, refusal and cleanup', () => {
  it('names the outage once, sends no stale rows, and repairs with a snapshot on recovery', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(null, sink, 0);
    h.ingest([row('BTC', '1')], 0);

    h.markUnavailable();
    h.markUnavailable();
    const statuses = sink.frames.filter((f) => f.type === 'status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual({ type: 'status', code: TICKER_UNAVAILABLE });

    const late = new FakeSink();
    h.attach(null, late, 10);
    expect(late.frames).toEqual([{ type: 'status', code: TICKER_UNAVAILABLE }]);

    h.ingest([row('BTC', '2')], 20);
    expect(sink.frames.at(-1)).toMatchObject({ type: 'snapshot', tickers: [{ market: 'BTC', last: '2' }] });
    expect(late.frames.at(-1)).toMatchObject({ type: 'snapshot' });
  });

  it('drops its cache when the last subscriber leaves, so nobody is handed a stale price', () => {
    const h = hub();
    const sink = new FakeSink();
    const detach = h.attach(null, sink, 0)!;
    h.ingest([row('BTC', '1')], 0);
    detach();
    expect(h.stats.markets).toBe(0);
    const late = new FakeSink();
    h.attach(null, late, 5000);
    expect(late.frames).toEqual([]);
  });

  it('asks the poller for data when a subscriber arrives to an empty cache', () => {
    let demanded = 0;
    const h = hub({ onDemand: () => (demanded += 1) });
    h.attach(null, new FakeSink(), 0);
    expect(demanded).toBe(1);
  });

  it('refuses an unpublished ceiling and a full hub with a typed close', () => {
    const noWater = new FakeSink();
    expect(hub({ highWaterBytes: undefined }).attach(null, noWater, 0)).toBeNull();
    expect(noWater.closed?.code).toBe(CLOSE_POLICY);
    const noMax = new FakeSink();
    expect(hub({ maxConnections: undefined }).attach(null, noMax, 0)).toBeNull();
    expect(noMax.closed?.code).toBe(CLOSE_POLICY);
    const h = hub({ maxConnections: 1 });
    h.attach(null, new FakeSink(), 0);
    const over = new FakeSink();
    expect(h.attach(null, over, 0)).toBeNull();
    expect(over.closed?.code).toBe(CLOSE_TRY_LATER);
  });
});

describe('TickerHub — backpressure', () => {
  it('drops updates for a client over the high-water mark, then repairs it with a snapshot once drained', () => {
    const h = hub();
    const slow = new FakeSink();
    h.attach(null, slow, 0);
    h.ingest([row('BTC', '1')], 0);
    slow.frames.length = 0;

    slow.bufferedBytes = 5000;
    h.ingest([row('BTC', '2')], 1000);
    h.ingest([row('BTC', '3')], 2000);
    expect(slow.frames).toHaveLength(0);

    slow.bufferedBytes = 0;
    h.flush(2500);
    expect(slow.frames).toHaveLength(1);
    expect(slow.frames[0]).toMatchObject({ type: 'snapshot', tickers: [{ market: 'BTC', last: '3' }] });
  });

  it('repairs on a quiet tick too — a client that lagged into a still feed is not left on stale prices', () => {
    const h = hub();
    const slow = new FakeSink();
    h.attach(null, slow, 0);
    h.ingest([row('BTC', '1')], 0);
    slow.bufferedBytes = 5000;
    h.ingest([row('BTC', '2')], 1000);
    slow.bufferedBytes = 0;
    slow.frames.length = 0;
    h.flush(1200); // nothing dirty, nothing new
    expect(slow.frames).toEqual([expect.objectContaining({ type: 'snapshot' })]);
  });

  it('closes a client still over the mark after maxLagTicks with 1013 and a slow-consumer reason', () => {
    const h = hub({ maxLagTicks: 3 });
    const slow = new FakeSink();
    h.attach(null, slow, 0);
    slow.bufferedBytes = 5000;
    h.flush(1);
    h.flush(2);
    expect(slow.closed).toBeNull();
    h.flush(3);
    expect(slow.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(slow.closed?.reason).toMatch(/^slow consumer/);
    expect(h.connections).toBe(0);
  });

  it('one slow client does not hold back a healthy one', () => {
    const h = hub();
    const slow = new FakeSink();
    const fast = new FakeSink();
    h.attach(null, slow, 0);
    h.attach(null, fast, 0);
    slow.bufferedBytes = 5000;
    h.ingest([row('BTC', '1')], 0);
    expect(fast.frames).toHaveLength(1);
    expect(slow.frames).toHaveLength(0);
  });
});

describe('TickerHub — resync', () => {
  it('re-sends the full state on request', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(null, sink, 0);
    h.ingest([row('BTC', '1'), row('ETH', '2')], 0);
    sink.frames.length = 0;
    expect(h.resync(sink, 5)).toBe('sent');
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]).toMatchObject({ type: 'snapshot' });
    expect(sink.frames[0].tickers).toHaveLength(2);
    expect(h.resync(new FakeSink(), 5)).toBe('not_subscribed');
  });

  it('says absent, not empty, when there is nothing cached', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach(null, sink, 0);
    expect(h.resync(sink, 5)).toBe('absent');
    expect(sink.frames).toEqual([]);
  });
});
