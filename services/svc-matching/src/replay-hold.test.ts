import { describe, expect, it } from 'vitest';
import type { Envelope, EventBus, EventName, Payload, PublishOptions } from '@intafaced/events';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, parseAmount, type Balance } from '@intafaced/ledger-client';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal, type JournalCommand } from './engine/journal.js';
import type { EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './engine/types.js';
import { openAfterReplay } from './open-after-replay.js';
import {
  HoldCheckUnreachable,
  createReplayHoldLookup,
  requiredHoldAmount,
  unwiredReplayHoldLookup,
  type ReplayHoldLookup,
} from './replay-hold.js';
import { STARTUP_PUBLISH_ATTEMPTS } from './startup-publish.js';

const MARKET = 'BTC/USDT';
const REST = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const MAKER = '33333333-3333-4333-8333-333333333333';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MAKER_ACCT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TAKER_ACCT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function order(spec: {
  id?: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  tif?: TimeInForce;
}): EngineOrder {
  return {
    orderId: spec.id ?? REST,
    accountId: spec.account ?? USER,
    type: spec.type ?? 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: spec.price === undefined ? null : parseAmount(spec.price),
    stopPrice: null,
    tif: spec.tif ?? 'GTC',
  };
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1) + tick * 1000);
  };
}

function engineOn(journal: MemoryJournal, bus: EventBus = new MemoryEventBus('svc-matching'), sleep?: (ms: number) => Promise<void>) {
  return new MatchingEngine({
    journal,
    bus,
    clock: fixedClock(),
    snapshotEvery: 0,
    ...(sleep ? { startupSleep: sleep } : { startupSleep: async () => undefined }),
  });
}

async function boot(journal: MemoryJournal, holds: ReplayHoldLookup, bus?: EventBus, sleep?: (ms: number) => Promise<void>) {
  const engine = engineOn(journal, bus, sleep);
  let listens = 0;
  const result = await openAfterReplay({
    engine,
    holds,
    listen: async () => {
      listens += 1;
    },
  });
  return { engine, result, listens };
}

function timeoutError(): Error {
  return Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' });
}

class DedupingTimeoutOnce implements EventBus {
  readonly attempts: string[] = [];
  readonly stored = new Map<string, unknown>();
  private failed = false;
  private readonly inner = new MemoryEventBus('svc-matching');

  async publish<K extends EventName>(name: K, payload: Payload<K>, opts: PublishOptions = {}) {
    const key = opts.idempotencyKey ?? '';
    this.attempts.push(key);
    const existing = this.stored.get(key);
    if (existing) return existing as Envelope<Payload<K>>;
    const env = await this.inner.publish(name, payload, opts);
    this.stored.set(key, env);
    if (name === 'orderFilled' && !this.failed) {
      this.failed = true;
      throw timeoutError();
    }
    return env;
  }

  get published() {
    return this.inner.published;
  }

  subscribe: EventBus['subscribe'] = (name, handler, opts) => this.inner.subscribe(name, handler, opts);
  close: EventBus['close'] = () => this.inner.close();
}

class AlwaysTimeout implements EventBus {
  attempts = 0;
  private readonly inner = new MemoryEventBus('svc-matching');

  async publish<K extends EventName>(name: K, payload: Payload<K>, opts: PublishOptions = {}): Promise<Envelope<Payload<K>>> {
    void name;
    void payload;
    void opts;
    this.attempts += 1;
    throw timeoutError();
  }

  subscribe: EventBus['subscribe'] = (name, handler, opts) => this.inner.subscribe(name, handler, opts);
  close: EventBus['close'] = () => this.inner.close();
}

async function restingBuy(journal: MemoryJournal) {
  const writer = engineOn(journal);
  await writer.submit(MARKET, order({ id: REST, side: 'buy', qty: '1', price: '100' }));
  writer.finishStartupAnnounce();
}

