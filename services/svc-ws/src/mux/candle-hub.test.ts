import { describe, expect, it } from 'vitest';
import { CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink } from '../depth/hub.js';
import { CandleHub, CANDLES_UNAVAILABLE, type CandleHubOptions, type WireCandle } from './candle-hub.js';

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

const MIN = 60_000;
const T0 = 1_700_000_040_000; // a 1m bucket boundary (divisible by 60_000)

function candle(t: number, o: string, h: string, l: string, c: string, v: string): WireCandle {
  return { t, o, h, l, c, v };
}

function hub(overrides: Partial<CandleHubOptions> = {}): CandleHub {
  return new CandleHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: 4, ...overrides });
}

describe('CandleHub — the current candle', () => {
  it('sends a candle when it first appears and again only when it changes', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach('BTC', '1m', sink, T0);
    h.ingest('BTC', '1m', [candle(T0, '100', '100', '100', '100', '1')], T0 + 1_000);
    expect(sink.frames).toEqual([
      { type: 'candle', marketId: 'BTC', interval: '1m', t: T0, o: '100', h: '100', l: '100', c: '100', v: '1', closed: false },
    ]);

    h.ingest('BTC', '1m', [candle(T0, '100', '100', '100', '100', '1')], T0 + 3_000); // same → silence
    expect(sink.frames).toHaveLength(1);

    h.ingest('BTC', '1m', [candle(T0, '100', '105', '99', '104', '3.5')], T0 + 5_000);
    expect(sink.frames).toHaveLength(2);
    expect(sink.frames[1]).toMatchObject({ t: T0, o: '100', h: '105', l: '99', c: '104', v: '3.5', closed: false });
  });

  it('marks a bucket closed once its span has elapsed, and sends the final value exactly once', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach('BTC', '1m', sink, T0);
    h.ingest('BTC', '1m', [candle(T0, '100', '110', '99', '108', '4')], T0 + 30_000);
    sink.frames.length = 0;

    // The poll after the rollover returns [previous, current]. Previous is final now.
    h.ingest(
      'BTC',
      '1m',
      [candle(T0, '100', '110', '99', '108', '4'), candle(T0 + MIN, '108', '108', '108', '108', '1')],
      T0 + MIN + 2_000,
    );
    expect(sink.frames.map((f) => [f.t, f.closed])).toEqual([
      [T0, true],
      [T0 + MIN, false],
    ]);

    sink.frames.length = 0;
    h.ingest(
      'BTC',
      '1m',
      [candle(T0, '100', '110', '99', '108', '4'), candle(T0 + MIN, '108', '108', '108', '108', '1')],
      T0 + MIN + 4_000,
    );
    expect(sink.frames).toEqual([]);
  });

  it('finalises a bucket even when the upstream returns nothing for the quiet minute that followed', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach('BTC', '1m', sink, T0);
    h.ingest('BTC', '1m', [candle(T0, '1', '2', '1', '2', '1')], T0 + 10_000);
    sink.frames.length = 0;
    h.ingest('BTC', '1m', [], T0 + MIN + 5_000);
    expect(sink.frames).toEqual([expect.objectContaining({ t: T0, closed: true })]);
  });

  it('does not invent a candle for a bucket with no fills', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach('BTC', '5m', sink, T0);
    h.ingest('BTC', '5m', [], T0 + 1_000);
    expect(sink.frames).toEqual([]);
  });

  it('keeps market and interval apart: one key never receives another key’s candle', () => {
    const h = hub();
    const m1 = new FakeSink();
    const m5 = new FakeSink();
    const eth = new FakeSink();
    h.attach('BTC', '1m', m1, T0);
    h.attach('BTC', '5m', m5, T0);
    h.attach('ETH', '1m', eth, T0);
    h.ingest('BTC', '1m', [candle(T0, '1', '1', '1', '1', '1')], T0 + 100);
    expect(m1.frames).toHaveLength(1);
    expect(m5.frames).toHaveLength(0);
    expect(eth.frames).toHaveLength(0);
    expect(h.activeKeys.map((k) => `${k.marketId}|${k.interval}`).sort()).toEqual(['BTC|1m', 'BTC|5m', 'ETH|1m']);
  });

  it('serves a late subscriber the cached candles at once, oldest first', () => {
    const h = hub();
    const first = new FakeSink();
    h.attach('BTC', '1m', first, T0);
    h.ingest('BTC', '1m', [candle(T0, '1', '2', '1', '2', '1'), candle(T0 + MIN, '2', '3', '2', '3', '1')], T0 + MIN + 1_000);
    const late = new FakeSink();
    h.attach('BTC', '1m', late, T0 + MIN + 2_000);
    expect(late.frames.map((f) => f.t)).toEqual([T0, T0 + MIN]);
  });

  it('asks for data when a subscriber arrives to an empty cache, and forgets the cache when the last one leaves', () => {
    const demanded: string[] = [];
    const h = hub({ onDemand: (m, i) => demanded.push(`${m}|${i}`) });
    const sink = new FakeSink();
    const detach = h.attach('BTC', '1h', sink, T0)!;
    expect(demanded).toEqual(['BTC|1h']);
    h.ingest('BTC', '1h', [candle(T0, '1', '1', '1', '1', '1')], T0 + 1);
    detach();
    expect(h.activeKeys).toEqual([]);
    h.attach('BTC', '1h', new FakeSink(), T0 + 2);
    expect(demanded).toEqual(['BTC|1h', 'BTC|1h']);
  });

  it('names an outage once per edge and repairs with the real candle afterwards', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach('BTC', '1m', sink, T0);
    h.ingest('BTC', '1m', [candle(T0, '1', '1', '1', '1', '1')], T0 + 1);
    h.markUnavailable('BTC', '1m');
    h.markUnavailable('BTC', '1m');
    expect(sink.frames.filter((f) => f.type === 'status')).toEqual([
      { type: 'status', code: CANDLES_UNAVAILABLE, marketId: 'BTC', interval: '1m' },
    ]);
    sink.frames.length = 0;
    h.ingest('BTC', '1m', [candle(T0, '1', '2', '1', '2', '2')], T0 + 3);
    expect(sink.frames).toEqual([expect.objectContaining({ type: 'candle', c: '2' })]);
  });

  it('refuses unpublished ceilings and a full hub', () => {
    const a = new FakeSink();
    expect(hub({ maxLagTicks: undefined }).attach('B', '1m', a, T0)).toBeNull();
    expect(a.closed?.code).toBe(CLOSE_POLICY);
    const h = hub({ maxConnections: 1 });
    h.attach('B', '1m', new FakeSink(), T0);
    const b = new FakeSink();
    expect(h.attach('B', '1m', b, T0)).toBeNull();
    expect(b.closed?.code).toBe(CLOSE_TRY_LATER);
  });
});

