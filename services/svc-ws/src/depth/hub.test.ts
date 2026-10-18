import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyDelta,
  bookFromSnapshot,
  type DepthBook,
  type DepthMessage,
  type DepthSnapshot,
  type WireLevel,
} from '@intafaced/market-data';
import { DEPTH_MARKET_HALTED, type DepthMatchingTradingCode } from '../matching-trading.js';
import { CLOSE_POLICY, CLOSE_TRY_LATER, DepthHub, type DepthHubOptions, type DepthSink } from './hub.js';
import type { DepthSource } from './source.js';

/**
 * THE FAN-OUT, FROM THE CLIENT'S SIDE.
 *
 * Almost every assertion here goes through `rebuild()`, which does exactly what
 * `apps/web`'s `DepthController` does: take the first snapshot, apply every
 * delta with `@intafaced/market-data`'s `applyDelta`, and REFUSE anything that
 * does not continue. If the server ever emits a `fromSequence` that does not
 * line up, `applyDelta` returns `{ ok: false, reason: 'gap' }` and `rebuild`
 * throws — which is the whole safety property, asserted from the side that has
 * to live with it rather than from the side that produces it.
 *
 * That is deliberate. A test that checked `delta.fromSequence === previous`
 * would pass on a server that renumbered both consistently and shipped a book
 * nobody could rebuild.
 */

const MARKET = 'BTC-USDT';
const OTHER = 'ETH-USDT';

function snapshot(
  sequence: number,
  bids: WireLevel[] = [['100', '1']],
  asks: WireLevel[] = [['101', '1']],
  marketId = MARKET,
): DepthSnapshot {
  return { type: 'snapshot', marketId, sequence, bids, asks };
}

class FakeSink implements DepthSink {
  readonly frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  bufferedBytes = 0;
  /** Set to make `send` throw, the way a socket that has already gone does. */
  broken = false;

  send(frame: string): void {
    if (this.broken) throw new Error('EPIPE');
    this.frames.push(frame);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  messages(): DepthMessage[] {
    return this.frames
      .map((f) => JSON.parse(f) as { type?: string })
      .filter((m): m is DepthMessage => m.type === 'snapshot' || m.type === 'delta');
  }
}

class FakeSource implements DepthSource {
  readonly marketList: string[];
  readonly current = new Map<string, DepthSnapshot>();
  readonly snapshotCalls: string[] = [];
  marketCalls = 0;
  failMarkets: Error | null = null;
  /** When set, every snapshot call rejects with this error (matching down). */
  failSnapshot: Error | null = null;
  /**
   * Optional per-call override. When present for a market, the returned
   * promise is what `#seed` awaits — used to stage seed-vs-poll races.
   */
  pendingSnapshots = new Map<string, Promise<DepthSnapshot>>();
  /** When set, `markets()` awaits this before returning — concurrent miss tests. */
  marketsGate: Promise<void> | null = null;
  /**
   * Matching trading status `#seed` reads. `null` means tradable, same as a
   * source that has not published a halt.
   */
  tradingStatus: DepthMatchingTradingCode | null = null;

  constructor(marketList: string[]) {
    this.marketList = marketList;
  }

  async markets(): Promise<readonly string[]> {
    this.marketCalls += 1;
    if (this.failMarkets) throw this.failMarkets;
    if (this.marketsGate) await this.marketsGate;
    return this.marketList;
  }

  async snapshot(marketId: string): Promise<DepthSnapshot> {
    this.snapshotCalls.push(marketId);
    if (this.failSnapshot) throw this.failSnapshot;
    const pending = this.pendingSnapshots.get(marketId);
    if (pending) return pending;
    const s = this.current.get(marketId);
    if (!s) throw new Error(`no upstream book for ${marketId}`);
    return s;
  }

