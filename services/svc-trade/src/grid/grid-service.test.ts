/**
 * Spot grid bot service (CB-bots-02, CB-bots-10; J-copy-bots-otc-14 #2 to #5) against a memory store and a stub
 * order path. Every number here is TEST.
 */
import { describe, expect, it, vi } from 'vitest';
import { div, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createStepUpCheck, type ActionApproval, type ActionApprovalConsumeInput, type StepUpApprovalConsumer } from '@intafaced/contracts';
import { orderIdFor } from '../spot/ids.js';
import { principalFor } from '../spot/testing.js';
import type { PlaceOrderInput } from '../spot/trade-service.js';
import type { FillRecord, Market, OrderRecord } from '../spot/types.js';
import type { BotVerificationPolicy } from '../algo/bots-verification.js';
import { GridError } from './errors.js';
import { GridService, gridApr, gridBotIdFor, type GridCreateInput } from './grid-service.js';
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

/** Identity's consume, as it answers an approval it minted for this person and scope (contracts step-up-check). */
function identity(fail?: unknown, user = ALICE) {
  const consumed: ActionApprovalConsumeInput[] = [];
  const approvals: StepUpApprovalConsumer = {
    async consume(input) {
      if (fail) throw fail;
      consumed.push(input);
      return {
        approvalId: input.approvalId,
        actionType: 'trade.step_up.bots.grid.withdrawProfit',
        targetService: input.targetService,
        targetId: input.targetId,
        expectedVersion: input.expectedVersion,
        payloadHash: input.payloadHash,
        requesterId: user,
        approverId: user,
        policyVersion: 'step-up-v1',
        createdAt: '2026-10-30T00:00:00.000Z',
        expiresAt: '2026-10-30T00:05:00.000Z',
        status: 'CONSUMED',
        operationId: input.operationId,
        kind: 'same_person',
        consumedAt: '2026-10-30T00:01:00.000Z',
      } as ActionApproval;
    },
  };
  return { approvals, consumed };
}

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
  /** A second place of the same client order id is refused, as the trade service may while another pass placed it. */
  conflictOnReplay = false;
  bid = '64990';
  ask = '65010';

  place(input: PlaceOrderInput): OrderRecord {
    if (this.failAt !== null && this.placed.length === this.failAt) {
      throw Object.assign(new Error('insufficient'), { code: 'trade.algo_insufficient_balance' });
    }
    this.placed.push(input);
    const id = oid(input.clientOrderId);
    const existing = this.orders.get(id);
    if (existing && this.conflictOnReplay) throw Object.assign(new Error('conflict'), { code: 'operation.conflict' });
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
  opts: {
    policy?: GridPolicy;
    verification?: BotVerificationPolicy;
    free?: () => string;
    copyUnused?: string;
    now?: () => Date;
    approvals?: StepUpApprovalConsumer | null;
    store?: MemoryGridStore;
  } = {},
) {
  const store = opts.store ?? new MemoryGridStore();
  const trade = new StubTrade();
  // Each call is another process on the same store and trade service.
  const process = () =>
    new GridService({
      store,
      policy:
        opts.policy ??
        loadGridPolicy({ TRADE_GRID_COUNT_MIN: '2', TRADE_GRID_COUNT_MAX: '100', TRADE_GRID_BOUNDS_MAX_DISTANCE_BPS: '1000' }),
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
      stepUp: createStepUpCheck({ service: 'svc-trade', approvals: opts.approvals === undefined ? identity().approvals : opts.approvals }),
      now: opts.now,
    });
  return { store, trade, service: process(), process };
}

const BODY: GridCreateInput = {
  clientRequestId: 'grid-test-0001',
  symbol: 'BTC/USDT',
  lowerPrice: '60000',
  upperPrice: '70000',
  gridCount: 20,
  investment: '200',
};

