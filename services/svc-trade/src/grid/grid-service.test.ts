/**
 * Spot grid bot service (CB-bots-02, CB-bots-10; J-copy-bots-otc-14 #2 to #5) against a memory store and a stub
 * order path. Every number here is TEST.
 */
import { describe, expect, it, vi } from 'vitest';
import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { orderIdFor } from '../spot/ids.js';
import { principalFor } from '../spot/testing.js';
import type { PlaceOrderInput } from '../spot/trade-service.js';
import type { FillRecord, Market, OrderRecord } from '../spot/types.js';
import type { BotVerificationPolicy } from '../algo/bots-verification.js';
import { GridError } from './errors.js';
import { GridService, gridBotIdFor, type GridCreateInput } from './grid-service.js';
import { loadGridPolicy, type GridPolicy } from './policy.js';
import { MemoryGridStore } from './store.js';

const A = (v: string): Amount => parseAmount(v);
const ALICE = '11111111-1111-4111-8111-111111111111';
/** The trade service's own id for a level order: what a lost row is found by. */
const oid = (clientOrderId: string | undefined): string => {
  // Every grid level order carries its business key; one without it is a bug the test must see.
  if (!clientOrderId) throw new Error('grid order placed without a clientOrderId');
  return orderIdFor(ALICE, 'BTC-USDT', clientOrderId);
};

const MARKET = {
  id: 'BTC-USDT',
  symbol: 'BTC/USDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  kind: 'spot',
  tickSize: A('0.01'),
  lotSize: A('0.00001'),
  minQty: A('0.00001'),
  maxQty: null,
  minNotional: A('1'),
  status: 'active',
  paper: false,
} as unknown as Market;

function verified(tier: Principal['tier'] = 'full'): Principal {
  return { ...principalFor(ALICE), tier };
}

class StubTrade {
  readonly orders = new Map<string, OrderRecord>();
  readonly fills = new Map<string, FillRecord[]>();
  readonly placed: PlaceOrderInput[] = [];
  readonly cancelled: string[] = [];
  admitted: string[] = [];
  failAt: number | null = null;
  /** The place at this index reaches the engine, then the call fails, so no row is saved. */
  lostAt: number | null = null;
  /** Cancels that fail before the order is cancelled. */
  cancelFailures = 0;
  /** Runs before each place reaches the engine: a concurrent tick or stop lands here. */
  beforePlace: ((index: number) => Promise<void>) | null = null;
  bid = '64990';
  ask = '65010';

  place(input: PlaceOrderInput): OrderRecord {
    if (this.failAt !== null && this.placed.length === this.failAt) {
      throw Object.assign(new Error('insufficient'), { code: 'trade.algo_insufficient_balance' });
    }
    this.placed.push(input);
    const id = oid(input.clientOrderId);
    const existing = this.orders.get(id);
    if (existing) return existing;
    const price = input.price!;
    const record = {
      id,
      userId: ALICE,
      marketId: input.marketId,
      clientOrderId: input.clientOrderId,
      side: input.side,
      price,
      qty: input.qty,
      filledQty: 0n,
      status: 'open',
      holdAsset: input.side === 'buy' ? 'USDT' : 'BTC',
      holdAmount: input.side === 'buy' ? mul(price, input.qty, 'ceil') : input.qty,
    } as unknown as OrderRecord;
    this.orders.set(id, record);
    if (this.lostAt !== null && this.placed.length - 1 === this.lostAt) {
      throw Object.assign(new Error('timeout'), { code: 'trade.place_timeout' });
    }
    return record;
  }

  fill(orderId: string, feeAsset: string, feeAmount: Amount): void {
    const o = this.orders.get(orderId)!;
    this.orders.set(orderId, { ...o, status: 'filled', filledQty: o.qty });
    this.fills.set(orderId, [
      { orderId, price: o.price!, qty: o.qty, quoteAmount: mul(o.price!, o.qty, 'floor'), feeAsset, feeAmount } as unknown as FillRecord,
    ]);
  }
}