  trading(): DepthMatchingTradingCode | null {
    return this.tradingStatus;
  }
}

/** Let every pending microtask and timer-0 continuation settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function hubFor(source: FakeSource, overrides: Partial<DepthHubOptions> = {}) {
  return new DepthHub(source, {
    depthLimit: 50,
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    marketsRefreshMs: 0,
    ...overrides,
  });
}

/**
 * A client, built out of nothing but the frames it received.
 *
 * Throws on the two failures that matter: a delta before any snapshot (an
 * ordering bug on the server) and a delta that does not continue (a sequence
 * bug on the server).
 */
function rebuild(sink: FakeSink): DepthBook | null {
  let book: DepthBook | null = null;

  for (const message of sink.messages()) {
    if (message.type === 'snapshot') {
      book = bookFromSnapshot(message);
      continue;
    }
    if (book === null) throw new Error('a delta arrived before any snapshot — the client has no book to apply it to');

    const result = applyDelta(book, message);
    if (!result.ok) throw new Error(`the client refused a delta: ${result.reason} (expected ${result.expected}, got ${result.got})`);
    book = result.book;
  }

  return book;
}

/** Canonical form, so two books can be compared as strings. */
function canonical(book: DepthBook | null): string {
  if (!book) return '<none>';
  const side = (levels: DepthBook['bids']) =>
    [...levels.entries()]
      .map(([p, q]) => `${p}=${q}`)
      .sort()
      .join(',');
  return `${book.marketId}@${book.sequence} bids[${side(book.bids)}] asks[${side(book.asks)}]`;
}

describe('DepthHub — a client can always rebuild the server’s exact book', () => {
  let source: FakeSource;
  let hub: DepthHub;
  let sink: FakeSink;

  beforeEach(() => {
    source = new FakeSource([MARKET, OTHER]);
    source.current.set(MARKET, snapshot(10));
    hub = hubFor(source);
    sink = new FakeSink();
  });

  it('sends a snapshot first, then deltas that continue it', async () => {
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.messages()[0]?.type).toBe('snapshot');

    hub.ingest(snapshot(11, [['100', '2']]));
    hub.ingest(
      snapshot(12, [
        ['100', '2'],
        ['99', '5'],
      ]),
    );

    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  /**
   * THE TEST THIS SERVICE EXISTS FOR.
   *
   * Two hundred ticks of adds, removals, requotes and quiet sequences, rebuilt
   * by the client from the frames alone. Any `fromSequence` that does not line
   * up makes `applyDelta` return `gap` and this throws.
   */
  it('survives a long, noisy stream without a single gap', async () => {
    hub.attach(MARKET, sink);
    await settle();

    // A seeded LCG, not Math.random: a test that fails one run in fifty and
    // cannot be re-run is not a test.
    let seed = 0x5eed;
    const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);

    let sequence = 10;
    const bids = new Map<string, string>([['100', '1']]);
    const asks = new Map<string, string>([['101', '1']]);

    for (let tick = 0; tick < 200; tick += 1) {
      const roll = next();
      const side = roll < 0.5 ? bids : asks;
      // Bids stay below the opening ask and asks stay above the opening bid,
      // so this stream is never a crossed copy. A crossed copy is withheld.
      const price = side === bids ? String(80 + Math.floor(next() * 20)) : String(101 + Math.floor(next() * 20));

      if (roll < 0.15) side.delete(price);
      else if (roll < 0.85) side.set(price, `${(1 + Math.floor(next() * 9)).toString()}.${Math.floor(next() * 1e6)}`);
      // else: the sequence advances with no level change at all, which must
      // still produce a delta or every client falls behind the engine.

      sequence += 1 + Math.floor(next() * 3);
      hub.ingest(snapshot(sequence, [...bids], [...asks]));
    }

    expect(sink.frames.length).toBeGreaterThan(100);
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('emits a delta when the sequence advances but no level changed', async () => {
    hub.attach(MARKET, sink);
    await settle();
    const before = sink.frames.length;

    const delta = hub.ingest(snapshot(11)); // identical levels, higher sequence

    expect(delta).not.toBeNull();
    expect(delta?.fromSequence).toBe(10);
    expect(delta?.sequence).toBe(11);
    expect(delta?.bids).toEqual([]);
    expect(sink.frames.length).toBe(before + 1);
    // Because it was sent, the NEXT delta continues and nobody resnapshots.
    hub.ingest(snapshot(12, [['100', '3']]));
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('says nothing when the sequence has not moved and levels are identical', async () => {
    hub.attach(MARKET, sink);
    await settle();
    const before = sink.frames.length;

    expect(hub.ingest(snapshot(10))).toBeNull();
    expect(sink.frames.length).toBe(before);
  });

  it('force-repairs clients when the same sequence arrives with different levels', async () => {
    // Same sequence, different book: a continuous delta cannot fix this
    // (fromSequence would equal sequence). Without a forced snapshot, the hub
    // would silently hold a book no client was ever told about.
    hub.attach(MARKET, sink);
    await settle();
    const before = sink.frames.length;

    expect(hub.ingest(snapshot(10, [['100', '9']]))).toBeNull();

    const last = sink.messages().at(-1);
    expect(last?.type).toBe('snapshot');
    expect(last?.sequence).toBe(10);
    expect(last?.bids).toEqual([['100', '9']]);
    expect(sink.frames.length).toBe(before + 1);
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('never puts a JSON number where an amount belongs', async () => {
    hub.attach(MARKET, sink);
    await settle();
    hub.ingest(snapshot(11, [['100.123456789012345678', '0.000000000000000001']], [['101.5', '0']]));

    for (const message of sink.messages()) {
      for (const level of [...message.bids, ...message.asks]) {
        expect(typeof level[0]).toBe('string');
        expect(typeof level[1]).toBe('string');
      }
    }
    // The only JSON numbers anywhere in the stream are integer sequences.
    for (const frame of sink.frames) {
      const numbers = [...frame.matchAll(/:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => m[1]!);
      for (const n of numbers) expect(Number.isInteger(Number(n))).toBe(true);
    }
  });
});

describe('DepthHub — snapshot-then-delta ordering across the connect window', () => {
  /**
   * THE CLASSIC BUG.
   *
   * A connection is registered before its snapshot exists, so deltas can and do
   * land in between. Sending one before the snapshot would have the client drop
   * it (it has no book yet); dropping it would leave the client behind. Both
   * are wrong, and both are invisible until a book quietly stops matching.
   *
   * The property asserted is the one that matters: whatever the hub does in
   * that window, the client's rebuilt book must equal the server's, and no
   * delta may reach the wire before a snapshot does.
   */
  it('buffers deltas that arrive while a snapshot is being produced, and loses none', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    const hub = hubFor(source);

    const first = new FakeSink();
    hub.attach(MARKET, first);
    await settle();

    // Second client connects. Its snapshot is produced on a later turn — and
    // the stream does not pause for it.
    const second = new FakeSink();
    hub.attach(MARKET, second);
    hub.ingest(snapshot(11, [['100', '2']]));
    hub.ingest(
      snapshot(12, [
        ['100', '2'],
        ['99', '7'],
      ]),
    );
    await settle();

    // Nothing reached the second client before its snapshot.
    expect(second.messages()[0]?.type).toBe('snapshot');
    // And nothing was lost: both clients hold the server's book, exactly.
    const server = canonical(hub.bookFor(MARKET) ?? null);
    expect(canonical(rebuild(first))).toBe(server);
    expect(canonical(rebuild(second))).toBe(server);
    expect(second.closed).toBeNull();
  });

  it('keeps working when the market is cold and the first snapshot is a round trip', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(30, [['100', '4']]));
    const hub = hubFor(source);

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    // Registered, but nothing sent yet — the upstream fetch has not resolved.
    expect(sink.frames).toEqual([]);

    await settle();

    expect(sink.messages()[0]).toMatchObject({ type: 'snapshot', sequence: 30 });
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });
});

describe('DepthHub — backpressure: degrade, then disconnect', () => {
  let source: FakeSource;
  let hub: DepthHub;

  beforeEach(() => {
    source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    hub = hubFor(source, { highWaterBytes: 1_000, maxLagTicks: 3 });
  });

  it('drops deltas for a backed-up client rather than queueing them', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();
    const afterSnapshot = sink.frames.length;

    sink.bufferedBytes = 5_000; // the peer is not reading
    hub.ingest(snapshot(11, [['100', '2']]));
    hub.ingest(snapshot(12, [['100', '3']]));

    // Nothing was written and nothing was retained — the server holds no queue.
    expect(sink.frames.length).toBe(afterSnapshot);
    expect(hub.stats.droppedFrames).toBe(2);
    expect(sink.closed).toBeNull();
  });

  it('repairs a lagging client with a snapshot, not with the deltas it missed', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    sink.bufferedBytes = 5_000;
    hub.ingest(snapshot(11, [['100', '2']]));
    hub.ingest(snapshot(12, [['100', '3']]));

    sink.bufferedBytes = 0; // drained
    hub.ingest(snapshot(13, [['100', '4']]));

    const last = sink.messages().at(-1);
    expect(last?.type).toBe('snapshot');
    expect(last?.sequence).toBe(13);
    // The client is whole again, from frames alone, with no resnapshot request.
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('repairs a client that lagged into a market that then went quiet', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    sink.bufferedBytes = 5_000;
    hub.ingest(snapshot(11, [['100', '2']]));
    sink.bufferedBytes = 0;

    // A tick with NOTHING new. If repair rode on the delta rather than on the
    // tick, this client would sit on a book it believes is current forever.
    hub.ingest(snapshot(11, [['100', '2']]));

    expect(sink.messages().at(-1)).toMatchObject({ type: 'snapshot', sequence: 11 });
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('disconnects a client that cannot absorb even a snapshot', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    sink.bufferedBytes = 5_000;
    for (let i = 1; i <= 3; i += 1) hub.ingest(snapshot(10 + i));

    expect(sink.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(sink.closed?.reason).toMatch(/slow consumer/);
    expect(hub.connections).toBe(0);
    expect(hub.stats.evictions).toBe(1);
  });

  it('forgives a client that catches up before the strike limit', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    sink.bufferedBytes = 5_000;
    hub.ingest(snapshot(11));
    hub.ingest(snapshot(12));
    sink.bufferedBytes = 0;
    hub.ingest(snapshot(13));
    sink.bufferedBytes = 5_000;
    hub.ingest(snapshot(14));
    hub.ingest(snapshot(15));

    expect(sink.closed).toBeNull();
  });

  it('drops a socket whose send throws instead of retrying it every tick', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    sink.broken = true;
    hub.ingest(snapshot(11));

    expect(hub.connections).toBe(0);
    expect(sink.closed).not.toBeNull();
  });

  it('refuses new connections at capacity rather than accepting them and dying', async () => {
    const small = hubFor(source, { maxConnections: 1 });
    const first = new FakeSink();
    const second = new FakeSink();

    expect(small.attach(MARKET, first)).not.toBeNull();
    expect(small.attach(MARKET, second)).toBeNull();
    await settle();

    expect(second.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(second.frames).toEqual([]);
  });
});

describe('DepthHub — an unknown market never reaches svc-matching', () => {
  /**
   * A market nobody lists is not a market, and a terminal must not be able to
   * confuse "nobody is quoting here" with "you asked for something that does
   * not exist" — an empty ladder drawn for a typo is a market being rendered as
   * if it were real.
   *
   * This was also, historically, a memory-safety gate: `engine.depth()` went
   * through `engine.book()`, which CREATED the book when it was missing, so a
   * depth call for an arbitrary string allocated an entry in the engine's map
   * from any browser that could open a socket here. That hole is closed at the
   * engine now (`existingBook`, plus a 404 on the depth route), so this pins the
   * honesty property rather than the allocation one.
   */
  it('refuses the subscription and makes no depth call', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    const hub = hubFor(source);

    const sink = new FakeSink();
    hub.attach('NOT-A-MARKET', sink);
    await settle();

    expect(sink.closed?.code).toBe(CLOSE_POLICY);
    expect(sink.closed?.reason).toBe('ws.close.unknown_market');
    expect(source.snapshotCalls).toEqual([]);
    expect(hub.connections).toBe(0);
  });

  it('refetches the list once so a newly listed market works without a restart', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    source.current.set(OTHER, snapshot(4, [['20', '1']], [['21', '1']], OTHER));
    const hub = hubFor(source);

    await hub.refreshMarkets();
    expect(hub.knownMarkets).toEqual([MARKET]);

    source.marketList.push(OTHER); // svc-matching listed it a moment ago
    const sink = new FakeSink();
    hub.attach(OTHER, sink);
    await settle();

    expect(sink.closed).toBeNull();
    expect(sink.messages()[0]).toMatchObject({ type: 'snapshot', marketId: OTHER });
  });

  it('tells the client why when svc-matching cannot be reached', async () => {
    // Registry/list failure — the market list itself cannot be loaded. That is
    // different from depth seed failure for a known market (see below).
    const source = new FakeSource([MARKET]);
    source.failMarkets = new Error('svc-matching unreachable: connect ECONNREFUSED');
    const hub = hubFor(source);

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(sink.closed?.reason).toMatch(/ECONNREFUSED/);
  });

  it('concurrent miss-refreshes share one list load — neither gets a false unknown', async () => {
    let release!: () => void;
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    source.current.set(OTHER, snapshot(4, [['20', '1']], [['21', '1']], OTHER));
    const hub = hubFor(source, { marketsRefreshMs: 30_000, clock: () => 1_000 });

    // Warm with MARKET only (no gate).
    await hub.refreshMarkets();
    expect(hub.knownMarkets).toEqual([MARKET]);
    expect(source.marketCalls).toBe(1);

    // Next list load is gated so two concurrent misses pile onto one in-flight refresh.
    source.marketsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.marketList.push(OTHER);

    const a = new FakeSink();
    const b = new FakeSink();
    hub.attach(OTHER, a);
    hub.attach(OTHER, b);
    await settle();
    // Still waiting on the shared list load — must not have false-unknowned either.
    expect(a.closed).toBeNull();
    expect(b.closed).toBeNull();

    release();
    await settle();
    await settle();

    expect(a.closed).toBeNull();
    expect(b.closed).toBeNull();
    expect(a.messages()[0]).toMatchObject({ type: 'snapshot', marketId: OTHER });
    expect(b.messages()[0]).toMatchObject({ type: 'snapshot', marketId: OTHER });
    // Warm + one shared miss-refresh (not two independent refuses).
    expect(source.marketCalls).toBe(2);
  });

  it('refreshes on a miss at most once per window when the refresh window is non-zero', async () => {
    let now = 1_000;
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    source.current.set(OTHER, snapshot(4, [['20', '1']], [['21', '1']], OTHER));
    const hub = hubFor(source, {
      marketsRefreshMs: 30_000,
      clock: () => now,
    });

    // Warm the list via a known market. This sets marketsFetchedAt but must
    // NOT burn the miss-refresh budget — a newly listed market still gets one.
    await hub.refreshMarkets();
    expect(hub.knownMarkets).toEqual([MARKET]);
    expect(source.marketCalls).toBe(1);

    // List grows after the warm refresh.
    source.marketList.push(OTHER);
    const accepted = new FakeSink();
    hub.attach(OTHER, accepted);
    await settle();

    expect(accepted.closed).toBeNull();
    expect(accepted.messages()[0]).toMatchObject({ type: 'snapshot', marketId: OTHER });
    expect(source.marketCalls).toBe(2); // one miss-refresh

    // A second unknown inside the same window must not re-call markets.
    const refused = new FakeSink();
    hub.attach('STILL-NOT-LISTED', refused);
    await settle();

    expect(refused.closed?.code).toBe(CLOSE_POLICY);
    expect(refused.closed?.reason).toBe('ws.close.unknown_market');
    expect(source.marketCalls).toBe(2);

    // After the window, a miss may refresh again.
    now += 30_000;
    source.marketList.push('LATER-LISTED');
    source.current.set('LATER-LISTED', snapshot(1, [['1', '1']], [['2', '1']], 'LATER-LISTED'));
    const later = new FakeSink();
    hub.attach('LATER-LISTED', later);
    await settle();

    expect(later.closed).toBeNull();
    expect(source.marketCalls).toBe(3);
  });
});

describe('DepthHub — book lifecycle', () => {
  it('sends everyone a snapshot when the engine sequence goes backwards', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(50, [['100', '9']]));
    const hub = hubFor(source);

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    // An engine that lost its journal, or a replica behind its peers. A delta
    // across the discontinuity would carry a `fromSequence` nobody is at.
    hub.ingest(snapshot(3, [['100', '1']]));

    const last = sink.messages().at(-1);
    expect(last?.type).toBe('snapshot');
    expect(last?.sequence).toBe(3);
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('forgets a book when the last subscriber leaves, so nobody is handed a stale one', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    const hub = hubFor(source);

    const first = new FakeSink();
    const second = new FakeSink();
    const detachFirst = hub.attach(MARKET, first)!;
    const detachSecond = hub.attach(MARKET, second)!;
    await settle();

    detachFirst();
    expect(hub.bookFor(MARKET)).toBeDefined(); // still watched

    detachSecond();
    expect(hub.bookFor(MARKET)).toBeUndefined();
    expect(hub.activeMarkets).toEqual([]);
  });

  it('does not restore a forgotten book when a poll ingests after the last watcher leaves', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10, [['100', '1']], [['101', '1']]));
    const hub = hubFor(source);

    const first = new FakeSink();
    const detach = hub.attach(MARKET, first)!;
    await settle();
    expect(first.messages()[0]).toMatchObject({ type: 'snapshot', sequence: 10 });
    expect(hub.bookFor(MARKET)?.sequence).toBe(10);

    // Still watched: a poll updates the book and the live subscriber hears it.
    hub.ingest(snapshot(11, [['100', '2']], [['101', '1']]));
    expect(hub.bookFor(MARKET)?.sequence).toBe(11);
    expect(first.messages().at(-1)).toMatchObject({ type: 'delta', sequence: 11 });

    detach();
    expect(hub.bookFor(MARKET)).toBeUndefined();
    expect(hub.activeMarkets).toEqual([]);

    // Sampled before the detach, delivered after #forgetIdleBook.
    hub.ingest(snapshot(12, [['999', '7']], [['1000', '8']]));
    expect(hub.bookFor(MARKET)).toBeUndefined();

    source.current.set(MARKET, snapshot(20, [['50', '2']], [['51', '3']]));
    const next = new FakeSink();
    hub.attach(MARKET, next);
    await settle();

    expect(next.messages()[0]).toMatchObject({
      type: 'snapshot',
      marketId: MARKET,
      sequence: 20,
      bids: [['50', '2']],
      asks: [['51', '3']],
    });
    expect(next.messages().some((message) => message.sequence === 12)).toBe(false);
    expect(canonical(rebuild(next))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('does not restore a forgotten book when a halted poll ingests after the last watcher leaves', async () => {
    const source = new FakeSource([MARKET]);
    source.tradingStatus = DEPTH_MARKET_HALTED;
    source.current.set(MARKET, snapshot(10, [['100', '1']], [['101', '1']]));
    const hub = hubFor(source);

    const first = new FakeSink();
    const detach = hub.attach(MARKET, first)!;
    await settle();
    expect(hub.bookFor(MARKET)?.sequence).toBe(10);

    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_HALTED);
    expect(hub.isMatchingNotTradable(MARKET)).toBe(true);
    // Halted and still watched: the book stays current, and no tradable ladder goes out.
    hub.ingest(snapshot(11, [['100', '4']], [['101', '1']]));
    expect(hub.bookFor(MARKET)?.sequence).toBe(11);
    expect(first.messages().filter((message) => message.sequence === 11)).toEqual([]);

    detach();
    expect(hub.bookFor(MARKET)).toBeUndefined();

    hub.ingest(snapshot(12, [['888', '4']], [['889', '5']]));
    expect(hub.bookFor(MARKET)).toBeUndefined();
    expect(hub.isMatchingNotTradable(MARKET)).toBe(true);

    source.current.set(MARKET, snapshot(21, [['50', '2']], [['51', '4']]));
    const next = new FakeSink();
    hub.attach(MARKET, next);
    await settle();

    expect(hub.bookFor(MARKET)?.sequence).toBe(21);
    expect(next.messages()).toEqual([]);
    expect(next.frames.map((frame) => JSON.parse(frame))).toEqual([{ type: 'status', code: DEPTH_MARKET_HALTED, marketId: MARKET }]);
  });

  it('leaves no book behind when a client gives up mid-connect', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    const hub = hubFor(source);

    // Detached before the upstream round trip came back. The seed still lands a
    // book; nothing must be left watching nothing.
    const detach = hub.attach(MARKET, new FakeSink())!;
    detach();
    await settle();

    expect(hub.connections).toBe(0);
    expect(hub.bookFor(MARKET)).toBeUndefined();
  });

  it('polls only markets someone is watching', async () => {
    const source = new FakeSource([MARKET, OTHER]);
    source.current.set(MARKET, snapshot(10));
    const hub = hubFor(source);

    hub.attach(MARKET, new FakeSink());
    await settle();

    expect(hub.activeMarkets).toEqual([MARKET]);
  });

  it('closes every socket with a reason when the kill-switch is thrown', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    const hub = hubFor(source);

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    hub.closeAll(1012, 'ws.gateway flag is off');

    expect(sink.closed).toEqual({ code: 1012, reason: 'ws.gateway flag is off' });
    expect(hub.connections).toBe(0);
    expect(hub.bookFor(MARKET)).toBeUndefined();
  });