describe('replay hold check', () => {
  it('pulls a resting order whose hold is gone and never matches it', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const { engine, result } = await boot(journal, {
      async read() {
        return null;
      },
    });

    expect(result.exit).toBe(0);
    expect(result.listened).toBe(true);
    expect(result.gate).toMatchObject({
      open: true,
      pulled: [{ orderId: REST, marketId: MARKET, verdict: 'missing', reason: 'hold_unconfirmed' }],
      halted: [],
    });
    expect(engine.restingOrders().some((row) => row.orderId === REST)).toBe(false);
    expect(journal.read().some((row) => row.kind === 'cancel' && row.orderId === REST && row.reason === 'hold_unconfirmed')).toBe(true);

    const crossed = await engine.submit(MARKET, order({ id: TAKER, side: 'sell', qty: '1', price: '100' }));
    expect(crossed.fills).toEqual([]);
    expect(crossed.fills.some((fill) => fill.makerOrderId === REST || fill.takerOrderId === REST)).toBe(false);
    expect(engine.restingOrders().map((row) => row.orderId)).toEqual([TAKER]);
  });

  it('re-announces a hold cancel on the next boot with the same idempotency key', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const firstBus = new MemoryEventBus('svc-matching');
    await boot(
      journal,
      {
        async read() {
          return null;
        },
      },
      firstBus,
    );
    const firstKey = firstBus.published.find((env) => env.idempotencyKey.startsWith('matching.order.cancelled:'))?.idempotencyKey;
    expect(firstKey).toBeTruthy();

    const secondBus = new MemoryEventBus('svc-matching');
    const restarted = engineOn(journal, secondBus);
    await restarted.recover();
    const again = secondBus.published.filter((env) => env.idempotencyKey === firstKey);
    expect(again).toHaveLength(1);
    expect(restarted.restingOrderCount).toBe(0);
  });

  it('pulls a resting order whose hold is smaller than the remaining size', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const { engine, result } = await boot(journal, {
      async read() {
        return '99';
      },
    });
    expect(result.gate).toMatchObject({ open: true, pulled: [{ orderId: REST, verdict: 'short', reason: 'hold_unconfirmed' }] });
    expect(engine.restingOrderCount).toBe(0);
    const crossed = await engine.submit(MARKET, order({ id: TAKER, side: 'sell', qty: '1', price: '100' }));
    expect(crossed.fills).toEqual([]);
  });

  it('pulls a resting order whose hold row is unreadable', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const { engine } = await boot(journal, {
      async read() {
        throw new Error('svc-ledger answered a transaction lookup malformed');
      },
    });
    expect(engine.restingOrders().some((row) => row.orderId === REST)).toBe(false);
    expect(journal.read().some((row) => row.kind === 'cancel' && row.reason === 'hold_unconfirmed')).toBe(true);
  });

  it('opens an unchanged book when every resting hold covers the remaining size', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const mirror = engineOn(journal);
    await mirror.recover();
    mirror.finishStartupAnnounce();

    const { engine, result, listens } = await boot(journal, {
      async read() {
        return '100';
      },
    });
    expect(result.exit).toBe(0);
    expect(result.gate).toMatchObject({ open: true, checked: 1, pulled: [], halted: [] });
    expect(listens).toBe(1);
    expect(engine.admissionOpen).toBe(true);
    expect(engine.serialize()).toBe(mirror.serialize());
    expect(engine.restingOrders().map((row) => row.orderId)).toEqual([REST]);
  });

  it('keeps a resting futures order whose margin pot holds anything: margin is not compared with notional', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const { engine, result } = await boot(journal, {
      async read() {
        return { futuresMargin: '5' }; // far below price x qty: it is margin, not the order's value
      },
    });
    expect(result.gate).toMatchObject({ open: true, checked: 1, pulled: [], halted: [] });
    expect(engine.admissionOpen).toBe(true);
    expect(engine.restingOrders().map((row) => row.orderId)).toEqual([REST]);
  });

  it('pulls a resting futures order whose margin pot is empty or unreadable', async () => {
    for (const futuresMargin of ['0', 'not-a-number']) {
      const journal = new MemoryJournal();
      await restingBuy(journal);
      const { engine, result } = await boot(journal, {
        async read() {
          return { futuresMargin };
        },
      });
      expect(result.gate).toMatchObject({
        open: true,
        pulled: [{ orderId: REST, verdict: futuresMargin === '0' ? 'missing' : 'unreadable', reason: 'hold_unconfirmed' }],
      });
      expect(engine.restingOrderCount).toBe(0);
    }
  });

  it('keeps the market closed when the hold service is unreachable', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const { engine, result, listens } = await boot(journal, {
      async read() {
        throw new HoldCheckUnreachable('matching.hold_check_unreachable', 'connect ECONNREFUSED');
      },
    });

    expect(result.exit).toBe(0);
    expect(listens).toBe(1);
    expect(result.gate).toMatchObject({ open: false, reason: 'matching.hold_check_unreachable' });
    expect(engine.admissionOpen).toBe(false);
    expect(engine.admissionReason).toBe('matching.hold_check_unreachable');
    expect(engine.restingOrders().map((row) => row.orderId)).toEqual([REST]);

    const crossed = await engine.submit(MARKET, order({ id: TAKER, side: 'sell', qty: '1', price: '100' }));
    expect(crossed.rejected?.code).toBe('hold_check_unreachable');
    expect(crossed.fills).toEqual([]);
    expect(engine.restingOrders().map((row) => row.orderId)).toEqual([REST]);
  });

  it('keeps the market closed when LEDGER_URL is unwired and a resting order came back', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const { engine, result } = await boot(journal, unwiredReplayHoldLookup());
    expect(result.gate).toMatchObject({ open: false, reason: 'matching.hold_check_unwired' });
    expect(engine.admissionOpen).toBe(false);
    const crossed = await engine.submit(MARKET, order({ id: TAKER, side: 'sell', qty: '1', price: '100' }));
    expect(crossed.fills).toEqual([]);
    expect(crossed.rejected?.code).toBe('hold_check_unreachable');
  });

  it('halts the market when the bad hold cannot be cancelled', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    journal.append({
      kind: 'in_flight',
      marketId: MARKET,
      at: '2026-01-01T00:00:02.000Z',
      orderId: REST,
      mutation: 'cancel',
      inFlight: true,
      qty: '1',
    } satisfies JournalCommand);

    const { engine, result } = await boot(journal, {
      async read() {
        return null;
      },
    });
    expect(result.gate).toMatchObject({
      open: true,
      pulled: [],
      halted: [{ marketId: MARKET, orderId: REST, verdict: 'missing', reason: 'matching.hold_missing' }],
    });
    expect(engine.holdHaltReason(MARKET)).toBe('matching.hold_missing');
    expect(engine.restingOrders().map((row) => row.orderId)).toEqual([REST]);

    const crossed = await engine.submit(MARKET, order({ id: TAKER, side: 'sell', qty: '1', price: '100' }));
    expect(crossed.rejected?.code).toBe('hold_unconfirmed');
    expect(crossed.fills).toEqual([]);
    expect(engine.restingOrders().map((row) => row.orderId)).toEqual([REST]);
  });

  it('sizes a buy hold as ceil(price × remaining) and a sell hold as remaining', () => {
    expect(
      requiredHoldAmount({
        marketId: MARKET,
        orderId: REST,
        accountId: USER,
        side: 'buy',
        remaining: '2',
        fundingPrice: '100',
        sequence: 1,
      }),
    ).toBe(parseAmount('200'));
    expect(
      requiredHoldAmount({
        marketId: MARKET,
        orderId: REST,
        accountId: USER,
        side: 'sell',
        remaining: '2.5',
        fundingPrice: '100',
        sequence: 1,
      }),
    ).toBe(parseAmount('2.5'));
    expect(
      requiredHoldAmount({
        marketId: MARKET,
        orderId: REST,
        accountId: USER,
        side: 'buy',
        remaining: '1',
        fundingPrice: null,
        sequence: 1,
      }),
    ).toBeNull();
  });
});