describe('CandleHub — backpressure and resync', () => {
  it('drops frames for a slow client, repairs it once drained, and closes it after maxLagTicks', () => {
    const h = hub({ maxLagTicks: 3 });
    const slow = new FakeSink();
    h.attach('BTC', '1m', slow, T0);
    h.ingest('BTC', '1m', [candle(T0, '1', '1', '1', '1', '1')], T0 + 1);
    slow.frames.length = 0;

    slow.bufferedBytes = 5000;
    h.ingest('BTC', '1m', [candle(T0, '1', '2', '1', '2', '2')], T0 + 2);
    expect(slow.frames).toEqual([]);
    slow.bufferedBytes = 0;
    h.ingest('BTC', '1m', [candle(T0, '1', '3', '1', '3', '3')], T0 + 3);
    expect(slow.frames).toEqual([expect.objectContaining({ c: '3', v: '3' })]);

    slow.bufferedBytes = 5000;
    h.ingest('BTC', '1m', [candle(T0, '1', '4', '1', '4', '4')], T0 + 4);
    h.ingest('BTC', '1m', [candle(T0, '1', '5', '1', '5', '5')], T0 + 5);
    h.ingest('BTC', '1m', [candle(T0, '1', '6', '1', '6', '6')], T0 + 6);
    expect(slow.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(slow.closed?.reason).toMatch(/^slow consumer/);
  });

  it('resync re-sends the cached candles; absent when there are none', () => {
    const h = hub();
    const sink = new FakeSink();
    h.attach('BTC', '1m', sink, T0);
    expect(h.resync(sink, T0)).toBe('absent');
    h.ingest('BTC', '1m', [candle(T0, '1', '1', '1', '1', '1')], T0 + 1);
    sink.frames.length = 0;
    expect(h.resync(sink, T0 + 2)).toBe('sent');
    expect(sink.frames).toEqual([expect.objectContaining({ t: T0 })]);
  });
});