  it('keeps two markets’ streams apart', async () => {
    const source = new FakeSource([MARKET, OTHER]);
    source.current.set(MARKET, snapshot(10));
    source.current.set(OTHER, snapshot(4, [['20', '1']], [['21', '1']], OTHER));
    const hub = hubFor(source);

    const btc = new FakeSink();
    const eth = new FakeSink();
    hub.attach(MARKET, btc);
    hub.attach(OTHER, eth);
    await settle();

    hub.ingest(snapshot(11, [['100', '2']]));

    for (const message of eth.messages()) expect(message.marketId).toBe(OTHER);
    expect(eth.frames.length).toBe(1);
    expect(canonical(rebuild(btc))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });
});

/**
 * WHICH LIST DECIDES.
 *
 * The bug that made live depth unreachable for twenty-six cycles was not in any
 * of the fan-out above. It was that this hub asked svc-matching "what are the
 * markets?", and svc-matching answered with the books it holds — which, after
 * `trade.markets` was reseeded, had an EMPTY intersection with the ids the
 * browser fetches to draw the market picker. Sixteen listed, ten in the engine,
 * nothing in common, every subscription refused with `unknown market`.
 *
 * So the hub now takes a registry that is separate from its depth source, and
 * these are the two facts that must hold: the listing decides, and a listed
 * market with no book still opens (no frames until resting depth — empty ≠ zero).
 */