describe('startup NATS publish', () => {
  async function filledJournal() {
    const journal = new MemoryJournal();
    const writer = engineOn(journal);
    await writer.submit(MARKET, order({ id: MAKER, account: MAKER_ACCT, side: 'sell', qty: '1', price: '100' }));
    const crossed = await writer.submit(MARKET, order({ id: TAKER, account: TAKER_ACCT, side: 'buy', qty: '1', price: '100' }));
    expect(crossed.fills).toHaveLength(1);
    expect(writer.restingOrderCount).toBe(0);
    writer.finishStartupAnnounce();
    return journal;
  }

  it('retries one timeout with the same message id and starts the engine once', async () => {
    const journal = await filledJournal();
    const bus = new DedupingTimeoutOnce();
    let sleeps = 0;
    const { result, listens } = await boot(
      journal,
      {
        async read() {
          throw new Error('no resting orders');
        },
      },
      bus,
      async () => {
        sleeps += 1;
      },
    );

    expect(result.exit).toBe(0);
    expect(result.listened).toBe(true);
    expect(listens).toBe(1);
    expect(sleeps).toBe(1);
    expect(bus.attempts.length).toBe(2);
    expect(bus.attempts[0]).toBe(bus.attempts[1]);
    expect(bus.attempts[0]).toMatch(/^matching\.order\.filled:/);
    expect(bus.stored.size).toBe(1);
    expect(bus.published).toHaveLength(1);
  });

  it('exits cleanly when the startup publish keeps timing out and does not listen', async () => {
    const journal = await filledJournal();
    const bus = new AlwaysTimeout();
    let sleeps = 0;
    const { result, listens } = await boot(
      journal,
      {
        async read() {
          throw new Error('no resting orders');
        },
      },
      bus,
      async () => {
        sleeps += 1;
      },
    );

    expect(result.exit).toBe(1);
    expect(result.listened).toBe(false);
    expect(listens).toBe(0);
    expect(bus.attempts).toBe(STARTUP_PUBLISH_ATTEMPTS);
    expect(sleeps).toBe(STARTUP_PUBLISH_ATTEMPTS - 1);
    expect(result.message).toContain('TIMEOUT');
    expect(result.message).toContain('not announced');
    expect(result.message).toContain('Exiting before listen');
  });
});