function setup(
  opts: { policy?: GridPolicy; verification?: BotVerificationPolicy; free?: () => string; copyUnused?: string; now?: () => Date } = {},
) {
  const store = new MemoryGridStore();
  const trade = new StubTrade();
  const service = new GridService({
    store,
    policy: opts.policy ?? loadGridPolicy({ TRADE_GRID_COUNT_MIN: '2', TRADE_GRID_COUNT_MAX: '100' }),
    verification: () => opts.verification ?? { mode: 'required', level: 'full' },
    marketBySymbol: async (s) => (s === MARKET.symbol ? MARKET : null),
    depth: async () => ({ bids: [[trade.bid, '1']], asks: [[trade.ask, '1']] }),
    freeBalance: async () => A(opts.free?.() ?? '1000'),
    copyUnusedReserves: async () => A(opts.copyUnused ?? '0'),
    admitStart: async (_p, id) => {
      trade.admitted.push(id);
    },
    placeLevel: async (_p, input) => {
      await trade.beforePlace?.(trade.placed.length);
      return trade.place(input);
    },
    findOrder: async (id) => trade.orders.get(id) ?? null,
    cancelOrder: async (_p, id) => {
      if (trade.cancelFailures > 0) {
        trade.cancelFailures -= 1;
        throw new Error('trade service unavailable');
      }
      trade.cancelled.push(id);
      const o = trade.orders.get(id)!;
      trade.orders.set(id, { ...o, status: 'cancelled' });
    },
    fillsForOrder: async (_p, id) => trade.fills.get(id) ?? [],
    now: opts.now,
  });
  return { store, trade, service };
}

const BODY: GridCreateInput = {
  clientRequestId: 'grid-test-0001',
  symbol: 'BTC/USDT',
  lowerPrice: '60000',
  upperPrice: '70000',
  gridCount: 20,
  investment: '200',
};

async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (error) {
    return { code: (error as GridError).code, message: (error as Error).message };
  }
  throw new Error('expected a refusal');
}

describe('grid create · verification first (CB-bots-10, #2)', () => {
  it('refuses below the owner level and writes nothing', async () => {
    const { store, trade, service } = setup();
    expect((await refusal(service.create(verified('basic'), BODY))).code).toBe('trade.bots_verification_insufficient');
    expect(await store.listBots(ALICE)).toEqual([]);
    expect(trade.admitted).toEqual([]);
    expect(trade.placed).toEqual([]);
  });

  it('a blank owner level refuses every bot, even institutional', async () => {
    const { store, service } = setup({ verification: { mode: 'required', level: null } });
    expect((await refusal(service.create(verified('institutional'), BODY))).code).toBe('trade.bots_verification_level_not_set');
    expect(await store.listBots(ALICE)).toEqual([]);
  });

  it('the wizard setup read refuses the same way, and answers the count range once verified', async () => {
    expect((await refusal(Promise.resolve().then(() => setup().service.setup(verified('basic'))))).code).toBe(
      'trade.bots_verification_insufficient',
    );
    const blank = setup({ verification: { mode: 'required', level: null } }).service;
    expect((await refusal(Promise.resolve().then(() => blank.setup(verified('institutional'))))).code).toBe(
      'trade.bots_verification_level_not_set',
    );
    expect(setup().service.setup(verified('full'))).toEqual({ countRange: { min: 2, max: 100 } });
  });
});

describe('grid presets (CB-bots-10, #3)', () => {
  it('with no backtest source there is no preset and no APR', () => {
    expect(setup().service.presets()).toEqual({ source: null, presets: [] });
  });

  it('a preset source value stops the boot: none is built', () => {
    expect(() => loadGridPolicy({ TRADE_GRID_PRESET_SOURCE: 'anything' })).toThrow(/no grid backtest source is built/);
  });
});

