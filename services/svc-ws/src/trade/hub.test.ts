import { beforeEach, describe, expect, it } from 'vitest';
import { TRADE_PRINT_KIND_UNKNOWN, TRADE_PRINT_PUBLIC_KEYS, type FillLike, type TradePrint } from '@intafaced/market-data';
import { CLOSE_POLICY, CLOSE_TRY_LATER } from '../depth/hub.js';
import { TradeHub, type TradeSink } from './hub.js';

const MARKET = 'BTC-USDT';
const OTHER = 'ETH-USDT';

/** Private ids that must never appear on a public tape frame (order or account). */
const MAKER_ORDER_ID = '11111111-1111-1111-1111-111111111111';
const TAKER_ORDER_ID = '22222222-2222-2222-2222-222222222222';
const MAKER_ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TAKER_ACCOUNT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function seededPrint(sequence: number): TradePrint {
  return {
    type: 'trade',
    marketId: MARKET,
    sequence,
    price: '100',
    quantity: '1',
    ts: '2026-07-29T12:00:04.000Z',
    kind: TRADE_PRINT_KIND_UNKNOWN,
  };
}

/**
 * Fill-shaped payload as a bus/handler might hand us — including private and
 * unknown fields the strip must drop. Cast: FillLike is the accepted shape;
 * extras prove we do not pass-through by accident.
 */
