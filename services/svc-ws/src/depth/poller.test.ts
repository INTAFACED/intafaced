import { describe, expect, it, vi } from 'vitest';
import type { DepthSnapshot } from '@intafaced/market-data';
import { ORDERS_ENGINE_UNAVAILABLE, PrivateOrderHub } from '../private/hub.js';
import { DepthHub, type DepthSink } from './hub.js';
import { DepthPoller } from './poller.js';
import { NativeL3Hub } from './l3-hub.js';
import type { DepthSource, NativeL3Queue } from './source.js';

const MARKET = 'BTC-USDT';
const OTHER = 'ETH-USDT';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function snapshot(marketId: string, sequence: number): DepthSnapshot {
  return { type: 'snapshot', marketId, sequence, bids: [['100', '1']], asks: [['101', '1']] };
}

class RecordingSink implements DepthSink {
  readonly frames: string[] = [];
  bufferedBytes = 0;
  send(frame: string): void {
    this.frames.push(frame);
  }
  close(): void {
    /* no-op */
  }
}

class CountingSource implements DepthSource {
  readonly calls: string[] = [];
  readonly l3Calls: string[] = [];
  sequence = 10;
  failNext = false;
  failMarkets: Error | null = null;
  marketCalls = 0;

  async markets(): Promise<readonly string[]> {
    this.marketCalls += 1;
    if (this.failMarkets) throw this.failMarkets;
    return [MARKET, OTHER];
  }

  async snapshot(marketId: string): Promise<DepthSnapshot> {
    this.calls.push(marketId);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('svc-matching unreachable');
    }
    return snapshot(marketId, (this.sequence += 1));
  }

  async l3Queue(marketId: string): Promise<NativeL3Queue> {
    this.l3Calls.push(marketId);
    return {
      level: 'L3',
      marketId,
      bids: [],
      asks: [{ price: '101', orders: [{ orderId: 'o1', remaining: '1', sequence: 1 }] }],
    };
  }
}

const log = { info: vi.fn(), warn: vi.fn() };

function rig() {
  const source = new CountingSource();
  const hub = new DepthHub(source, {
    depthLimit: 50,
    highWaterBytes: 1_000,
    maxLagTicks: 5,
    maxConnections: 10,
    marketsRefreshMs: 0,
  });
  const poller = new DepthPoller(source, hub, { intervalMs: 1_000, depthLimit: 50, marketsRefreshMs: 30_000 }, log);
  return { source, hub, poller };
}