describe('DepthHub — the listing decides, not the engine', () => {
  const LISTED = 'fbbe6534-e7af-49a8-a782-bbdd1e1894ba';
  const ENGINE_ONLY = '2a70a839-aeb6-4c04-a067-2b000f392bdb';

  it('accepts a listed market the engine has never heard of', async () => {
    // The exact fleet state: the source's own list does not contain it.
    const source = new FakeSource([ENGINE_ONLY]);
    source.current.set(LISTED, snapshot(0, [], [], LISTED));
    const hub = hubFor(source, { registry: { markets: async () => [LISTED, ENGINE_ONLY] } });

    const sink = new FakeSink();
    hub.attach(LISTED, sink);
    await settle();

    expect(sink.closed).toBeNull();
    expect(sink.messages()).toEqual([]);
    expect(sink.frames).toEqual([]);

    hub.ingest(snapshot(4, [['100', '1']], [['101', '1']], LISTED));
    expect(sink.messages()[0]).toMatchObject({ type: 'snapshot', marketId: LISTED, sequence: 4 });
  });

  it('does not emit a priced empty book for a listed market that has never traded', async () => {
    // Matching 404 / never-traded is absence. A snapshot with bids/asks [] is a
    // live zero book a client would draw as "No asks / No bids" with a sequence.
    const source = new FakeSource([]);
    source.current.set(LISTED, { type: 'snapshot', marketId: LISTED, sequence: 0, bids: [], asks: [] });
    const hub = hubFor(source, { registry: { markets: async () => [LISTED] } });

    const sink = new FakeSink();
    hub.attach(LISTED, sink);
    await settle();

    expect(sink.closed).toBeNull();
    expect(sink.messages()).toEqual([]);
    expect(hub.bookFor(LISTED)).toBeUndefined();
    expect(hub.matchingAvailable).toBe(true);
    expect(hub.isEngineUnavailable(LISTED)).toBe(false);
    expect(sink.frames).toEqual([]);
  });

  it('still refuses an id nobody lists', async () => {
    const source = new FakeSource([ENGINE_ONLY]);
    const hub = hubFor(source, { registry: { markets: async () => [LISTED, ENGINE_ONLY] } });

    const sink = new FakeSink();
    hub.attach('NOT-A-MARKET', sink);
    await settle();

    expect(sink.closed?.code).toBe(CLOSE_POLICY);
    expect(sink.closed?.reason).toBe('ws.close.unknown_market');
    expect(source.snapshotCalls).toEqual([]);
  });

  it('never asks the depth source for the market list once a registry is given', async () => {
    // A regression here would silently restore the old behaviour: the engine's
    // book list back in charge of what a client may watch.
    const source = new FakeSource([ENGINE_ONLY]);
    const hub = hubFor(source, { registry: { markets: async () => [LISTED] } });

    await hub.refreshMarkets();

    expect(source.marketCalls).toBe(0);
    expect(hub.knownMarkets).toEqual([LISTED]);
  });

  it('keeps the last known list when the registry fails, rather than delisting everything', async () => {
    let fail = false;
    const source = new FakeSource([]);
    const hub = hubFor(source, {
      registry: {
        markets: async () => {
          if (fail) throw new Error('every market registry source failed');
          return [LISTED];
        },
      },
    });

    await hub.refreshMarkets();
    fail = true;
    await expect(hub.refreshMarkets()).rejects.toThrow(/every market registry source failed/);

    expect(hub.knownMarkets).toEqual([LISTED]);
  });

  it('does not fabricate an empty book when matching cannot serve depth', async () => {
    // Engine down → listed market stays open. Disclose by name; never seq-0 empty.
    const source = new FakeSource([MARKET]);
    source.failSnapshot = new Error('svc-matching unreachable: connect ECONNREFUSED');
    const hub = hubFor(source);

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.closed).toBeNull();
    expect(sink.messages()).toEqual([]);
    expect(hub.bookFor(MARKET)).toBeUndefined();
    expect(hub.matchingAvailable).toBe(false);
    expect(hub.engineCode).toBe('depth.engine_unavailable');
    expect(sink.frames.map((f) => JSON.parse(f))).toEqual([{ type: 'status', code: 'depth.engine_unavailable', marketId: MARKET }]);

    // Matching recovers; the first real book is a snapshot, not a delta off fake 0.
    source.failSnapshot = null;
    source.current.set(MARKET, snapshot(5, [['100', '2']]));
    hub.ingest(snapshot(5, [['100', '2']]));

    expect(hub.matchingAvailable).toBe(true);
    expect(sink.messages()[0]).toMatchObject({ type: 'snapshot', sequence: 5 });
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('tells a subscriber who connects during an outage that matching is down when the book is already cached', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10, [['100', '2']], [['101', '3']]));
    const hub = hubFor(source);

    const already = new FakeSink();
    hub.attach(MARKET, already);
    await settle();
    expect(already.messages()[0]).toMatchObject({ type: 'snapshot', marketId: MARKET, sequence: 10 });

    hub.markEngineUnavailable(MARKET);
    expect(hub.isEngineUnavailable(MARKET)).toBe(true);
    expect(hub.bookFor(MARKET)?.sequence).toBe(10);

    const late = new FakeSink();
    hub.attach(MARKET, late);
    await settle();

    expect(late.closed).toBeNull();
    expect(late.messages()).toEqual([]);
    expect(late.frames.map((f) => JSON.parse(f))).toEqual([{ type: 'status', code: 'depth.engine_unavailable', marketId: MARKET }]);
    expect(hub.bookFor(MARKET)?.sequence).toBe(10);
  });

  it('does not send the cached ladder when a halted market comes back before ingest and the engine is still down', async () => {
    // Halted, book already cached, failed tick marks the engine down. A subscriber
    // connects, then the next tick calls noteMatchingTrading(null) before ingest.
    // That subscriber must not receive the cached snapshot while the engine is still down.
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10, [['100', '2']], [['101', '3']]));
    const hub = hubFor(source);

    const already = new FakeSink();
    hub.attach(MARKET, already);
    await settle();
    expect(already.messages()[0]).toMatchObject({ type: 'snapshot', marketId: MARKET, sequence: 10 });

    hub.noteMatchingTrading(MARKET, DEPTH_MARKET_HALTED);
    hub.markEngineUnavailable(MARKET);
    expect(hub.isEngineUnavailable(MARKET)).toBe(true);
    expect(hub.isMatchingNotTradable(MARKET)).toBe(true);
    expect(hub.bookFor(MARKET)?.sequence).toBe(10);

    const late = new FakeSink();
    hub.attach(MARKET, late);
    await settle();

    const framesBeforeResume = late.frames.length;
    hub.noteMatchingTrading(MARKET, null, true);

    expect(hub.isEngineUnavailable(MARKET)).toBe(true);
    expect(hub.bookFor(MARKET)?.sequence).toBe(10);
    expect(late.closed).toBeNull();
    expect(late.messages()).toEqual([]);
    expect(late.frames.slice(framesBeforeResume)).toEqual([]);
    expect(late.frames.map((f) => JSON.parse(f))).toEqual([{ type: 'status', code: 'depth.engine_unavailable', marketId: MARKET }]);
    expect(already.messages()).toEqual([expect.objectContaining({ type: 'snapshot', sequence: 10 })]);

    hub.ingest(snapshot(11, [['100', '4']], [['101', '3']]));

    expect(hub.isEngineUnavailable(MARKET)).toBe(false);
    expect(hub.bookFor(MARKET)?.sequence).toBe(11);
    expect(late.messages()).toEqual([expect.objectContaining({ type: 'snapshot', marketId: MARKET, sequence: 11 })]);
  });
});