describe('grid create · fields (CB-bots-02, #4)', () => {
  it.each([
    [{ lowerPrice: '' }, 'trade.bots_grid_bounds_not_set', /Lower price/],
    [{ lowerPrice: undefined }, 'trade.bots_grid_bounds_not_set', /Lower price/],
    [{ upperPrice: ' ' }, 'trade.bots_grid_bounds_not_set', /Upper price/],
    [{ investment: '' }, 'trade.grid_investment_required', /Investment/],
    [{ gridCount: null }, 'trade.grid_count_required', /Grids/],
    [{ gridCount: 1 }, 'trade.bots_grid_count_out_of_range', /Grids must be from 2 to 100/],
    [{ gridCount: 101 }, 'trade.bots_grid_count_out_of_range', /Grids/],
    [{ lowerPrice: '70000', upperPrice: '60000' }, 'trade.grid_bounds_inverted', /below/],
  ])('%o refuses with its code, naming the field, and writes nothing', async (patch, code, message) => {
    const { store, trade, service } = setup();
    const r = await refusal(service.create(verified(), { ...BODY, ...patch }));
    expect(r.code).toBe(code);
    expect(r.message).toMatch(message);
    expect(await store.listBots(ALICE)).toEqual([]);
    expect(trade.admitted).toEqual([]);
  });

  it('a blank owner count range refuses', async () => {
    const { service } = setup({ policy: loadGridPolicy({ TRADE_GRID_COUNT_MIN: '2' }) });
    expect((await refusal(service.create(verified(), BODY))).code).toBe('trade.grid_count_range_not_set');
  });

  it('a count minimum below two stops the boot', () => {
    expect(() => loadGridPolicy({ TRADE_GRID_COUNT_MIN: '1', TRADE_GRID_COUNT_MAX: '9' })).toThrow(/at least 2/);
  });
});

describe('grid create · plan, reserve and holds (CB-bots-02, #4)', () => {
  it('plans twenty levels; the reserve is the investment; each level holds its own order amount', async () => {
    const { store, trade, service } = setup();
    const view = await service.create(verified(), BODY);
    expect(view.levels).toHaveLength(20);
    expect(view.levels[0]!.price).toBe('60000');
    expect(view.levels[19]!.price).toBe('70000');
    expect(view.reserve).toEqual({ key: `bots.grid.reserve:${view.botId}`, asset: 'USDT', amount: '200', releasedAt: null });
    expect(trade.admitted).toEqual([`grid:${view.botId}`]);

    // Buys on exactly the levels below the mark (65000), once each.
    const below = view.levels.filter((l) => A(l.price) < A('65000'));
    expect(trade.placed.map((p) => p.clientOrderId)).toEqual(below.map((l) => `grid:${view.botId}:${l.index}:b0`));
    for (const order of view.orders) {
      const level = view.levels[order.levelIndex]!;
      expect(order.side).toBe('buy');
      expect(order.holdAmount).toBe(level.hold);
      expect(A(order.holdAmount)).toBe(mul(A(order.price), A(order.qty), 'ceil'));
      expect(A(order.holdAmount) <= A('10')).toBe(true); // investment / 20
    }
    const held = view.orders.reduce((a, o) => a + A(o.holdAmount), 0n);
    expect(held <= A('200')).toBe(true);
    expect(await store.sumUnusedReserves(ALICE, 'USDT')).toBe(A('200') - held);
  });

  it('a second create with the same key returns the same bot and places nothing more', async () => {
    const { trade, service } = setup();
    const first = await service.create(verified(), BODY);
    const placed = trade.placed.length;
    const second = await service.create(verified(), BODY);
    expect(second.botId).toBe(first.botId);
    expect(second.botId).toBe(gridBotIdFor(ALICE, BODY.clientRequestId));
    expect(trade.placed.length).toBe(placed);
    expect(trade.admitted).toHaveLength(1);
  });

  it('the same key with a different body conflicts', async () => {
    const { service } = setup();
    await service.create(verified(), BODY);
    expect((await refusal(service.create(verified(), { ...BODY, investment: '300' }))).code).toBe('trade.grid_request_conflict');
  });

  it('refuses an investment above free balance less copy and other grid reserves', async () => {
    const { service } = setup({ free: () => '350', copyUnused: '100' });
    await service.create(verified(), BODY);
    const r = await refusal(service.create(verified(), { ...BODY, clientRequestId: 'grid-test-0002' }));
    expect(r.code).toBe('trade.grid_reserve_exceeds_balance');
  });

  it('a level that fails to place cancels the placed ones and releases the reserve', async () => {
    const { store, trade, service } = setup();
    trade.failAt = 3;
    expect((await refusal(service.create(verified(), BODY))).code).toBe('trade.grid_initialization_failed');
    const [bot] = await store.listBots(ALICE);
    expect(bot!.status).toBe('initialization_failed');
    expect(bot!.statusReason).toBe('trade.algo_insufficient_balance');
    expect(trade.cancelled).toEqual(trade.placed.map((p) => oid(p.clientOrderId)));
    expect((await store.getReserve(bot!.botId))!.releasedAt).not.toBeNull();
    expect(await store.sumUnusedReserves(ALICE, 'USDT')).toBe(0n);
  });
});