describe('DepthPoller', () => {
  it('polls only markets that someone is subscribed to', async () => {
    const { source, hub, poller } = rig();
    hub.attach(MARKET, new RecordingSink());
    await settle();
    source.calls.length = 0;

    await poller.tick();

    // ETH has no subscriber. A gateway that polled every listed market would be
    // a recorder, and would cost svc-matching a request per market forever.
    expect(source.calls).toEqual([MARKET]);
  });

  it('does nothing at all when nobody is watching', async () => {
    const { source, poller } = rig();
    await poller.tick();
    expect(source.calls).toEqual([]);
  });

  it('polls native L3 without calling L2 snapshot for L3-only seats', async () => {
    const source = new CountingSource();
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 5,
      maxConnections: 10,
      marketsRefreshMs: 0,
    });
    const l3Hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 5,
      maxConnections: 10,
      ensureKnownMarket: async () => true,
    });
    const poller = new DepthPoller(source, hub, { intervalMs: 1_000, depthLimit: 50, marketsRefreshMs: 30_000, l3Hub }, log);
    l3Hub.attach(MARKET, new RecordingSink());
    await settle();
    source.calls.length = 0;
    source.l3Calls.length = 0;

    await poller.tick();

    expect(source.calls).toEqual([]);
    expect(source.l3Calls).toEqual([MARKET]);
  });

  it('keeps serving the last good book when one poll fails', async () => {
    const { source, hub, poller } = rig();
    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    await settle();
    const before = sink.frames.length;

    source.failNext = true;
    await poller.tick();

    // Socket stays up; last proven book is not replaced with seq-0 empty.
    // Engine-down is named once on the control frame.
    expect(hub.connections).toBe(1);
    expect(hub.matchingAvailable).toBe(false);
    expect(JSON.parse(sink.frames.at(-1)!)).toMatchObject({
      type: 'status',
      code: 'depth.engine_unavailable',
      marketId: MARKET,
    });
    expect(log.warn).toHaveBeenCalled();

    await poller.tick();
    expect(sink.frames.length).toBeGreaterThan(before);
  });

  it('does not stack overlapping sweeps when the upstream is slow', async () => {
    const { source, hub, poller } = rig();
    hub.attach(MARKET, new RecordingSink());
    await settle();
    source.calls.length = 0;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = source.snapshot.bind(source);
    source.snapshot = async (marketId: string) => {
      await gate;
      return original(marketId);
    };

    const first = poller.tick();
    await poller.tick(); // returns immediately — a sweep is already running
    release();
    await first;

    expect(source.calls).toEqual([MARKET]);
  });

  it('names orders.engine_unavailable on a private-only seat when matching is down', async () => {
    const { source, hub, poller } = rig();
    const privateHub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const privateSink = new RecordingSink();
    privateHub.attach('user-a', privateSink);
    source.failMarkets = new Error('svc-matching unreachable');

    const probing = new DepthPoller(
      source,
      hub,
      {
        intervalMs: 1_000,
        depthLimit: 50,
        marketsRefreshMs: 30_000,
        probePrivate: {
          connections: () => privateHub.connections,
          markDown: () => privateHub.markEngineUnavailable(),
          markUp: () => privateHub.noteEngineUp(),
        },
      },
      log,
    );

    await probing.tick();

    expect(source.calls).toEqual([]);
    expect(source.marketCalls).toBe(1);
    expect(privateHub.engineCode).toBe(ORDERS_ENGINE_UNAVAILABLE);
    expect(JSON.parse(privateSink.frames[0]!)).toMatchObject({
      type: 'status',
      code: ORDERS_ENGINE_UNAVAILABLE,
      channel: 'orders',
    });
  });

  it('does not probe matching for private when nobody holds a private seat', async () => {
    const { source, hub } = rig();
    const privateHub = new PrivateOrderHub({ highWaterBytes: 1_000, maxLagTicks: 3, maxConnections: 10, maxConnectionsPerUser: 10 });
    const probing = new DepthPoller(
      source,
      hub,
      {
        intervalMs: 1_000,
        depthLimit: 50,
        marketsRefreshMs: 30_000,
        probePrivate: {
          connections: () => privateHub.connections,
          markDown: () => privateHub.markEngineUnavailable(),
          markUp: () => privateHub.noteEngineUp(),
        },
      },
      log,
    );

    await probing.tick();
    expect(source.marketCalls).toBe(0);
    expect(privateHub.matchingAvailable).toBe(true);
  });

  it('does not turn a refresh window of 0 into a timer that calls refreshMarkets', async () => {
    vi.useFakeTimers();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const source = new CountingSource();
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 5,
      maxConnections: 10,
      marketsRefreshMs: 0,
    });
    const poller = new DepthPoller(source, hub, { intervalMs: 60_000, depthLimit: 50, marketsRefreshMs: 0 }, log);
    try {
      poller.start();
      expect(intervals.mock.calls.map((call) => call[1])).toEqual([60_000]);
      await vi.advanceTimersByTimeAsync(50);
      expect(source.marketCalls).toBe(0);
    } finally {
      poller.stop();
      intervals.mockRestore();
      vi.useRealTimers();
    }
  });

  it('schedules refreshMarkets when the refresh window is positive', async () => {
    vi.useFakeTimers();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const source = new CountingSource();
    const hub = new DepthHub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 5,
      maxConnections: 10,
      marketsRefreshMs: 1_000,
    });
    const poller = new DepthPoller(source, hub, { intervalMs: 60_000, depthLimit: 50, marketsRefreshMs: 1_000 }, log);
    try {
      poller.start();
      expect(intervals.mock.calls.map((call) => call[1])).toEqual([60_000, 1_000]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(source.marketCalls).toBe(1);
    } finally {
      poller.stop();
      intervals.mockRestore();
      vi.useRealTimers();
    }
  });
});
