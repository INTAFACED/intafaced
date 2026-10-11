import { describe, expect, it } from 'vitest';
import type { DepthSnapshot } from '@intafaced/market-data';
import { DEPTH_ENGINE_UNAVAILABLE, DEPTH_L3_UNAVAILABLE } from '../gateway-policy.js';
import { NativeL3Hub } from './l3-hub.js';
import { DepthL3UnavailableError, DepthNoBookError, type DepthSource, type NativeL3Queue } from './source.js';
import { CLOSE_TRY_LATER, type DepthSink } from './hub.js';

const MARKET = 'BTC-USDT';

const native: NativeL3Queue = {
  level: 'L3',
  marketId: MARKET,
  bids: [],
  asks: [{ price: '100', orders: [{ orderId: 'o1', remaining: '1', sequence: 3 }] }],
};

class RecordingSink implements DepthSink {
  readonly frames: string[] = [];
  bufferedBytes = 0;
  closed: { code: number; reason: string } | null = null;
  send(frame: string): void {
    this.frames.push(frame);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

class Source implements DepthSource {
  snapshotCalls = 0;
  queue: NativeL3Queue | DepthL3UnavailableError = native;

  async markets(): Promise<readonly string[]> {
    return [MARKET];
  }

  async snapshot(marketId: string): Promise<DepthSnapshot> {
    this.snapshotCalls += 1;
    return { type: 'snapshot', marketId, sequence: 1, bids: [['100', '9']], asks: [] };
  }

  async l3Queue(marketId: string): Promise<NativeL3Queue> {
    if (this.queue instanceof DepthL3UnavailableError) throw this.queue;
    return { ...this.queue, marketId };
  }
}

describe('NativeL3Hub', () => {
  it('probes matching native L3 and never calls L2 snapshot', async () => {
    const source = new Source();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    expect(await hub.probe(MARKET)).toBe('ok');
    expect(source.snapshotCalls).toBe(0);

    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(sink.frames[0]!)).toMatchObject({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      asks: native.asks,
    });
    expect(JSON.parse(sink.frames[0]!).asks).not.toEqual([['100', '9']]);
  });

  it('a registry throw returns a probe so the upgrade can close 1013, and a known market still probes', async () => {
    const source = new Source();
    const queued: string[] = [];
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      queued.push(marketId);
      return readQueue(marketId);
    };
    let registryDown = true;
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async (marketId) => {
        if (registryDown) throw new Error('every market registry source failed');
        return marketId === MARKET;
      },
    });

    await expect(hub.probe(MARKET)).resolves.toBe('engine');
    expect(queued).toEqual([]);
    expect(hub.stats.code).toBeNull();

    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(sink.frames).toEqual([]);
    expect(queued).toEqual([]);

    registryDown = false;
    await expect(hub.probe(MARKET)).resolves.toBe('ok');
    expect(queued).toEqual([MARKET]);
    await expect(hub.probe('ETH-USDT')).resolves.toBe('unknown');
    expect(queued).toEqual([MARKET]);
  });

  it('probe names unavailable when matching hitch is missing — does not copy L2', async () => {
    const source = new Source();
    source.queue = new DepthL3UnavailableError(MARKET);
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    expect(await hub.probe(MARKET)).toBe('unavailable');
    expect(source.snapshotCalls).toBe(0);
  });

  it('poll tick uses l3Queue only', async () => {
    const source = new Source();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    await new Promise((r) => setTimeout(r, 0));
    source.snapshotCalls = 0;
    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o2', remaining: '2', sequence: 8 }] }],
      asks: [],
    };
    await hub.tick();
    expect(source.snapshotCalls).toBe(0);
    expect(JSON.parse(sink.frames.at(-1)!)).toMatchObject({ level: 'L3', bids: source.queue.bids });
  });

  it('probe/attach snapshot applies the published window — does not dump the full queue', async () => {
    const source = new Source();
    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [
        { price: '98', orders: [{ orderId: 'b3', remaining: '1', sequence: 1 }] },
        { price: '100', orders: [{ orderId: 'b1', remaining: '3', sequence: 2 }] },
        { price: '99', orders: [{ orderId: 'b2', remaining: '2', sequence: 3 }] },
      ],
      asks: [
        { price: '103', orders: [{ orderId: 'a3', remaining: '3', sequence: 4 }] },
        { price: '101', orders: [{ orderId: 'a1', remaining: '1', sequence: 5 }] },
        { price: '102', orders: [{ orderId: 'a2', remaining: '2', sequence: 6 }] },
      ],
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 2,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    expect(await hub.probe(MARKET)).toBe('ok');
    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    await new Promise((r) => setTimeout(r, 0));
    const frame = JSON.parse(sink.frames[0]!) as { bids: Array<{ price: string }>; asks: Array<{ price: string }> };
    expect(frame.bids.map((l) => l.price)).toEqual(['100', '99']);
    expect(frame.asks.map((l) => l.price)).toEqual(['101', '102']);
    expect(source.snapshotCalls).toBe(0);
  });

  it('empty listed queue is nobook — never a live zero snapshot', async () => {
    const source = new Source();
    source.queue = { level: 'L3', marketId: MARKET, bids: [], asks: [] };
    const hub = new NativeL3Hub(source, {
      depthLimit: 2,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    expect(await hub.probe(MARKET)).toBe('nobook');
    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.frames).toEqual([]);
    expect(sink.closed).toBeNull();
  });

  it('a successful empty queue tells a live subscriber the resting orders are gone', async () => {
    const source = new Source();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const live = new RecordingSink();
    hub.attach(MARKET, live);
    await new Promise((r) => setTimeout(r, 0));
    hub.ingest(native);
    expect(JSON.parse(live.frames.at(-1)!)).toMatchObject({
      type: 'snapshot',
      level: 'L3',
      transport: 'poll',
      asks: native.asks,
    });

    hub.ingest({ level: 'L3', marketId: MARKET, bids: [], asks: [] });

    const cleared = JSON.parse(live.frames.at(-1)!) as {
      type?: string;
      code?: string;
      bids?: unknown;
      asks?: unknown;
      sequence?: unknown;
      price?: unknown;
    };
    expect(cleared).toEqual({
      type: 'status',
      code: 'depth.l3_no_resting',
      marketId: MARKET,
    });
    expect(cleared.type).not.toBe('snapshot');
    expect(cleared).not.toHaveProperty('bids');
    expect(cleared).not.toHaveProperty('asks');
    expect(cleared).not.toHaveProperty('sequence');
    expect(cleared).not.toHaveProperty('price');
    expect(cleared.code).not.toBe(DEPTH_L3_UNAVAILABLE);
    expect(cleared.code).not.toBe(DEPTH_ENGINE_UNAVAILABLE);
    expect(live.frames.at(-1)).not.toContain('o1');
    expect(live.closed).toBeNull();
    expect(hub.stats.code).toBeNull();

    const late = new RecordingSink();
    hub.attach(MARKET, late);
    await new Promise((r) => setTimeout(r, 0));
    expect(late.frames).toEqual([]);
    expect(late.closed).toBeNull();

    const next: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o2', remaining: '2', sequence: 8 }] }],
      asks: [],
    };
    hub.ingest(next);
    expect(JSON.parse(live.frames.at(-1)!)).toMatchObject({
      type: 'snapshot',
      level: 'L3',
      transport: 'poll',
      bids: next.bids,
      asks: [],
    });
    expect(JSON.parse(late.frames.at(-1)!)).toMatchObject({
      type: 'snapshot',
      level: 'L3',
      bids: next.bids,
    });
    const resent = JSON.parse(live.frames.at(-1)!) as { bids: Array<{ price: string; orders: Array<{ remaining: string }> }> };
    expect(resent.bids[0]!.price).toBe('99');
    expect(resent.bids[0]!.orders[0]!.remaining).toBe('2');
  });

  it('sends the recovered queue after the engine was down even when that queue is unchanged', async () => {
    const source = new Source();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const live = new RecordingSink();
    hub.attach(MARKET, live);
    await new Promise((r) => setTimeout(r, 0));
    hub.ingest(native);
    hub.markEngineUnavailable(MARKET);
    expect(JSON.parse(live.frames.at(-1)!)).toEqual({
      type: 'status',
      code: DEPTH_ENGINE_UNAVAILABLE,
      marketId: MARKET,
    });
    expect(hub.stats.code).toBe(DEPTH_ENGINE_UNAVAILABLE);

    hub.ingest(native);

    expect(JSON.parse(live.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [],
      asks: [{ price: '100', orders: [{ orderId: 'o1', remaining: '1', sequence: 3 }] }],
    });
    expect(hub.stats.code).toBeNull();

    const afterRecovery = live.frames.length;
    hub.ingest(native);
    expect(live.frames.length).toBe(afterRecovery);
    expect(hub.stats.code).toBeNull();
    expect(live.closed).toBeNull();
  });

  it('the first subscriber on a recovered idle market refetches l3 instead of replaying a down flag', async () => {
    const source = new Source();
    let l3Calls = 0;
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const watched = new RecordingSink();
    const leaveWatched = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    hub.ingest(native);
    hub.markEngineUnavailable(MARKET);
    expect(JSON.parse(watched.frames.at(-1)!)).toEqual({
      type: 'status',
      code: DEPTH_ENGINE_UNAVAILABLE,
      marketId: MARKET,
    });

    leaveWatched!();
    const recovered: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    source.queue = recovered;
    const callsAfterEngineIdle = l3Calls;
    const afterEngine = new RecordingSink();
    const leaveAfterEngine = hub.attach(MARKET, afterEngine);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBeGreaterThan(callsAfterEngineIdle);
    expect(afterEngine.frames.some((frame) => JSON.parse(frame).code === DEPTH_ENGINE_UNAVAILABLE)).toBe(false);
    expect(JSON.parse(afterEngine.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(afterEngine.closed).toBeNull();

    hub.markL3Unavailable(MARKET);
    expect(JSON.parse(afterEngine.frames.at(-1)!)).toEqual({
      type: 'status',
      code: DEPTH_L3_UNAVAILABLE,
      marketId: MARKET,
    });
    leaveAfterEngine!();
    const afterL3: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [],
      asks: [{ price: '100', orders: [{ orderId: 'o1', remaining: '1', sequence: 3 }] }],
    };
    source.queue = afterL3;
    const callsAfterL3Idle = l3Calls;
    const afterUnavailable = new RecordingSink();
    hub.attach(MARKET, afterUnavailable);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBeGreaterThan(callsAfterL3Idle);
    expect(afterUnavailable.frames.some((frame) => JSON.parse(frame).code === DEPTH_L3_UNAVAILABLE)).toBe(false);
    expect(afterUnavailable.frames.some((frame) => JSON.parse(frame).code === DEPTH_ENGINE_UNAVAILABLE)).toBe(false);
    expect(JSON.parse(afterUnavailable.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [],
      asks: [{ price: '100', orders: [{ orderId: 'o1', remaining: '1', sequence: 3 }] }],
    });
    expect(afterUnavailable.closed).toBeNull();
  });

  it('ingest does not leave a snapshot for a subscriber who arrives after the market went idle', async () => {
    const source = new Source();
    let l3Calls = 0;
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    hub.ingest(native);
    leave!();

    hub.ingest({
      level: 'L3',
      marketId: MARKET,
      bids: [],
      asks: [{ price: '101', orders: [{ orderId: 'stale', remaining: '9', sequence: 4 }] }],
    });
    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '97', orders: [{ orderId: 'live', remaining: '5', sequence: 12 }] }],
      asks: [],
    };
    const callsAtIdle = l3Calls;
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBeGreaterThan(callsAtIdle);
    expect(JSON.stringify(next.frames)).not.toContain('stale');
    expect(JSON.stringify(next.frames)).not.toContain('"101"');
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '97', orders: [{ orderId: 'live', remaining: '5', sequence: 12 }] }],
      asks: [],
    });
    expect(next.closed).toBeNull();
  });

  it('an in-flight tick rejection after the last watcher leaves does not tell the next subscriber the feed is down', async () => {
    const source = new Source();
    let l3Calls = 0;
    let gate: Promise<void> = Promise.resolve();
    let rejectPoll: (err: unknown) => void = () => undefined;
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      await gate;
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    gate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const poll = hub.tick();
    leave!();
    rejectPoll(new DepthL3UnavailableError(MARKET));
    gate = Promise.resolve();
    await poll;

    const recovered: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    source.queue = recovered;
    const callsAtIdle = l3Calls;
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));

    expect(hub.stats.code).toBeNull();
    expect(l3Calls).toBeGreaterThan(callsAtIdle);
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_L3_UNAVAILABLE)).toBe(false);
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_ENGINE_UNAVAILABLE)).toBe(false);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(next.closed).toBeNull();
  });

  it('a tick rejection sampled before the market went idle does not leave the next opener on that down frame', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let rejectPoll: (err: unknown) => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        await pollGate;
      }
      return readQueue(marketId);
    };
    let holdKnown = false;
    let releaseKnown: () => void = () => undefined;
    let knownGate: Promise<void> = Promise.resolve();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => {
        if (holdKnown) await knownGate;
        return true;
      },
    });

    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    holdPoll = true;
    pollGate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const poll = hub.tick();
    leave!();

    holdKnown = true;
    knownGate = new Promise<void>((resolve) => {
      releaseKnown = resolve;
    });
    const recovered: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    source.queue = recovered;
    const callsBeforeOpen = l3Calls;
    const next = new RecordingSink();
    hub.attach(MARKET, next);

    rejectPoll(new DepthL3UnavailableError(MARKET));
    await poll;
    releaseKnown();
    await new Promise((r) => setTimeout(r, 0));

    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(l3Calls).toBeGreaterThan(callsBeforeOpen);
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_L3_UNAVAILABLE)).toBe(false);
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_ENGINE_UNAVAILABLE)).toBe(false);
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
  });

  it('a tick rejection sampled before the market went idle does not replace the queue the next subscriber already refetched', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let rejectPoll: (err: unknown) => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        await pollGate;
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    holdPoll = true;
    pollGate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const poll = hub.tick();
    leave!();

    const recovered: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    source.queue = recovered;
    const callsAtLeave = l3Calls;
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBeGreaterThan(callsAtLeave);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    const callsAfterRefetch = l3Calls;
    rejectPoll(new Error('matching engine down'));
    await poll;
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBe(callsAfterRefetch);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_L3_UNAVAILABLE)).toBe(false);
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_ENGINE_UNAVAILABLE)).toBe(false);
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
  });

  it('a no-book error sampled before the market went idle does not forget the queue the next subscriber refetched', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let rejectPoll: (err: unknown) => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        await pollGate;
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    holdPoll = true;
    pollGate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const poll = hub.tick();
    leave!();

    const recovered: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    source.queue = recovered;
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));
    const callsAfterRefetch = l3Calls;

    rejectPoll(new DepthNoBookError(MARKET));
    await poll;

    const peer = new RecordingSink();
    hub.attach(MARKET, peer);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBe(callsAfterRefetch);
    expect(peer.frames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: 'snapshot',
        transport: 'poll',
        level: 'L3',
        marketId: MARKET,
        bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
        asks: [],
      },
    ]);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
    expect(peer.closed).toBeNull();
  });

  it('a tick rejection still marks a market that stayed watched while subscribers changed', async () => {
    const source = new Source();
    let gate: Promise<void> = Promise.resolve();
    let rejectPoll: (err: unknown) => void = () => undefined;
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      await gate;
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    const first = new RecordingSink();
    const leave = hub.attach(MARKET, first);
    await new Promise((r) => setTimeout(r, 0));
    gate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const poll = hub.tick();
    const second = new RecordingSink();
    hub.attach(MARKET, second);
    await new Promise((r) => setTimeout(r, 0));
    leave!();
    rejectPoll(new DepthL3UnavailableError(MARKET));
    await poll;

    expect(JSON.parse(second.frames.at(-1)!)).toEqual({
      type: 'status',
      code: DEPTH_L3_UNAVAILABLE,
      marketId: MARKET,
    });
    expect(hub.stats.code).toBe(DEPTH_L3_UNAVAILABLE);
    expect(second.closed).toBeNull();
  });

  it('a refetch rejection sampled before the market went idle does not leave the next opener on that down frame', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let rejectPoll: (err: unknown) => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        await pollGate;
      }
      return readQueue(marketId);
    };
    let holdKnown = false;
    let releaseKnown: () => void = () => undefined;
    let knownGate: Promise<void> = Promise.resolve();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => {
        if (holdKnown) await knownGate;
        return true;
      },
    });

    holdPoll = true;
    pollGate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    expect(l3Calls).toBe(1);
    leave!();

    holdKnown = true;
    knownGate = new Promise<void>((resolve) => {
      releaseKnown = resolve;
    });
    const recovered: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    source.queue = recovered;
    const callsBeforeOpen = l3Calls;
    const next = new RecordingSink();
    hub.attach(MARKET, next);

    rejectPoll(new DepthL3UnavailableError(MARKET));
    await new Promise((r) => setTimeout(r, 0));
    releaseKnown();
    await new Promise((r) => setTimeout(r, 0));

    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(l3Calls).toBeGreaterThan(callsBeforeOpen);
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_L3_UNAVAILABLE)).toBe(false);
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_ENGINE_UNAVAILABLE)).toBe(false);
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
  });

  it('a refetch rejection sampled before the market went idle does not replace the queue the next subscriber already refetched', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let rejectPoll: (err: unknown) => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        await pollGate;
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    holdPoll = true;
    pollGate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    expect(l3Calls).toBe(1);
    leave!();

    const recovered: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    source.queue = recovered;
    const callsAtLeave = l3Calls;
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBeGreaterThan(callsAtLeave);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    const callsAfterRefetch = l3Calls;
    rejectPoll(new Error('matching engine down'));
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBe(callsAfterRefetch);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_L3_UNAVAILABLE)).toBe(false);
    expect(next.frames.some((frame) => JSON.parse(frame).code === DEPTH_ENGINE_UNAVAILABLE)).toBe(false);
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
  });

  it('a no-book error from the opener refetch does not forget the queue the next subscriber refetched', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let rejectPoll: (err: unknown) => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        await pollGate;
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    holdPoll = true;
    pollGate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    expect(l3Calls).toBe(1);
    leave!();

    const recovered: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    source.queue = recovered;
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));
    const callsAfterRefetch = l3Calls;

    rejectPoll(new DepthNoBookError(MARKET));
    await new Promise((r) => setTimeout(r, 0));

    const peer = new RecordingSink();
    hub.attach(MARKET, peer);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBe(callsAfterRefetch);
    expect(peer.frames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: 'snapshot',
        transport: 'poll',
        level: 'L3',
        marketId: MARKET,
        bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
        asks: [],
      },
    ]);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
    expect(peer.closed).toBeNull();
  });

  it('a refetch rejection still marks a market that stayed watched while the opener was in flight', async () => {
    const source = new Source();
    let holdPoll = false;
    let rejectPoll: (err: unknown) => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      if (holdPoll) {
        holdPoll = false;
        await pollGate;
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    holdPoll = true;
    pollGate = new Promise<void>((_resolve, reject) => {
      rejectPoll = reject;
    });
    const first = new RecordingSink();
    const leave = hub.attach(MARKET, first);
    await new Promise((r) => setTimeout(r, 0));
    const second = new RecordingSink();
    hub.attach(MARKET, second);
    await new Promise((r) => setTimeout(r, 0));
    leave!();
    rejectPoll(new DepthL3UnavailableError(MARKET));
    await new Promise((r) => setTimeout(r, 0));

    expect(JSON.parse(second.frames.at(-1)!)).toEqual({
      type: 'status',
      code: DEPTH_L3_UNAVAILABLE,
      marketId: MARKET,
    });
    expect(hub.stats.code).toBe(DEPTH_L3_UNAVAILABLE);
    expect(second.closed).toBeNull();
  });

  it('a pre-idle tick that resolves does not hand its captured book to a subscriber still waiting to open', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let releasePoll: () => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        const captured = source.queue;
        await pollGate;
        if (captured instanceof DepthL3UnavailableError) throw captured;
        return { ...captured, marketId };
      }
      return readQueue(marketId);
    };
    let holdKnown = false;
    let releaseKnown: () => void = () => undefined;
    let knownGate: Promise<void> = Promise.resolve();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => {
        if (holdKnown) await knownGate;
        return true;
      },
    });

    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    holdPoll = true;
    pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const poll = hub.tick();
    leave!();

    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    holdKnown = true;
    knownGate = new Promise<void>((resolve) => {
      releaseKnown = resolve;
    });
    const callsBeforeOpen = l3Calls;
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    releasePoll();
    await poll;
    releaseKnown();
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBeGreaterThan(callsBeforeOpen);
    expect(next.frames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: 'snapshot',
        transport: 'poll',
        level: 'L3',
        marketId: MARKET,
        bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
        asks: [],
      },
    ]);
    expect(JSON.stringify(next.frames)).not.toContain('o1');
    expect(next.closed).toBeNull();
  });

  it('a pre-idle tick that resolves empty does not replace the book the next subscriber refetched', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let releasePoll: () => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        const captured = source.queue;
        await pollGate;
        if (captured instanceof DepthL3UnavailableError) throw captured;
        return { ...captured, marketId };
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    source.queue = { level: 'L3', marketId: MARKET, bids: [], asks: [] };
    holdPoll = true;
    pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const poll = hub.tick();
    leave!();

    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));
    const callsAfterRefetch = l3Calls;
    releasePoll();
    await poll;

    const peer = new RecordingSink();
    hub.attach(MARKET, peer);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBe(callsAfterRefetch);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(next.frames.some((frame) => JSON.parse(frame).code === 'depth.l3_no_resting')).toBe(false);
    expect(peer.frames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: 'snapshot',
        transport: 'poll',
        level: 'L3',
        marketId: MARKET,
        bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
        asks: [],
      },
    ]);
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
    expect(peer.closed).toBeNull();
  });

  it('a pre-idle tick that resolves to its captured book does not replace the book the next subscriber refetched', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let releasePoll: () => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        const captured = source.queue;
        await pollGate;
        if (captured instanceof DepthL3UnavailableError) throw captured;
        return { ...captured, marketId };
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    holdPoll = true;
    pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const poll = hub.tick();
    leave!();

    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));
    const callsAfterRefetch = l3Calls;
    releasePoll();
    await poll;

    const peer = new RecordingSink();
    hub.attach(MARKET, peer);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBe(callsAfterRefetch);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(JSON.stringify(next.frames)).not.toContain('o1');
    expect(peer.frames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: 'snapshot',
        transport: 'poll',
        level: 'L3',
        marketId: MARKET,
        bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
        asks: [],
      },
    ]);
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
    expect(peer.closed).toBeNull();
  });

  it('a pre-idle opener refetch that resolves to its captured book does not replace the book the next subscriber refetched', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let releasePoll: () => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        const captured = source.queue;
        await pollGate;
        if (captured instanceof DepthL3UnavailableError) throw captured;
        return { ...captured, marketId };
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    holdPoll = true;
    pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    expect(l3Calls).toBe(1);
    leave!();

    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));
    const callsAfterRefetch = l3Calls;
    releasePoll();
    await new Promise((r) => setTimeout(r, 0));

    const peer = new RecordingSink();
    hub.attach(MARKET, peer);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBe(callsAfterRefetch);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(JSON.stringify(next.frames)).not.toContain('o1');
    expect(peer.frames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: 'snapshot',
        transport: 'poll',
        level: 'L3',
        marketId: MARKET,
        bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
        asks: [],
      },
    ]);
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
    expect(peer.closed).toBeNull();
  });

  it('a pre-idle opener refetch that resolves empty does not replace the book the next subscriber refetched', async () => {
    const source = new Source();
    let l3Calls = 0;
    let holdPoll = false;
    let releasePoll: () => void = () => undefined;
    let pollGate: Promise<void> = Promise.resolve();
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      if (holdPoll) {
        holdPoll = false;
        const captured = source.queue;
        await pollGate;
        if (captured instanceof DepthL3UnavailableError) throw captured;
        return { ...captured, marketId };
      }
      return readQueue(marketId);
    };
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });

    source.queue = { level: 'L3', marketId: MARKET, bids: [], asks: [] };
    holdPoll = true;
    pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    expect(l3Calls).toBe(1);
    leave!();

    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    const next = new RecordingSink();
    hub.attach(MARKET, next);
    await new Promise((r) => setTimeout(r, 0));
    const callsAfterRefetch = l3Calls;
    releasePoll();
    await new Promise((r) => setTimeout(r, 0));

    const peer = new RecordingSink();
    hub.attach(MARKET, peer);
    await new Promise((r) => setTimeout(r, 0));

    expect(l3Calls).toBe(callsAfterRefetch);
    expect(JSON.parse(next.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    });
    expect(next.frames.some((frame) => JSON.parse(frame).code === 'depth.l3_no_resting')).toBe(false);
    expect(peer.frames.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: 'snapshot',
        transport: 'poll',
        level: 'L3',
        marketId: MARKET,
        bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
        asks: [],
      },
    ]);
    expect(hub.stats.code).toBeNull();
    expect(next.closed).toBeNull();
    expect(peer.closed).toBeNull();
  });

  it('two subscribers attaching together on a recovered idle market both receive the current book', async () => {
    const source = new Source();
    let l3Calls = 0;
    const readQueue = source.l3Queue.bind(source);
    source.l3Queue = async (marketId: string) => {
      l3Calls += 1;
      return readQueue(marketId);
    };
    let holdKnown = false;
    let releaseKnown: () => void = () => undefined;
    let knownGate: Promise<void> = Promise.resolve();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => {
        if (holdKnown) await knownGate;
        return true;
      },
    });

    const watched = new RecordingSink();
    const leave = hub.attach(MARKET, watched);
    await new Promise((r) => setTimeout(r, 0));
    leave!();
    source.queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    holdKnown = true;
    knownGate = new Promise<void>((resolve) => {
      releaseKnown = resolve;
    });
    const callsAtIdle = l3Calls;
    const first = new RecordingSink();
    const second = new RecordingSink();
    hub.attach(MARKET, first);
    hub.attach(MARKET, second);
    releaseKnown();
    await new Promise((r) => setTimeout(r, 0));

    const current = {
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '99', orders: [{ orderId: 'o9', remaining: '4', sequence: 11 }] }],
      asks: [],
    };
    expect(l3Calls).toBeGreaterThan(callsAtIdle);
    expect(first.frames.map((frame) => JSON.parse(frame))).toEqual([current]);
    expect(second.frames.map((frame) => JSON.parse(frame))).toEqual([current]);
    expect(JSON.stringify(first.frames)).not.toContain('o1');
    expect(JSON.stringify(second.frames)).not.toContain('o1');
    expect(first.closed).toBeNull();
    expect(second.closed).toBeNull();
  });

  it('a subscriber who stayed watched hears depth.l3_no_resting when the current poll is empty', async () => {
    const source = new Source();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const live = new RecordingSink();
    hub.attach(MARKET, live);
    await new Promise((r) => setTimeout(r, 0));
    source.queue = { level: 'L3', marketId: MARKET, bids: [], asks: [] };
    await hub.tick();

    expect(JSON.parse(live.frames.at(-1)!)).toEqual({
      type: 'status',
      code: 'depth.l3_no_resting',
      marketId: MARKET,
    });
    expect(live.closed).toBeNull();
    expect(hub.stats.code).toBeNull();
  });

  it('fan-out names depth.l3_unavailable without an L2 ladder', () => {
    const source = new Source();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 1_000,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    hub.markL3Unavailable(MARKET);
    expect(JSON.parse(sink.frames.at(-1)!)).toEqual({ type: 'status', code: DEPTH_L3_UNAVAILABLE, marketId: MARKET });
    expect(sink.frames.at(-1)!).not.toContain('"bids":[["100"');
  });

  it('a client that misses one update receives that queue when the book stays quiet', async () => {
    const source = new Source();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 10,
      maxLagTicks: 3,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    await new Promise((r) => setTimeout(r, 0));
    const held = JSON.parse(sink.frames[0]!) as { asks: Array<{ price: string; orders: Array<{ remaining: string }> }> };
    expect(held.asks[0]!.price).toBe('100');
    expect(held.asks[0]!.orders[0]!.remaining).toBe('1');

    const quiet: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '97', orders: [{ orderId: 'o9', remaining: '6', sequence: 11 }] }],
      asks: [],
    };
    sink.bufferedBytes = 40;
    hub.ingest(quiet);
    expect(sink.frames).toHaveLength(1);

    sink.bufferedBytes = 0;
    hub.ingest(quiet);

    expect(JSON.parse(sink.frames.at(-1)!)).toEqual({
      type: 'snapshot',
      transport: 'poll',
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '97', orders: [{ orderId: 'o9', remaining: '6', sequence: 11 }] }],
      asks: [],
    });
    expect(sink.closed).toBeNull();
  });

  it('a quiet book that dropped a frame still disconnects a client that stays over the high water', async () => {
    const source = new Source();
    const hub = new NativeL3Hub(source, {
      depthLimit: 50,
      highWaterBytes: 10,
      maxLagTicks: 2,
      maxConnections: 4,
      ensureKnownMarket: async () => true,
    });
    const sink = new RecordingSink();
    hub.attach(MARKET, sink);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(sink.frames[0]!).asks[0]).toMatchObject({ price: '100', orders: [{ remaining: '1' }] });

    const quiet: NativeL3Queue = {
      level: 'L3',
      marketId: MARKET,
      bids: [{ price: '97', orders: [{ orderId: 'o9', remaining: '6', sequence: 11 }] }],
      asks: [],
    };
    sink.bufferedBytes = 40;
    hub.ingest(quiet);
    hub.ingest(quiet);

    expect(sink.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(sink.frames).toHaveLength(1);
    expect(JSON.parse(sink.frames[0]!).asks[0]).toMatchObject({ price: '100', orders: [{ remaining: '1' }] });
    expect(JSON.stringify(sink.frames)).not.toContain('"price":"97"');
    expect(hub.connections).toBe(0);
  });
});