describe('grid tick · range pause and pairs (CB-bots-02 #5, CB-bots-05 #6)', () => {
  it('the mark above the upper bound places no new buy and pauses on range', async () => {
    const { store, trade, service } = setup();
    const view = await service.create(verified(), BODY);
    const before = trade.placed.length;
    trade.bid = '72790';
    trade.ask = '72810';
    await service.tick((await store.findBot(view.botId))!);
    expect(trade.placed.length).toBe(before);
    expect((await store.findBot(view.botId))!.status).toBe('paused_range');
    // Back in range: running again, and the levels now below the mark get their buys.
    trade.bid = '68990';
    trade.ask = '69010';
    await service.tick((await store.findBot(view.botId))!);
    expect((await store.findBot(view.botId))!.status).toBe('running');
    expect(trade.placed.length).toBeGreaterThan(before);
  });

  it('a filled buy places a sell one level up; a filled sell closes the pair net of fees', async () => {
    const { store, trade, service } = setup();
    const view = await service.create(verified(), BODY);
    const buy = view.orders.find((o) => o.levelIndex === 8)!;
    trade.fill(buy.orderId, 'BTC', A('0.00000001'));
    await service.tick((await store.findBot(view.botId))!);
    const sellId = oid(`grid:${view.botId}:8:s0`);
    const sell = trade.orders.get(sellId)!;
    expect(sell.side).toBe('sell');
    expect(sell.price).toBe(A(view.levels[9]!.price));
    expect(sell.qty).toBe(A(buy.qty) - A('0.00001')); // what the buy delivered net of its base fee, floored to the lot

    trade.fill(sellId, 'USDT', A('0.01'));
    await service.tick((await store.findBot(view.botId))!);
    const after = await service.get(verified(), view.botId);
    const buyCost = mul(A(buy.price), A(buy.qty), 'floor');
    const sellQuote = mul(sell.price!, sell.qty, 'floor');
    const expected = sellQuote - A('0.01') - buyCost;
    expect(after.gridProfit).toBe(formatAmount(expected));
    expect(after.closedPairs).toBe(1);
    // The level is free again: a fresh buy, cycle 1.
    expect(trade.orders.has(oid(`grid:${view.botId}:8:b1`))).toBe(true);
  });

  it('stop cancels every open level order and releases the reserve', async () => {
    const { store, trade, service } = setup();
    const view = await service.create(verified(), BODY);
    const stopped = await service.stop(verified(), view.botId);
    expect(stopped.status).toBe('stopped');
    expect(trade.cancelled.sort()).toEqual(view.orders.map((o) => o.orderId).sort());
    expect(stopped.reserve!.releasedAt).not.toBeNull();
    expect(await store.listLiveBots()).toEqual([]);
  });
});

