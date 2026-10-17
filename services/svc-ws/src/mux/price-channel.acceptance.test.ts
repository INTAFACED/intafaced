import { describe, expect, it, vi } from 'vitest';
import type { DepthSink } from '../depth/hub.js';
import { CandleHub, type WireCandle } from './candle-hub.js';
import { MuxPoller } from './poller.js';
import type { CandleSource, MarketDirectory } from './sources.js';
import { TickerHub } from './ticker-hub.js';

/**
 * S11 acceptance. The numbers are the spec (TRD-0009, MKT-0041, MKT-0046, MKT-0077),
 * not a replay of the implementation.
 */

class FakeSink implements DepthSink {
  bufferedBytes = 0;
  readonly frames: Array<{ type?: string; c?: string; code?: string }> = [];
  closed: { code: number; reason: string } | null = null;
  send(frame: string): void {
    this.frames.push(JSON.parse(frame) as { type?: string; c?: string; code?: string });
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

const POLL_MS = 2_000;
const T0 = 1_700_000_040_000;
const CANDLE: WireCandle = { t: T0, o: '1', h: '2', l: '1', c: '2', v: '3' };
const INTERVALS = ['1m', '5m', '15m', '1h'] as const;

const directory: MarketDirectory = {
  refresh: async () => undefined,
  idForSymbol: (symbol) => (symbol === 'BTC/USDT' ? 'id-btc' : null),
  symbolFor: (id) => (id === 'id-btc' ? 'BTC/USDT' : null),
};

function wire(candles: readonly WireCandle[] | Error) {
  const clock = { now: T0 + 1_000 };
  const pending: Promise<void>[] = [];
  let poller!: MuxPoller;
  const hub = new CandleHub({
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 8,
    retainMs: POLL_MS,
    onDemand: (marketId, interval) => {
      pending.push(poller.pollCandle(marketId, interval));
    },
  });
  const candleSource: CandleSource & { latest: ReturnType<typeof vi.fn> } = {
    latest: vi.fn(async () => {
      if (candles instanceof Error) throw candles;
      return candles;
    }),
  };
  poller = new MuxPoller(
    {
      tickers: new TickerHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 4, throttleMs: 1_000 }),
      candles: hub,
      tickerSource: { fetch: async () => [] },
      candleSource,
      directory,
    },
    { tickerPollMs: 1_000, candlePollMs: POLL_MS, flushMs: 250, clock: () => clock.now },
    { info: () => undefined, warn: () => undefined },
  );
  return {
    hub,
    candleSource,
    clock,
    async flush(): Promise<void> {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
      }
    },
  };
}

describe('one price channel costs one operation', () => {
  it('does not read four cold candle keys again when each is dropped and taken back inside one poll window', async () => {
    const w = wire([CANDLE]);
    const first: Array<() => void> = [];
    for (const interval of INTERVALS) {
      const detach = w.hub.attach('id-btc', interval, new FakeSink(), w.clock.now);
      expect(detach).not.toBeNull();
      first.push(detach!);
    }
    await w.flush();
    expect(w.candleSource.latest).toHaveBeenCalledTimes(4);

    for (const detach of first) detach();

    const again: FakeSink[] = [];
    for (const interval of INTERVALS) {
      const sink = new FakeSink();
      const detach = w.hub.attach('id-btc', interval, sink, w.clock.now);
      expect(detach).not.toBeNull();
      again.push(sink);
      detach!();
    }
    await w.flush();

    expect(w.candleSource.latest).toHaveBeenCalledTimes(4);
    for (const sink of again) {
      expect(sink.frames).toEqual([expect.objectContaining({ type: 'candle', c: '2' })]);
    }

    w.clock.now += POLL_MS;
    const after = new FakeSink();
    expect(w.hub.attach('id-btc', '1m', after, w.clock.now)).not.toBeNull();
    await w.flush();
    expect(w.candleSource.latest).toHaveBeenCalledTimes(5);
  });

  it('does not retry a failed candle read when the client resubscribes inside the poll window', async () => {
    const w = wire(new Error('svc-trade down'));
    const first = new FakeSink();
    const detach = w.hub.attach('id-btc', '1m', first, w.clock.now);
    expect(detach).not.toBeNull();
    await w.flush();
    expect(first.frames).toEqual([
      expect.objectContaining({ type: 'status', code: 'candles.unavailable' }),
    ]);
    detach!();

    for (let i = 0; i < 10; i += 1) {
      const sink = new FakeSink();
      const leave = w.hub.attach('id-btc', '1m', sink, w.clock.now);
      expect(leave).not.toBeNull();
      await w.flush();
      expect(sink.frames).toEqual([
        expect.objectContaining({ type: 'status', code: 'candles.unavailable' }),
      ]);
      leave!();
    }

    expect(w.candleSource.latest).toHaveBeenCalledTimes(1);

    w.clock.now += POLL_MS;
    const later = new FakeSink();
    expect(w.hub.attach('id-btc', '1m', later, w.clock.now)).not.toBeNull();
    await w.flush();
    expect(w.candleSource.latest).toHaveBeenCalledTimes(2);
  });

  it('does not read svc-trade once per try when one candle is resubscribed 64 times', async () => {
    const w = wire([CANDLE]);
    const firstDetach = w.hub.attach('id-btc', '1m', new FakeSink(), w.clock.now);
    expect(firstDetach).not.toBeNull();
    await w.flush();
    firstDetach!();

    for (let i = 0; i < 64; i += 1) {
      const sink = new FakeSink();
      const detach = w.hub.attach('id-btc', '1m', sink, w.clock.now);
      expect(detach).not.toBeNull();
      await w.flush();
      expect(sink.frames).toEqual([expect.objectContaining({ type: 'candle', c: '2' })]);
      detach!();
    }

    expect(w.candleSource.latest).toHaveBeenCalledTimes(1);
  });
});
