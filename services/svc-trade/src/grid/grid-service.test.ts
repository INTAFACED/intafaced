/**
 * Spot grid bot service (CB-bots-02, CB-bots-10; J-copy-bots-otc-14 #2 to #5) against a memory store and a stub
 * order path. Every number here is TEST.
 */
import { describe, expect, it } from 'vitest';
import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
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
  bid = '64990';
  ask = '65010';

  place(input: PlaceOrderInput): OrderRecord {
    if (this.failAt !== null && this.placed.length === this.failAt) {
      throw Object.assign(new Error('insufficient'), { code: 'trade.algo_insufficient_balance' });
    }
    this.placed.push(input);
    const id = `o:${input.clientOrderId}`;
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

function setup(opts: { policy?: GridPolicy; verification?: BotVerificationPolicy; free?: string; copyUnused?: string } = {}) {
  const store = new MemoryGridStore();
  const trade = new StubTrade();
  const service = new GridService({
    store,
    policy: opts.policy ?? loadGridPolicy({ TRADE_GRID_COUNT_MIN: '2', TRADE_GRID_COUNT_MAX: '100' }),
    verification: () => opts.verification ?? { mode: 'required', level: 'full' },
    marketBySymbol: async (s) => (s === MARKET.symbol ? MARKET : null),
    depth: async () => ({ bids: [[trade.bid, '1']], asks: [[trade.ask, '1']] }),
    freeBalance: async () => A(opts.free ?? '1000'),
    copyUnusedReserves: async () => A(opts.copyUnused ?? '0'),
    admitStart: async (_p, id) => {
      trade.admitted.push(id);
    },
    placeLevel: async (_p, input) => trade.place(input),
    findOrder: async (id) => trade.orders.get(id) ?? null,
    cancelOrder: async (_p, id) => {
      trade.cancelled.push(id);
      const o = trade.orders.get(id)!;
      trade.orders.set(id, { ...o, status: 'cancelled' });
    },
    fillsForOrder: async (_p, id) => trade.fills.get(id) ?? [],
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
    [{ lowerPrice: '' }, 'trade.grid_lower_price_required', /Lower price/],
    [{ lowerPrice: undefined }, 'trade.grid_lower_price_required', /Lower price/],
    [{ upperPrice: ' ' }, 'trade.grid_upper_price_required', /Upper price/],
    [{ investment: '' }, 'trade.grid_investment_required', /Investment/],
    [{ gridCount: null }, 'trade.grid_count_required', /Grids/],
    [{ gridCount: 1 }, 'trade.grid_count_out_of_range', /Grids must be from 2 to 100/],
    [{ gridCount: 101 }, 'trade.grid_count_out_of_range', /Grids/],
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
    const { service } = setup({ free: '350', copyUnused: '100' });
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
    expect(trade.cancelled).toEqual(trade.placed.map((p) => `o:${p.clientOrderId}`));
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
    const sellId = `o:grid:${view.botId}:8:s0`;
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
    expect(trade.orders.has(`o:grid:${view.botId}:8:b1`)).toBe(true);
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