describe('grid after review: wind-down, lost places, races and replays (CB-bots-02)', () => {
  it('a stop whose cancel fails keeps the reserve held; the next tick pass cancels the rest and releases it', async () => {
    const { store, trade, service } = setup();
    const view = await service.create(verified(), BODY);
    trade.cancelFailures = 1;
    const stopped = await service.stop(verified(), view.botId);
    expect(stopped.status).toBe('stopped');
    expect(stopped.reserve!.releasedAt).toBeNull();
    expect(stopped.orders.filter((o) => o.status === 'open')).toHaveLength(1);
    expect((await store.listWindingDown()).map((b) => b.botId)).toEqual([view.botId]);

    await service.tickAll();
    const after = await service.get(verified(), view.botId);
    expect(after.status).toBe('stopped');
    expect(after.orders.every((o) => o.status === 'cancelled')).toBe(true);
    expect(trade.cancelled.sort()).toEqual(view.orders.map((o) => o.orderId).sort());
    expect(after.reserve!.releasedAt).not.toBeNull();
    expect(await store.listWindingDown()).toEqual([]);
    expect(await store.sumUnusedReserves(ALICE, 'USDT')).toBe(0n);
  });

  it('a place that reached the engine but saved no row is found by its order id and cancelled on a failed start', async () => {
    const { store, trade, service } = setup();
    trade.lostAt = 3;
    const r = await refusal(service.create(verified(), BODY));
    expect(r.code).toBe('trade.grid_initialization_failed');
    const [bot] = await store.listBots(ALICE);
    expect(bot!.statusReason).toBe('trade.place_timeout');
    const lost = oid(trade.placed[3]!.clientOrderId);
    expect(trade.cancelled.sort()).toEqual(trade.placed.map((p) => oid(p.clientOrderId)).sort());
    expect(trade.cancelled).toContain(lost);
    expect([...trade.orders.values()].every((o) => o.status === 'cancelled')).toBe(true);
    const rows = await store.listOrders(bot!.botId);
    expect(rows.find((o) => o.orderId === lost)!.status).toBe('cancelled');
    expect((await store.getReserve(bot!.botId))!.releasedAt).not.toBeNull();
  });

  it('a tick that read the bot before a stop does not bring it back, and what it placed meanwhile is cancelled', async () => {
    const { store, trade, service } = setup();
    const view = await service.create(verified(), BODY);
    const stale = (await store.findBot(view.botId))!;
    await service.stop(verified(), view.botId);
    const placedBeforeTick = trade.placed.length;
    await service.tick(stale);
    const after = await service.get(verified(), view.botId);
    expect(after.status).toBe('stopped');
    expect(after.statusReason).toBe('owner_stop');
    expect(trade.placed.length).toBeGreaterThan(placedBeforeTick); // the stale tick did place
    expect([...trade.orders.values()].every((o) => o.status === 'cancelled')).toBe(true);
    expect(after.orders.every((o) => o.status === 'cancelled')).toBe(true);
    expect(after.reserve!.releasedAt).not.toBeNull();
  });

  it('the reserve check runs again under the lock with the free balance read again', async () => {
    let reads = 0;
    // The quick check sees 1000 free; by the locked check a spend has left 100.
    const { store, trade, service } = setup({ free: () => (reads++ === 0 ? '1000' : '100') });
    expect((await refusal(service.create(verified(), BODY))).code).toBe('trade.grid_reserve_exceeds_balance');
    expect(reads).toBe(2);
    expect(await store.listBots(ALICE)).toEqual([]);
    expect(await store.sumUnusedReserves(ALICE, 'USDT')).toBe(0n);
    expect(trade.placed).toEqual([]);
  });

  it('a sell that ends part filled is recorded as part filled, closes no pair and books no profit', async () => {
    const { store, trade, service } = setup();
    const view = await service.create(verified(), BODY);
    const buy = view.orders.find((o) => o.levelIndex === 8)!;
    trade.fill(buy.orderId, 'BTC', 0n);
    await service.tick((await store.findBot(view.botId))!);
    const sellId = oid(`grid:${view.botId}:8:s0`);
    const sell = trade.orders.get(sellId)!;
    const half = sell.qty / 2n;
    trade.orders.set(sellId, { ...sell, status: 'cancelled', filledQty: half });
    trade.fills.set(sellId, [
      {
        orderId: sellId,
        price: sell.price!,
        qty: half,
        quoteAmount: mul(sell.price!, half, 'floor'),
        feeAsset: 'USDT',
        feeAmount: 0n,
      } as unknown as FillRecord,
    ]);
    await service.tick((await store.findBot(view.botId))!);
    const after = await service.get(verified(), view.botId);
    const row = after.orders.find((o) => o.orderId === sellId)!;
    expect(row.status).toBe('partial');
    expect(row.pairProfit).toBeNull();
    expect(after.closedPairs).toBe(0);
    expect(after.gridProfit).toBe('0');
  });

  it('a replay of a failed start refuses with the failure, and places nothing', async () => {
    const { trade, service } = setup();
    trade.failAt = 3;
    await refusal(service.create(verified(), BODY));
    const placed = trade.placed.length;
    const again = await refusal(service.create(verified(), BODY));
    expect(again.code).toBe('trade.grid_initialization_failed');
    expect(trade.placed.length).toBe(placed);
  });

  it('a replay of a live bot places the levels it is missing', async () => {
    const { store, trade, service } = setup();
    trade.bid = '72790';
    trade.ask = '72810';
    const first = await service.create(verified(), BODY);
    expect(first.status).toBe('paused_range');
    expect(trade.placed).toEqual([]);
    trade.bid = '64990';
    trade.ask = '65010';
    const again = await service.create(verified(), BODY);
    expect(again.botId).toBe(first.botId);
    expect(again.status).toBe('running');
    const below = again.levels.filter((l) => A(l.price) < A('65000'));
    expect(trade.placed.map((p) => p.clientOrderId)).toEqual(below.map((l) => `grid:${again.botId}:${l.index}:b0`));
    expect((await store.listOrders(again.botId)).filter((o) => o.status === 'open')).toHaveLength(below.length);
  });
});