describe('DepthHub — seed vs poll races and window pins', () => {
  it('does not let a late seed regress a book the poll already advanced', async () => {
    const source = new FakeSource([MARKET]);
    let releaseSeed!: (s: DepthSnapshot) => void;
    source.pendingSnapshots.set(
      MARKET,
      new Promise<DepthSnapshot>((resolve) => {
        releaseSeed = resolve;
      }),
    );

    const hub = hubFor(source);
    // Warm the list so #open reaches #seed on the first turn (not stuck on
    // markets refresh) — the race under test is seed vs poll, not list load.
    await hub.refreshMarkets();

    const sink = new FakeSink();
    hub.attach(MARKET, sink);

    // Wait until seed has actually called the source (promise in flight).
    for (let i = 0; i < 20 && source.snapshotCalls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(source.snapshotCalls).toContain(MARKET);

    // Poll wins while seed is still in flight: write a real book at seq 20.
    hub.ingest(snapshot(20, [['100', '5']]));
    expect(hub.bookFor(MARKET)?.sequence).toBe(20);

    // Seed finally returns an older snapshot — must not overwrite.
    releaseSeed(snapshot(5, [['99', '1']]));
    await settle();

    expect(hub.bookFor(MARKET)?.sequence).toBe(20);
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
    // Client's first frame is the post-poll book, not the stale seed.
    expect(sink.messages()[0]).toMatchObject({ type: 'snapshot', sequence: 20 });
  });

  it('emits the first real quote as a snapshot, not a delta off a fabricated empty@0', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(0, [], []));
    const hub = hubFor(source);

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.messages()).toEqual([]);

    hub.ingest(snapshot(1, [['100', '1']], [['101', '1']]));

    expect(sink.messages()[0]).toMatchObject({ type: 'snapshot', sequence: 1 });
    expect(sink.messages().some((m) => m.type === 'snapshot' && m.bids.length === 0 && m.asks.length === 0)).toBe(false);
    expect(canonical(rebuild(sink))).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('emits a qty "0" removal when a level falls out of the top-N window', async () => {
    // The hub streams whatever top-N the source returns. When a level leaves
    // the window, the client must see an explicit removal — absence in a delta
    // means "unchanged", not "gone".
    const source = new FakeSource([MARKET]);
    const top2: WireLevel[] = [
      ['100', '3'],
      ['99', '2'],
    ];
    source.current.set(
      MARKET,
      snapshot(10, top2, [
        ['101', '1'],
        ['102', '1'],
      ]),
    );
    const hub = hubFor(source, { depthLimit: 2 });

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    // 99 falls out; 98 enters. Client book depth must stay ≤ 2 per side.
    hub.ingest(
      snapshot(
        11,
        [
          ['100', '3'],
          ['98', '4'],
        ],
        [
          ['101', '1'],
          ['103', '5'],
        ],
      ),
    );

    const delta = sink.messages().at(-1);
    expect(delta?.type).toBe('delta');
    if (delta?.type === 'delta') {
      expect(delta.bids).toContainEqual(['99', '0']);
      expect(delta.asks).toContainEqual(['102', '0']);
    }

    const book = rebuild(sink);
    expect(book?.bids.size).toBeLessThanOrEqual(2);
    expect(book?.asks.size).toBeLessThanOrEqual(2);
    expect(canonical(book)).toBe(canonical(hub.bookFor(MARKET) ?? null));
  });

  it('still snapshot-first when the connect pending buffer overflows', async () => {
    const source = new FakeSource([MARKET]);
    source.current.set(MARKET, snapshot(10));
    const hub = hubFor(source, { maxPendingDeltas: 1 });

    const first = new FakeSink();
    hub.attach(MARKET, first);
    await settle();

    // Second client: flood the pending buffer while its snapshot is being built.
    const second = new FakeSink();
    hub.attach(MARKET, second);
    hub.ingest(snapshot(11, [['100', '2']]));
    hub.ingest(snapshot(12, [['100', '3']]));
    hub.ingest(snapshot(13, [['100', '4']]));
    await settle();

    expect(second.messages()[0]?.type).toBe('snapshot');
    expect(canonical(rebuild(second))).toBe(canonical(hub.bookFor(MARKET) ?? null));
    expect(second.closed).toBeNull();
  });
});