function fill(sequence: number, marketId = MARKET, price = '100', qty = '1'): FillLike {
  return {
    marketId,
    makerOrderId: MAKER_ORDER_ID,
    takerOrderId: TAKER_ORDER_ID,
    price,
    qty,
    sequence,
    ts: `2026-07-29T12:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    // Residual L10: private / unknown fields that must never reach the wire.
    makerAccountId: MAKER_ACCOUNT_ID,
    takerAccountId: TAKER_ACCOUNT_ID,
    house: true,
    houseFlag: 'internal',
    side: 'buy',
  } as FillLike & Record<string, unknown> as FillLike;
}

/** Assert a JSON wire frame is only the public TradePrint key set and holds none of the secrets. */
function expectPublicTapeFrame(wire: string): TradePrint {
  const print = JSON.parse(wire) as TradePrint;
  expect(Object.keys(print).sort()).toEqual([...TRADE_PRINT_PUBLIC_KEYS].sort());
  expect(print).not.toHaveProperty('side');
  expect(print).not.toHaveProperty('makerOrderId');
  expect(print).not.toHaveProperty('takerOrderId');
  expect(print).not.toHaveProperty('makerAccountId');
  expect(print).not.toHaveProperty('takerAccountId');
  expect(print).not.toHaveProperty('house');
  expect(print).not.toHaveProperty('houseFlag');
  for (const secret of [
    MAKER_ORDER_ID,
    TAKER_ORDER_ID,
    MAKER_ACCOUNT_ID,
    TAKER_ACCOUNT_ID,
    'makerOrderId',
    'takerOrderId',
    'makerAccountId',
    'takerAccountId',
    'houseFlag',
  ]) {
    expect(wire).not.toContain(secret);
  }
  // Aggressor side is not on orderFilled today — never invent it on the public print.
  expect(wire).not.toMatch(/"side"/);
  return print;
}

class FakeSink implements TradeSink {
  readonly frames: string[] = [];
  closed: { code: number; reason: string } | null = null;
  bufferedBytes = 0;
  broken = false;

  send(frame: string): void {
    if (this.broken) throw new Error('EPIPE');
    this.frames.push(frame);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  prints(): TradePrint[] {
    return this.frames.map((f) => JSON.parse(f) as TradePrint);
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function hubFor(known: readonly string[] = [MARKET, OTHER], overrides: Partial<ConstructorParameters<typeof TradeHub>[0]> = {}): TradeHub {
  return new TradeHub({
    highWaterBytes: 1_000,
    maxLagTicks: 3,
    maxConnections: 100,
    recentLimit: 5,
    ensureKnownMarket: async (id) => known.includes(id),
    ...overrides,
  });
}

describe('TradeHub fan-out', () => {
  let hub: TradeHub;

  beforeEach(() => {
    hub = hubFor();
  });

  it('replays recent prints on connect, then streams live ones', async () => {
    // Holder builds the ring; mid-stream joiner gets replay, then live.
    const holder = new FakeSink();
    hub.attach(MARKET, holder);
    await settle();

    hub.ingest(fill(1, MARKET, '100', '1'));
    hub.ingest(fill(2, MARKET, '101', '2'));
    expect(holder.prints()).toHaveLength(2);

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.prints()).toEqual([
      expect.objectContaining({ type: 'trade', sequence: 1, price: '100', quantity: '1' }),
      expect.objectContaining({ type: 'trade', sequence: 2, price: '101', quantity: '2' }),
    ]);

    hub.ingest(fill(3, MARKET, '102', '3'));
    expect(sink.prints()).toHaveLength(3);
    expect(sink.prints()[2]).toMatchObject({ sequence: 3, price: '102', quantity: '3' });
  });

  it('does not grow the recent ring while a market has no watchers', () => {
    expect(hub.ingest(fill(1, MARKET, '100', '1'))).toBeNull();
    expect(hub.ingest(fill(2, MARKET, '101', '2'))).toBeNull();
    expect(hub.recentFor(MARKET)).toHaveLength(0);
    expect(hub.stats.markets).toBe(0);
  });

  it('forgets the recent ring when the last subscriber leaves a market', async () => {
    const first = new FakeSink();
    const detachFirst = hub.attach(MARKET, first)!;
    await settle();

    hub.ingest(fill(1, MARKET, '100', '1'));
    hub.ingest(fill(2, MARKET, '101', '2'));
    expect(hub.recentFor(MARKET)).toHaveLength(2);
    expect(hub.stats.markets).toBe(1);
    expect(first.prints()).toHaveLength(2);

    const peer = new FakeSink();
    const detachPeer = hub.attach(MARKET, peer)!;
    await settle();
    expect(peer.prints()).toHaveLength(2);

    detachFirst();
    // Peer still watching — ring stays for mid-stream joiners.
    expect(hub.recentFor(MARKET)).toHaveLength(2);
    expect(hub.stats.markets).toBe(1);

    detachPeer();
    // Last watcher left — ring and market count drop (reconnect gets empty replay).
    expect(hub.recentFor(MARKET)).toHaveLength(0);
    expect(hub.stats.markets).toBe(0);

    // Unwatched prints after leave do not re-pin a ring for nobody.
    expect(hub.ingest(fill(99, MARKET, '199', '9'))).toBeNull();
    expect(hub.recentFor(MARKET)).toHaveLength(0);

    const rejoin = new FakeSink();
    hub.attach(MARKET, rejoin);
    await settle();
    expect(rejoin.prints()).toHaveLength(0);

    // Fresh print after rejoin still streams; sequence can re-arrive after idle forget.
    hub.ingest(fill(1, MARKET, '110', '1'));
    expect(rejoin.prints()).toHaveLength(1);
    expect(rejoin.prints()[0]).toMatchObject({ sequence: 1, price: '110' });
  });

  it('does not forget one market when another still has a subscriber', async () => {
    const a = new FakeSink();
    const b = new FakeSink();
    const detachA = hub.attach(MARKET, a)!;
    hub.attach(OTHER, b);
    await settle();

    hub.ingest(fill(1, MARKET, '100', '1'));
    hub.ingest(fill(1, OTHER, '200', '1'));

    detachA();
    expect(hub.recentFor(MARKET)).toHaveLength(0);
    expect(hub.recentFor(OTHER)).toHaveLength(1);
  });

  it('public tape frames never carry order ids, account ids, house flags, or invented side', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    const print = hub.ingest(fill(1));
    expect(print).not.toBeNull();
    // Hub return value is the same strip the wire gets.
    expect(Object.keys(print!).sort()).toEqual([...TRADE_PRINT_PUBLIC_KEYS].sort());
    expect(print).not.toHaveProperty('side');

    expect(sink.frames).toHaveLength(1);
    const onWire = expectPublicTapeFrame(sink.frames[0]!);
    expect(onWire).toEqual({
      type: 'trade',
      marketId: MARKET,
      sequence: 1,
      price: '100',
      quantity: '1',
      ts: '2026-07-29T12:00:01.000Z',
      kind: TRADE_PRINT_KIND_UNKNOWN,
    });
  });

  it('live fan-out also strips private fields (not only the recent replay path)', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    hub.ingest(fill(42, MARKET, '99.5', '0.25'));
    expect(sink.frames).toHaveLength(1);
    expectPublicTapeFrame(sink.frames[0]!);
  });

  it('fans one print out to every subscriber on that market only', async () => {
    const a = new FakeSink();
    const b = new FakeSink();
    const other = new FakeSink();
    hub.attach(MARKET, a);
    hub.attach(MARKET, b);
    hub.attach(OTHER, other);
    await settle();

    hub.ingest(fill(10, MARKET, '200', '0.5'));

    expect(a.prints()).toHaveLength(1);
    expect(b.prints()).toHaveLength(1);
    expect(other.prints()).toHaveLength(0);
    expect(a.prints()[0]?.marketId).toBe(MARKET);
  });

  it('dedupes redelivered fills by sequence', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(hub.ingest(fill(1))).not.toBeNull();
    expect(hub.ingest(fill(1))).toBeNull();
    expect(sink.prints()).toHaveLength(1);
  });

  it('bounds the recent ring; stored history is public keys only (no order/account ids)', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    for (let i = 1; i <= 8; i += 1) hub.ingest(fill(i));

    const recent = hub.recentFor(MARKET);
    expect(recent).toHaveLength(5);
    expect(recent[0]?.sequence).toBe(4);
    expect(recent[4]?.sequence).toBe(8);
    for (const print of recent) {
      expect(Object.keys(print).sort()).toEqual([...TRADE_PRINT_PUBLIC_KEYS].sort());
      expect(print).not.toHaveProperty('side');
      expect(JSON.stringify(print)).not.toContain(MAKER_ORDER_ID);
      expect(JSON.stringify(print)).not.toContain(MAKER_ACCOUNT_ID);
    }
  });

  it('closes unknown markets with a stable reason — no raw upstream text', async () => {
    const sink = new FakeSink();
    hub.attach('NOPE', sink);
    await settle();

    // Pin: CLOSE_POLICY + fixed phrase. Market id is client-supplied; reason
    // must not embed stack traces or ensureKnownMarket error bodies.
    expect(sink.closed).toEqual({ code: CLOSE_POLICY, reason: 'ws.close.unknown_market' });
    expect(hub.connections).toBe(0);
  });

  it('closes when the market lookup throws, without the exception text on the close frame', async () => {
    const leaked = 'postgres password in the lookup';
    hub = hubFor([], {
      ensureKnownMarket: async () => {
        throw new Error(leaked);
      },
    });
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(sink.closed?.reason).toBe('ws.close.trades_unavailable');
    expect(sink.closed?.reason).not.toContain(leaked);
    expect(hub.connections).toBe(0);
  });

  it('drops prints for a slow consumer and eventually disconnects', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    sink.bufferedBytes = 10_000;
    hub.ingest(fill(1));
    hub.ingest(fill(2));
    hub.ingest(fill(3));

    expect(sink.prints()).toHaveLength(0);
    expect(sink.closed?.code).toBe(CLOSE_TRY_LATER);
    expect(hub.stats.droppedFrames).toBe(3);
    expect(hub.stats.evictions).toBe(1);
  });

  it('does not double-send prints that arrived during the connect flush', async () => {
    // A fill lands while ensureKnownMarket is in flight: it must appear once
    // via the recent replay, not again as a live fan-out.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hub = hubFor([MARKET], {
      ensureKnownMarket: async () => {
        await gate;
        return true;
      },
    });

    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    // Pending sub is a watcher — print lands in the ring for flush, not live twice.
    hub.ingest(fill(2));
    release();
    await settle();
    await settle();

    expect(sink.prints().map((p) => p.sequence)).toEqual([2]);
  });

  it('amounts on the wire are decimal strings, never JSON numbers', async () => {
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    hub.ingest(fill(1, MARKET, '30000.5', '1.25'));

    const raw = sink.frames[0]!;
    // JSON numbers for price/qty would appear without quotes.
    expect(raw).toMatch(/"price":"30000\.5"/);
    expect(raw).toMatch(/"quantity":"1\.25"/);
    expect(raw).not.toMatch(/"price":30000/);
  });

  it('retries a tape seed that threw before returning a promise', async () => {
    let calls = 0;
    hub = hubFor([MARKET], {
      seedRecent: () => {
        calls += 1;
        throw new Error('seed failed before a promise');
      },
    });

    const first = new FakeSink();
    hub.attach(MARKET, first);
    await settle();

    expect(calls).toBe(1);
    expect(first.closed).toBeNull();
    expect(first.frames).toEqual([]);
    expect(hub.recentFor(MARKET)).toEqual([]);

    const second = new FakeSink();
    hub.attach(MARKET, second);
    await settle();

    expect(calls).toBe(2);
    expect(second.closed).toBeNull();
    expect(second.frames).toEqual([]);
    expect(hub.recentFor(MARKET)).toEqual([]);
  });

  it('replays prints from a successful seed', async () => {
    const seeded = seededPrint(4);
    hub = hubFor([MARKET], {
      seedRecent: async () => [seeded],
    });
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.prints()).toEqual([
      expect.objectContaining({ type: 'trade', marketId: MARKET, sequence: 4, price: '100', quantity: '1' }),
    ]);
    expect(hub.recentFor(MARKET)).toEqual([
      expect.objectContaining({ sequence: 4, price: '100', quantity: '1' }),
    ]);
  });

  it('does not store a ring when the seed is empty', async () => {
    hub = hubFor([MARKET], {
      seedRecent: async () => [],
    });
    const sink = new FakeSink();
    hub.attach(MARKET, sink);
    await settle();

    expect(sink.closed).toBeNull();
    expect(sink.frames).toEqual([]);
    expect(hub.recentFor(MARKET)).toEqual([]);
    expect(hub.stats.markets).toBe(0);
  });

  it('shares one in-flight seed across overlapping subscribers', async () => {
    let calls = 0;
    let release!: (prints: readonly TradePrint[]) => void;
    const seeded = seededPrint(4);
    hub = hubFor([MARKET], {
      seedRecent: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });

    const first = new FakeSink();
    const second = new FakeSink();
    hub.attach(MARKET, first);
    hub.attach(MARKET, second);
    await settle();
    expect(calls).toBe(1);

    release([seeded]);
    await settle();

    expect(first.prints()).toEqual([
      expect.objectContaining({ type: 'trade', sequence: 4, price: '100', quantity: '1' }),
    ]);
    expect(second.prints()).toEqual([
      expect.objectContaining({ type: 'trade', sequence: 4, price: '100', quantity: '1' }),
    ]);
  });

  it('closeAll tells every client why', async () => {
    const a = new FakeSink();
    const b = new FakeSink();
    hub.attach(MARKET, a);
    hub.attach(OTHER, b);
    await settle();

    hub.closeAll(1001, 'gateway shutting down');

    expect(a.closed).toEqual({ code: 1001, reason: 'gateway shutting down' });
    expect(b.closed).toEqual({ code: 1001, reason: 'gateway shutting down' });
    expect(hub.connections).toBe(0);
  });
});

// Capacity honesty: WS_MAX_CONNECTIONS is per-hub, not process-wide.
// (Pin lives next to TradeHub so depth/private can keep their own seats.)
describe('per-hub capacity (not process-wide)', () => {
  it('a full trade hub does not prevent a separate depth hub from accepting', async () => {
    const { DepthHub, CLOSE_TRY_LATER } = await import('../depth/hub.js');
    type WireLevel = readonly [string, string];
    class Stub {
      async markets(): Promise<readonly string[]> {
        return ['BTC-USDT'];
      }
      async snapshot(marketId: string, _limit: number) {
        const bids: readonly WireLevel[] = [];
        const asks: readonly WireLevel[] = [];
        return { type: 'snapshot' as const, marketId, sequence: 1, bids, asks };
      }
    }
    const depth = new DepthHub(new Stub(), {
      depthLimit: 50,
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 1,
      marketsRefreshMs: 0,
    });
    const trade = new TradeHub({
      highWaterBytes: 1_000_000,
      maxLagTicks: 5,
      maxConnections: 1,
      recentLimit: 10,
      ensureKnownMarket: async () => true,
    });
    const closed: Array<{ code: number; reason: string }> = [];
    const sink = () => ({
      bufferedBytes: 0,
      send: () => undefined,
      close: (code: number, reason: string) => {
        closed.push({ code, reason });
      },
    });
    // Each hub independently holds one seat.
    depth.attach('BTC-USDT', sink());
    trade.attach('BTC-USDT', sink());
    expect(depth.connections).toBe(1);
    expect(trade.connections).toBe(1);

    // Second attach on either hub is capacity-refused (1013) without stealing the other hub's seat.
    closed.length = 0;
    trade.attach('BTC-USDT', sink());
    depth.attach('BTC-USDT', sink());
    expect(closed).toEqual([
      { code: CLOSE_TRY_LATER, reason: 'ws.close.at_capacity' },
      { code: CLOSE_TRY_LATER, reason: 'ws.close.at_capacity' },
    ]);
    expect(depth.connections).toBe(1);
    expect(trade.connections).toBe(1);
  });
});