async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string; data?: Record<string, string> }> {
  try {
    await run;
  } catch (error) {
    return { code: (error as GridError).code, message: (error as Error).message, data: (error as GridError).data };
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
    expect(setup().service.setup(verified('full'))).toEqual({ countRange: { min: 2, max: 100 }, boundsMaxDistanceBps: 1000 });
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

  it('a blank owner bounds distance refuses every create, and writes nothing', async () => {
    const { store, trade, service } = setup({ policy: loadGridPolicy({ TRADE_GRID_COUNT_MIN: '2', TRADE_GRID_COUNT_MAX: '100' }) });
    expect(service.setup(verified('full')).boundsMaxDistanceBps).toBeNull();
    expect((await refusal(service.create(verified(), BODY))).code).toBe('trade.bots_grid_bounds_band_not_set');
    expect(await store.listBots(ALICE)).toEqual([]);
    expect(trade.admitted).toEqual([]);
  });

  it.each([
    // The mark is 65000 and the owner's distance 10%: bounds from 58500 to 71500.
    [{ lowerPrice: '58499.99' }, 'Lower price', '58500', '71500'],
    [{ upperPrice: '71500.01' }, 'Upper price', '58500', '71500'],
  ])('%o beyond the owner distance from the market price refuses naming the field', async (patch, field, min, max) => {
    const { store, trade, service } = setup();
    const r = await refusal(service.create(verified(), { ...BODY, ...patch }));
    expect(r.code).toBe('trade.bots_grid_bounds_out_of_band');
    expect(r.message).toBe(`${field} must be within 10% of the market price`);
    expect(r.data).toEqual({ field, maxDistancePercent: '10', mark: '65000', min, max });
    expect(await store.listBots(ALICE)).toEqual([]);
    expect(trade.admitted).toEqual([]);
  });

  it('bounds exactly at the owner distance are accepted', async () => {
    const { service } = setup();
    const view = await service.create(verified(), { ...BODY, lowerPrice: '58500', upperPrice: '71500' });
    expect(view.status).toBe('running');
  });

  it('an owner bounds distance below one basis point stops the boot', () => {
    expect(() => loadGridPolicy({ TRADE_GRID_BOUNDS_MAX_DISTANCE_BPS: '0' })).toThrow(/at least 1/);
    expect(() => loadGridPolicy({ TRADE_GRID_BOUNDS_MAX_DISTANCE_BPS: '5%' })).toThrow(/whole number/);
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
    // The pair is charged the cost of the base it sold: the buy delivered its qty less the base fee, and the sell
    // (floored to the lot) sold a little less, which stays the owner's.
    const buyQuote = mul(A(buy.price), A(buy.qty), 'floor');
    const delivered = A(buy.qty) - A('0.00000001');
    const soldCost = div(mul(buyQuote, sell.qty, 'ceil'), delivered, 'ceil');
    const sellQuote = mul(sell.price!, sell.qty, 'floor');
    const expected = sellQuote - A('0.01') - soldCost;
    expect(expected > 0n).toBe(true); // a pair one level up, with small fees, is a profit
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
    // A distance of 20%, so a bot can be created with the price above its range.
    const policy = loadGridPolicy({ TRADE_GRID_COUNT_MIN: '2', TRADE_GRID_COUNT_MAX: '100', TRADE_GRID_BOUNDS_MAX_DISTANCE_BPS: '2000' });
    const { store, trade, service } = setup({ policy });
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
    const { store, trade, service: crashed, process } = setup({ now: () => at });
    const service = process();
    // The process stops while placing the fourth level: create never returns.
    let stuck!: () => void;
    trade.beforePlace = async (index) => {
      if (index === 3) await new Promise<void>((resolve) => (stuck = resolve));
    };
    void crashed.create(verified(), BODY);
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

  async function slowCreate(opts: { conflictOnReplay?: boolean } = {}) {
    let at = new Date('2026-10-29T12:00:00Z');
    const ctx = setup({ now: () => at });
    ctx.trade.conflictOnReplay = opts.conflictOnReplay ?? false;
    let release!: () => void;
    ctx.trade.beforePlace = async (index) => {
      if (index === 3) await new Promise<void>((resolve) => (release = resolve));
    };
    const created = ctx.service.create(verified(), BODY);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    ctx.trade.beforePlace = null;
    const [bot] = await ctx.store.listBots(ALICE);
    at = new Date(at.getTime() + 180_000);
    return { ...ctx, botId: bot!.botId, created, release: () => release() };
  }

  async function expectRunningAndHeld(store: MemoryGridStore, trade: StubTrade, service: GridService, botId: string) {
    const view = await service.get(verified(), botId);
    expect(view.status).toBe('running');
    expect(view.reserve!.releasedAt).toBeNull();
    expect(trade.cancelled).toEqual([]);
    const below = view.levels.filter((l) => A(l.price) < A('65000'));
    expect(view.orders.filter((o) => o.status === 'open').map((o) => o.levelIndex)).toEqual(below.map((l) => l.index));
    expect(await store.sumUnusedReserves(ALICE, 'USDT')).toBe(A(view.reserve!.amount) - below.reduce((sum, l) => sum + A(l.hold), 0n));
    expect(await store.listWindingDown()).toEqual([]);
  }

  it('a create in this process that is only slow is never taken over: the stale pass skips it and it finishes the start', async () => {
    const { store, trade, service, botId, created, release } = await slowCreate();
    await service.tickAll();
    expect((await store.findBot(botId))!.status).toBe('initializing');
    expect(trade.placed).toHaveLength(3);
    release();
    expect((await created).status).toBe('running');
    const ids = trade.placed.map((p) => p.clientOrderId);
    expect(new Set(ids).size).toBe(ids.length);
    await expectRunningAndHeld(store, trade, service, botId);
  });

  it('a slow create that another process took over as stale finishes without winding the running bot down', async () => {
    const { store, trade, service, process, botId, created, release } = await slowCreate();
    const other = process();
    await other.tickAll();
    expect((await store.findBot(botId))!.status).toBe('running');
    release();
    expect((await created).status).toBe('running');
    await expectRunningAndHeld(store, trade, service, botId);
  });

  it('a slow create refused a level the takeover already placed leaves the running bot running, its reserve held', async () => {
    const { store, trade, service, process, botId, created, release } = await slowCreate({ conflictOnReplay: true });
    await process().tickAll();
    release();
    expect((await created).status).toBe('running');
    const bot = (await store.findBot(botId))!;
    expect([bot.status, bot.statusReason]).toEqual(['running', null]);
    await expectRunningAndHeld(store, trade, service, botId);
  });
});

describe('grid APR · simple, ACT/365, none under a day (CB-bots-05, #6)', () => {
  const DAY = 86_400_000;
  it('under a whole day there is no figure, only the named state', () => {
    expect(gridApr(A('3.5'), A('200'), 0)).toEqual({ state: 'under_a_day', percent: null });
    expect(gridApr(A('3.5'), A('200'), DAY - 1)).toEqual({ state: 'under_a_day', percent: null });
  });
  it('is profit over the investment, times 365 over the days run, rounded down to 2 decimals', () => {
    // 3.50 on 200 over 1 day: 1.75% a day, 638.75% a year.
    expect(gridApr(A('3.5'), A('200'), DAY)).toEqual({ state: 'set', percent: '638.75' });
    // 1.00 on 200 over 7 days: 365 / 7 × 0.5% = 26.0714…%, rounded down.
    expect(gridApr(A('1'), A('200'), 7 * DAY)).toEqual({ state: 'set', percent: '26.07' });
    // A loss rounds down too, away from zero: -26.0714…% reads -26.08.
    expect(gridApr(A('-1'), A('200'), 7 * DAY)).toEqual({ state: 'set', percent: '-26.08' });
    expect(gridApr(0n, A('200'), 2 * DAY)).toEqual({ state: 'set', percent: '0' });
  });
});

describe('grid profit withdrawal (CB-bots-05, #7)', () => {
  const CAPPED = { TRADE_GRID_COUNT_MIN: '2', TRADE_GRID_COUNT_MAX: '100', TRADE_GRID_BOUNDS_MAX_DISTANCE_BPS: '1000' };
  const policy = (cap: string | undefined) => loadGridPolicy({ ...CAPPED, TRADE_BOTS_WITHDRAW_DAILY_CAP: cap });

  /** A bot with one closed pair: its profit raised the reserve over the investment. */
  async function earned(opts: Parameters<typeof setup>[0] = {}) {
    const ctx = setup({ policy: policy('{"USDT":"0.50"}'), ...opts });
    const view = await ctx.service.create(verified(), BODY);
    const buy = view.orders.find((o) => o.levelIndex === 8)!;
    ctx.trade.fill(buy.orderId, 'BTC', A('0.00000001'));
    await ctx.service.tick((await ctx.store.findBot(view.botId))!);
    ctx.trade.fill(oid(`grid:${view.botId}:8:s0`), 'USDT', A('0.01'));
    await ctx.service.tick((await ctx.store.findBot(view.botId))!);
    const bot = await ctx.service.get(verified(), view.botId);
    return { ...ctx, bot };
  }
  const ask = (botId: string, amount: string, requestId = 'withdraw-0001', approval: string | null = 'appr-1') => ({
    botId,
    requestId,
    asset: 'USDT',
    amount,
    stepUpApprovalId: approval,
  });

  it('a closed pair raises the reserve by its profit; the bot view names that as withdrawable', async () => {
    const { bot, store } = await earned();
    expect(A(bot.gridProfit) > 0n).toBe(true);
    expect((await store.getReserve(bot.botId))!.amount).toBe(A('200') + A(bot.gridProfit));
    expect(bot.withdrawableProfit).toBe(bot.gridProfit);
  });

  it('within the cap, the profit and a step-up: lowers the reserve, posts nothing, and answers every receipt field', async () => {
    const id = identity();
    const { bot, store, service } = await earned({ approvals: id.approvals, now: () => new Date('2026-10-30T10:00:00Z') });
    const amount = div(A(bot.gridProfit), A('2'), 'floor');
    const receipt = await service.withdrawProfit(verified(), ask(bot.botId, formatAmount(amount)));
    const profit = A(bot.gridProfit);
    expect(receipt).toEqual({
      withdrawalId: `bots.grid.withdraw:${bot.botId}:withdraw-0001`,
      botId: bot.botId,
      asset: 'USDT',
      amount: formatAmount(amount),
      profitBefore: formatAmount(profit),
      profitAfter: formatAmount(profit - amount),
      reserveBefore: formatAmount(A('200') + profit),
      reserveAfter: formatAmount(A('200') + profit - amount),
      dailyCap: '0.5',
      capUsed: formatAmount(amount),
      capRemaining: formatAmount(A('0.5') - amount),
      stepUpEventId: 'appr-1',
      appliedAt: '2026-10-30T10:00:00.000Z',
    });
    expect((await store.getReserve(bot.botId))!.amount).toBe(A('200') + profit - amount);
    // Identity was asked once, for exactly the fields the person confirmed, under the withdrawal's business key.
    expect(id.consumed).toHaveLength(1);
    expect(id.consumed[0]!.requestId).toBe(receipt.withdrawalId);
    // The same key again answers the same receipt and lowers nothing more; a different amount under it conflicts.
    expect(await service.withdrawProfit(verified(), ask(bot.botId, formatAmount(amount)))).toEqual(receipt);
    expect((await store.getReserve(bot.botId))!.amount).toBe(A('200') + profit - amount);
    expect((await refusal(service.withdrawProfit(verified(), ask(bot.botId, '0.000001')))).code).toBe('trade.bots_withdraw_conflict');
    expect((await service.get(verified(), bot.botId)).withdrawableProfit).toBe(formatAmount(profit - amount));
  });

  it('over the cap refuses cap_exceeded, before the profit check, and changes nothing', async () => {
    const { bot, store, service } = await earned();
    const before = await store.getReserve(bot.botId);
    const r = await refusal(service.withdrawProfit(verified(), ask(bot.botId, '1.00')));
    expect(r.code).toBe('trade.bots_withdraw_cap_exceeded');
    expect(r.data).toEqual({ cap: '0.5', used: '0', remaining: '0.5' });
    expect(await store.getReserve(bot.botId)).toEqual(before);
    expect(await store.findWithdrawal(`bots.grid.withdraw:${bot.botId}:withdraw-0001`)).toBeNull();
  });

  it('the cap counts every withdrawal of the owner and asset in one UTC day, and starts again the next day', async () => {
    let now = new Date('2026-10-30T23:00:00Z');
    const { bot, service } = await earned({ policy: policy('{"USDT":"0.000002"}'), now: () => now });
    await service.withdrawProfit(verified(), ask(bot.botId, '0.000002', 'withdraw-0001'));
    const r = await refusal(service.withdrawProfit(verified(), ask(bot.botId, '0.000001', 'withdraw-0002')));
    expect(r.code).toBe('trade.bots_withdraw_cap_exceeded');
    expect(r.data).toEqual({ cap: '0.000002', used: '0.000002', remaining: '0' });
    now = new Date('2026-10-31T00:00:01Z');
    const next = await service.withdrawProfit(verified(), ask(bot.botId, '0.000001', 'withdraw-0002'));
    expect(next.capUsed).toBe('0.000001');
  });

  it('more than the profit the reserve holds refuses exceeds_profit and changes nothing', async () => {
    const { bot, store, service } = await earned({ policy: policy('{"USDT":"1000"}') });
    const before = await store.getReserve(bot.botId);
    const over = formatAmount(A(bot.gridProfit) + A('0.000001'));
    const r = await refusal(service.withdrawProfit(verified(), ask(bot.botId, over)));
    expect(r.code).toBe('trade.bots_withdraw_exceeds_profit');
    expect(r.data).toEqual({ available: bot.gridProfit });
    expect(await store.getReserve(bot.botId)).toEqual(before);
  });

  it('more than the free ledger balance refuses exceeds_balance and changes nothing; the view offers at most that', async () => {
    let free = '1000';
    const { bot, store, service } = await earned({ policy: policy('{"USDT":"1000"}'), free: () => free });
    free = formatAmount(div(A(bot.gridProfit), A('2'), 'floor'));
    const view = await service.get(verified(), bot.botId);
    expect(view.withdrawableProfit).toBe(free);
    const before = await store.getReserve(bot.botId);
    const r = await refusal(service.withdrawProfit(verified(), ask(bot.botId, formatAmount(A(free) + A('0.000001')))));
    expect(r.code).toBe('trade.bots_withdraw_exceeds_balance');
    expect(r.data).toEqual({ available: free });
    expect(await store.getReserve(bot.botId)).toEqual(before);
    expect(await store.findWithdrawal(`bots.grid.withdraw:${bot.botId}:withdraw-0001`)).toBeNull();
  });

  it('invariant: after any mix of closes and withdrawals, investment <= reserve = investment + closed profit - withdrawn', async () => {
    for (const seed of [1, 7, 42, 99, 2026]) {
      let x = seed;
      const rand = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
      const ctx = setup({ policy: policy('{"USDT":"1000"}') });
      const view = await ctx.service.create(verified(), BODY);
      const investment = A(view.investment);
      let cycle = 0;
      let withdrawn = 0n;
      let requests = 0;
      for (let step = 0; step < 12; step++) {
        const current = await ctx.service.get(verified(), view.botId);
        if (rand(2) === 0 || A(current.withdrawableProfit) === 0n) {
          // One more pair closes on level 8: its buy fills, the sell above it fills.
          ctx.trade.fill(oid(`grid:${view.botId}:8:b${cycle}`), 'BTC', A('0.00000001'));
          await ctx.service.tick((await ctx.store.findBot(view.botId))!);
          ctx.trade.fill(oid(`grid:${view.botId}:8:s${cycle}`), 'USDT', A('0.01'));
          await ctx.service.tick((await ctx.store.findBot(view.botId))!);
          cycle += 1;
        } else {
          const orders = ctx.trade.orders.size;
          const room = A(current.withdrawableProfit);
          // Within it, or (one time in three) just over it, which is refused and changes nothing.
          const over = rand(3) === 0;
          const amount = over ? room + 1n : (room * BigInt(1 + rand(100))) / 100n;
          if (amount === 0n) continue;
          const asked = ctx.service.withdrawProfit(verified(), ask(view.botId, formatAmount(amount), `withdraw-${seed}-${requests++}`));
          if (over) expect((await refusal(asked)).code).toBe('trade.bots_withdraw_exceeds_profit');
          else withdrawn += A((await asked).amount);
          // A withdrawal places, cancels and posts nothing: the trade port saw no new order.
          expect(ctx.trade.orders.size).toBe(orders);
        }
        const after = await ctx.service.get(verified(), view.botId);
        const reserve = (await ctx.store.getReserve(view.botId))!.amount;
        expect(after.closedPairs).toBe(cycle);
        expect(reserve >= investment).toBe(true);
        expect(reserve).toBe(investment + A(after.gridProfit) - withdrawn);
        expect(A(after.withdrawableProfit)).toBe(reserve - investment);
      }
      expect(cycle).toBeGreaterThan(0);
    }
  });

  it('no step-up sent refuses identity.step_up_required unchanged, and nothing is read or written', async () => {
    const id = identity();
    const { bot, store, service } = await earned({ approvals: id.approvals });
    const before = await store.getReserve(bot.botId);
    const find = vi.spyOn(store, 'findBot');
    for (const approval of [null, '']) {
      expect((await refusal(service.withdrawProfit(verified(), ask(bot.botId, '0.000001', 'withdraw-0001', approval)))).code).toBe(
        'identity.step_up_required',
      );
    }
    expect(find).not.toHaveBeenCalled();
    expect(id.consumed).toEqual([]);
    expect(await store.getReserve(bot.botId)).toEqual(before);
  });

  it('identity down refuses identity.step_up_unavailable: no reserve change, no receipt, the profit still in place', async () => {
    const down = identity(new TypeError('fetch failed'));
    const { bot, store, service, process } = await earned({ approvals: down.approvals });
    const before = await store.getReserve(bot.botId);
    expect((await refusal(service.withdrawProfit(verified(), ask(bot.botId, '0.000001')))).code).toBe('identity.step_up_unavailable');
    expect(await store.getReserve(bot.botId)).toEqual(before);
    expect(await store.findWithdrawal(`bots.grid.withdraw:${bot.botId}:withdraw-0001`)).toBeNull();
    expect((await process().get(verified(), bot.botId)).withdrawableProfit).toBe(bot.gridProfit);
    // Identity not wired at all fails closed the same way.
    const unwired = await earned({ approvals: null });
    expect((await refusal(unwired.service.withdrawProfit(verified(), ask(unwired.bot.botId, '0.000001')))).code).toBe(
      'identity.step_up_unavailable',
    );
  });

  it('a blank cap, or an asset missing from the map, refuses cap_unset before identity is asked', async () => {
    for (const cap of [undefined, '', '{"BTC":"1"}']) {
      const id = identity();
      const { bot, store, service } = await earned({ policy: policy(cap), approvals: id.approvals });
      const before = await store.getReserve(bot.botId);
      const r = await refusal(service.withdrawProfit(verified(), ask(bot.botId, '0.000001')));
      expect(r.code).toBe('trade.bots_withdraw_cap_unset');
      expect(id.consumed).toEqual([]);
      expect(await store.getReserve(bot.botId)).toEqual(before);
    }
  });

  it('refuses below the owner verification level, a blank amount and another person’s bot', async () => {
    const { bot, store, service } = await earned();
    expect((await refusal(service.withdrawProfit(verified('basic'), ask(bot.botId, '0.000001')))).code).toBe(
      'trade.bots_verification_insufficient',
    );
    for (const amount of ['', '0', '-1', 'abc']) {
      expect((await refusal(service.withdrawProfit(verified(), ask(bot.botId, amount)))).code).toBe('trade.bots_withdraw_amount_invalid');
    }
    // Another person: identity's answer is not their approval, so step-up refuses before the bot is read; and with one of
    // their own that identity accepts, the bot is not theirs.
    const BOB = '22222222-2222-4222-8222-222222222222';
    const other = { ...principalFor(BOB), tier: 'full' } as Principal;
    expect((await refusal(service.withdrawProfit(other, ask(bot.botId, '0.000001')))).code).toBe('identity.step_up_required');
    const bobs = setup({ policy: policy('{"USDT":"0.50"}'), approvals: identity(undefined, BOB).approvals, store });
    expect((await refusal(bobs.service.withdrawProfit(other, ask(bot.botId, '0.000001')))).code).toBe('trade.grid_not_found');
  });

  it('a request key too long for step-up refuses grid_request_key_invalid before identity is asked', async () => {
    const id = identity();
    const { bot, service } = await earned({ approvals: id.approvals });
    const long = 'k'.repeat(128 - `bots.grid.withdraw:${bot.botId}:`.length + 1);
    expect((await refusal(service.withdrawProfit(verified(), ask(bot.botId, '0.000001', long)))).code).toBe(
      'trade.grid_request_key_invalid',
    );
    expect(id.consumed).toEqual([]);
  });

  it('a stopped bot has released its reserve: its profit is already free, so it refuses reserve_released', async () => {
    const { bot, service } = await earned();
    await service.stop(verified(), bot.botId);
    expect((await refusal(service.withdrawProfit(verified(), ask(bot.botId, '0.000001')))).code).toBe(
      'trade.bots_withdraw_reserve_released',
    );
  });

  it('a cap value that is not a positive decimal string stops the boot', () => {
    for (const cap of ['not json', '[]', '{"USDT":0.5}', '{"USDT":"0"}', '{"USDT":"-1"}', '{"usdt":"1"}']) {
      expect(() => policy(cap)).toThrow(/TRADE_BOTS_WITHDRAW_DAILY_CAP/);
    }
  });
});