describe('ledger hold lookup', () => {
  it('reads the order hold balance and reports a missing purpose as no hold', async () => {
    const lookup = createReplayHoldLookup({
      async balances(ownerType, ownerId) {
        expect(ownerType).toBe('user');
        expect(ownerId).toBe(USER);
        const row: Balance = {
          account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'hold', purpose: `order:${REST}` },
          accountId: 'acct-1',
          amount: parseAmount('100'),
        };
        return [row];
      },
    });
    const subject = {
      marketId: MARKET,
      orderId: REST,
      accountId: USER,
      side: 'buy' as const,
      remaining: '1',
      fundingPrice: '100',
      sequence: 1,
    };
    expect(await lookup.read(subject)).toBe(formatAmount(parseAmount('100')));
    expect(await lookup.read({ ...subject, orderId: TAKER })).toBeNull();
  });

  it("reads a futures order's margin pot `futures-order:<id>` as its hold, and refuses two holds for one order", async () => {
    const row = (purpose: string, amount: string): Balance => ({
      account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'hold', purpose },
      accountId: `acct-${purpose}`,
      amount: parseAmount(amount),
    });
    const subject = {
      marketId: MARKET,
      orderId: REST,
      accountId: USER,
      side: 'buy' as const,
      remaining: '1',
      fundingPrice: '100',
      sequence: 1,
    };
    const margin = createReplayHoldLookup({ balances: async () => [row(`futures-order:${REST}`, '7.5')] });
    expect(await margin.read(subject)).toEqual({ futuresMargin: formatAmount(parseAmount('7.5')) });
    const both = createReplayHoldLookup({ balances: async () => [row(`futures-order:${REST}`, '7.5'), row(`order:${REST}`, '100')] });
    await expect(both.read(subject)).rejects.toThrow(/multiple ledger holds/);
  });

  it('does not pull the book when the ledger refuses the balances call', async () => {
    const journal = new MemoryJournal();
    await restingBuy(journal);
    const lookup = createReplayHoldLookup({
      async balances() {
        throw new Error('ledger.unauthenticated');
      },
    });
    const { engine, result } = await boot(journal, lookup);
    expect(result.gate).toMatchObject({ open: false, reason: 'matching.hold_check_unreachable', pulled: [] });
    expect(engine.restingOrders().map((row) => row.orderId)).toEqual([REST]);
    expect(journal.read().some((row) => row.kind === 'cancel')).toBe(false);
  });

  it('treats a refused ledger connection as unreachable', async () => {
    const lookup = createReplayHoldLookup({
      async balances() {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    });
    await expect(
      lookup.read({
        marketId: MARKET,
        orderId: REST,
        accountId: USER,
        side: 'sell',
        remaining: '1',
        fundingPrice: '100',
        sequence: 1,
      }),
    ).rejects.toBeInstanceOf(HoldCheckUnreachable);
  });
});