describe('grid start · the first placement and the tick never place the same level (CB-bots-02, #4)', () => {
  it('a tick pass while create places the first levels places nothing, and every level is placed once', async () => {
    const { store, trade, service } = setup();
    const seen: string[] = [];
    trade.beforePlace = async (index) => {
      if (index !== 3) return;
      const [bot] = await store.listBots(ALICE);
      seen.push(bot!.status);
      await service.tickAll();
    };
    const view = await service.create(verified(), BODY);
    expect(seen).toEqual(['initializing']);
    expect(view.status).toBe('running');
    const ids = trade.placed.map((p) => p.clientOrderId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(view.levels.filter((l) => A(l.price) < A('65000')).length);
    expect(view.orders.filter((o) => o.status === 'open')).toHaveLength(ids.length);
  });

  it('a stop that lands while create places wins: the bot stays stopped and every placed order is cancelled', async () => {
    const { store, trade, service } = setup();
    trade.beforePlace = async (index) => {
      if (index !== 3) return;
      const [bot] = await store.listBots(ALICE);
      await service.stop(verified(), bot!.botId);
    };
    const view = await service.create(verified(), BODY);
    expect(view.status).toBe('stopped');
    expect(view.statusReason).toBe('owner_stop');
    expect(trade.placed.length).toBeGreaterThan(3);
    expect(trade.cancelled.sort()).toEqual(trade.placed.map((p) => oid(p.clientOrderId)).sort());
    expect(view.orders.every((o) => o.status === 'cancelled')).toBe(true);
    expect(view.reserve!.releasedAt).not.toBeNull();
  });

  it('a replay while the first create still places drives nothing more', async () => {
    const { trade, service } = setup();
    const replays: Array<{ status: string; placed: number }> = [];
    trade.beforePlace = async (index) => {
      if (index !== 3) return;
      const before = trade.placed.length;
      const again = await service.create(verified(), BODY);
      replays.push({ status: again.status, placed: trade.placed.length - before });
    };
    await service.create(verified(), BODY);
    expect(replays).toEqual([{ status: 'initializing', placed: 0 }]);
    const ids = trade.placed.map((p) => p.clientOrderId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a create that stopped part way is taken over by the tick once stale, and the missing levels are placed', async () => {
    let at = new Date('2026-10-29T12:00:00Z');
    const { store, trade, service } = setup({ now: () => at });
    // The process stops while placing the fourth level: create never returns.
    let stuck!: () => void;
    trade.beforePlace = async (index) => {
      if (index === 3) await new Promise<void>((resolve) => (stuck = resolve));
    };
    void service.create(verified(), BODY);
    await vi.waitFor(() => expect(stuck).toBeTypeOf('function'));
    trade.beforePlace = null;
    const [bot] = await store.listBots(ALICE);
    expect(bot!.status).toBe('initializing');
    expect(trade.placed).toHaveLength(3);

    at = new Date(at.getTime() + 60_000);
    await service.tickAll();
    expect((await store.findBot(bot!.botId))!.status).toBe('initializing');
    expect(trade.placed).toHaveLength(3);

    at = new Date(at.getTime() + 120_000);
    await service.tickAll();
    const after = await service.get(verified(), bot!.botId);
    expect(after.status).toBe('running');
    const below = after.levels.filter((l) => A(l.price) < A('65000'));
    expect(trade.placed.map((p) => p.clientOrderId)).toEqual(below.map((l) => `grid:${bot!.botId}:${l.index}:b0`));
    expect(after.orders.filter((o) => o.status === 'open')).toHaveLength(below.length);
  });
});
