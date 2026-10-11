import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes, orderHoldAccount } from '@intafaced/ledger-client';
import type { IdentityOperationDecision, IdentityOperationDecisionPort } from '@intafaced/contracts';
import { TradeService } from '../spot/trade-service.js';
import { PositionService } from '../futures/position-service.js';
import { memoryMarkBook } from '../futures/mark-source.js';
import { profitSourceFromConfig, recipeProfitFundingAccount, formatAccountRef } from '../futures/profit-source.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import { TradingControls } from './trading-controls.js';
import '../spot/qty-up-amend.js';
import { CopyService } from '../copy/copy-service.js';

const user = 'a1111111-1111-4111-8111-111111111111';
const operator = 'b1111111-1111-4111-8111-111111111111';
const context = () => ({ principal: { ...principalFor(operator), mfa: true }, service: null, region: 'XX', requestId: randomUUID() });
const command = () => ({
  requestId: randomUUID(),
  target: { area: 'trading' as const, userId: user },
  action: 'restrict' as const,
  reason: 'Investigate account activity',
  expectedVersion: '0',
});

describe('Real exposure paths use owner admission (isolated PostgreSQL)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let controls: TradingControls;
  let trade: TradeService;
  let onGrant: (() => Promise<void>) | undefined;
  let spot: Awaited<ReturnType<TradeService['listMarket']>>;
  let identityRows: Map<string, IdentityOperationDecision>;
  const identity: IdentityOperationDecisionPort = {
    async decide({ mode, intent }) {
      const key = intent.operation.userId + ':' + intent.businessId;
      const old = identityRows.get(key);
      if (old) return old;
      const result: IdentityOperationDecision =
        mode === 'grant'
          ? { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() }
          : { status: 'cancelled', intent, code: 'admission.cancelled', decidedAt: new Date().toISOString() };
      identityRows.set(key, result);
      if (mode === 'grant') await onGrant?.();
      return result;
    },
  };
  function build(admission = controls) {
    return new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      accountAdmission: admission,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      convertEnabled: true,
      convertSpreadBps: 25,
      convertQuoteTtlMs: 60000,
      marketSlippageCapBps: 100,
    });
  }
  const order = (clientOrderId: string = randomUUID()) => ({
    marketId: spot.id,
    side: 'buy' as const,
    type: 'limit',
    qty: amt('1'),
    price: amt('100'),
    clientOrderId,
  });
  beforeAll(async () => {
    const directory = new URL('../../drizzle/', import.meta.url);
    const migrations = readdirSync(directory)
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, directory), 'utf8'));
    db = await createTestDatabase({ service: 'trade', migrations });
  }, 30_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await db.truncateAll();
    ledger = new MemoryLedger();
    matching = new StubMatching();
    onGrant = undefined;
    identityRows = new Map();
    matching.bids = [['99', '100']];
    matching.asks = [['100', '100']];
    controls = new TradingControls(db.sql, { check: async () => 'enabled' }, identity);
    trade = build();
    spot = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.01'),
      minQty: amt('0.01'),
      maxQty: amt('100'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    await ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt('10000'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: randomUUID() }));
  });
  it('direct order and installed native qty-up refuse after restriction; original retry/cancel release still work', async () => {
    const input = order();
    const placed = await trade.placeOrder(principalFor(user), input);
    await controls.change(context(), command());
    await expect(trade.placeOrder(principalFor(user), order())).rejects.toMatchObject({ code: 'trade.account_restricted' });
    await expect(trade.amendOrder(principalFor(user), placed.id, { qty: amt('2') })).rejects.toMatchObject({
      code: 'trade.account_restricted',
    });
    expect(matching.amended).toHaveLength(0);
    expect((await trade.placeOrder(principalFor(user), input)).id).toBe(placed.id);
    expect((await trade.cancelOrder(principalFor(user), placed.id)).status).toBe('cancelled');
    expect((await ledger.balance(orderHoldAccount(user, 'USDT', placed.id))).amount).toBe(0n);
  });
  it('native qty-up admits its own exact original amount before posting the extra hold', async () => {
    const placed = await trade.placeOrder(principalFor(user), order());
    expect((await trade.amendOrder(principalFor(user), placed.id, { qty: amt('2') })).code).toBe('AMENDED');
    const rows = await db.sql`SELECT intent, payload FROM trade.operation_intents WHERE intent->'operation'->>'kind' = 'order.increase'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ qty: '2', extra: '100' });
  });
  it('recovers a funded native increase after response loss and restriction without a new grant or hold', async () => {
    const placed = await trade.placeOrder(principalFor(user), order());
    const amend = matching.amend.bind(matching);
    matching.amend = async () => {
      throw new Error('Synthetic lost amendment response before engine execution');
    };
    expect((await trade.amendOrder(principalFor(user), placed.id, { qty: amt('2') })).code).toBe('AMEND_UNKNOWN');
    expect((await ledger.balance(orderHoldAccount(user, 'USDT', placed.id))).amount).toBe(amt('200'));
    await controls.change(context(), command());
    matching.amend = amend;
    // Simulate owner reconciliation proving the engine kept the old version.
    await db.sql`UPDATE trade.orders SET status='open',recovery_reason=NULL WHERE id=${placed.id}`;
    await expect(trade.amendOrder(principalFor(user), placed.id, { qty: amt('3') })).rejects.toMatchObject({ code: 'operation.conflict' });
    expect(matching.amended).toHaveLength(0);
    expect((await trade.amendOrder(principalFor(user), placed.id, { qty: amt('2') })).code).toBe('AMENDED');
    expect(identityRows.size).toBe(2);
    expect((await ledger.balance(orderHoldAccount(user, 'USDT', placed.id))).amount).toBe(amt('200'));
  });
  it('new Convert execution cannot bypass restriction and moves no additional money', async () => {
    const quote = await trade.convertQuote(principalFor(user), { symbol: spot.symbol, side: 'buy', qty: amt('1') });
    await controls.change(context(), command());
    const before = ledger.journal().length;
    await expect(trade.convertExecute(principalFor(user), { quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'trade.account_restricted',
    });
    expect(ledger.journal()).toHaveLength(before);
  });
  it('Convert lost identity response recovers original acceptedAt after restriction, without a fresh decision', async () => {
    const quote = await trade.convertQuote(principalFor(user), { symbol: spot.symbol, side: 'buy', qty: amt('1') });
    onGrant = async () => {
      throw new Error('injected response loss');
    };
    await expect(trade.convertExecute(principalFor(user), { quoteId: quote.quoteId })).rejects.toMatchObject({
      code: 'authority.unavailable',
    });
    await controls.change(context(), command());
    onGrant = undefined;
    expect(await trade.convertExecute(principalFor(user), { quoteId: quote.quoteId })).toMatchObject({
      quoteId: quote.quoteId,
      outAmount: '1',
    });
    expect(identityRows.size).toBe(1);
  });
  it('grant then SQL-response loss can recover original order after restriction and market halt', async () => {
    const input = order('crash-order');
    onGrant = async () => {
      throw new Error('injected response loss after grant');
    };
    await expect(trade.placeOrder(principalFor(user), input)).rejects.toMatchObject({ code: 'authority.unavailable' });
    expect(matching.submitted).toHaveLength(0);
    await controls.change(context(), command());
    onGrant = undefined;
    await db.sql`UPDATE trade.markets SET status = 'halted' WHERE id = ${spot.id}`;
    const recovered = await trade.placeOrder(principalFor(user), input);
    expect(recovered.status).toBe('open');
    expect(matching.submitted).toHaveLength(1);
    expect(matching.submitted[0]?.request).toMatchObject({ qty: '1', price: '100' });
    await expect(trade.placeOrder(principalFor(user), { ...input, qty: amt('2') })).rejects.toThrow();
  });
  it('production class without an admission port refuses before any new order hold', async () => {
    const absent = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    });
    const before = ledger.journal().length;
    await expect(absent.placeOrder(principalFor(user), order())).rejects.toMatchObject({ code: 'authority.unavailable' });
    expect(ledger.journal()).toHaveLength(before);
    expect(matching.submitted).toHaveLength(0);
  });
  it('direct futures open cannot bypass restriction; an original opened position may still close', async () => {
    const marketId = randomUUID();
    const symbol = 'BTC/USDT:PERP';
    const now = new Date();
    await db.sql`INSERT INTO trade.markets(id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty,
      min_notional, maker_bps, taker_bps, status, display_name, listed_at) VALUES (${marketId}, ${symbol}, 'BTC', 'USDT', 'futures', '0.01', '0.01', '0.01', '1', 10, 20, 'active', 'BTC perpetual', ${now})`;
    const marks = memoryMarkBook();
    marks.set({ marketId, symbol, price: '100', quality: 'mid', asOfMs: now.getTime() });
    const positions = new PositionService(db.sql, ledger, {
      accountAdmission: controls,
      marks: marks.source(),
      profitSource: profitSourceFromConfig(formatAccountRef(recipeProfitFundingAccount('USDT'))),
      maxLeverage: amt('10'),
      now: () => now,
    });
    const input = { userId: user, symbol, side: 'long' as const, size: amt('1'), leverage: amt('2'), clientOpenId: 'first' };
    const placed = await positions.open(input, principalFor(user));
    await controls.change(context(), command());
    const before = ledger.journal().length;
    await expect(positions.open({ ...input, clientOpenId: 'second' }, principalFor(user))).rejects.toMatchObject({
      code: 'trade.account_restricted',
    });
    await expect(
      positions.setLeverage(
        { userId: user, symbol, positionId: placed.id!, leverage: amt('3'), clientAdjustmentId: 'increase' },
        principalFor(user),
      ),
    ).rejects.toMatchObject({ code: 'trade.account_restricted' });
    expect(ledger.journal()).toHaveLength(before);
    expect((await positions.close(user, placed.id!)).status).toBe('closed');
  });
  it('TWAP parent permission never admits a fresh child after restriction; legacy parents refuse and cancel remains', async () => {
    const parent = await trade.createTwap(principalFor(user), {
      marketId: spot.id,
      side: 'buy',
      totalQty: amt('2'),
      durationMs: 2000,
      sliceIntervalMs: 1000,
      limitPrice: amt('100'),
      clientAlgoId: 'twap-restriction',
    });
    await controls.change(context(), command());
    expect((await trade.tickAlgo(parent.id)).kind).toBe('miss');
    expect(matching.submitted).toHaveLength(0);
    expect((await trade.cancelAlgo(principalFor(user), parent.id)).status).toBe('cancelled');
    await db.sql`TRUNCATE trade.account_restrictions, trade.operation_intents`;
    const legacy = await trade.createTwap(principalFor(user), {
      marketId: spot.id,
      side: 'buy',
      totalQty: amt('2'),
      durationMs: 2000,
      sliceIntervalMs: 1000,
      limitPrice: amt('100'),
      clientAlgoId: 'legacy-parent',
    });
    await db.sql`TRUNCATE trade.operation_intents`;
    expect((await trade.tickAlgo(legacy.id)).kind).toBe('miss');
    expect(matching.submitted).toHaveLength(0);
    expect((await trade.cancelAlgo(principalFor(user), legacy.id)).status).toBe('cancelled');
  });
  it('lost strategy grant response publishes no parent; owner recovery restores original proposal without fresh children', async () => {
    onGrant = async () => {
      throw new Error('injected strategy response loss');
    };
    await expect(
      trade.createTwap(principalFor(user), {
        marketId: spot.id,
        side: 'buy',
        totalQty: amt('2'),
        durationMs: 2000,
        sliceIntervalMs: 1000,
        limitPrice: amt('100'),
        clientAlgoId: 'recover-strategy',
      }),
    ).rejects.toMatchObject({ code: 'authority.unavailable' });
    expect(await db.sql`SELECT id FROM trade.algo_parents`).toHaveLength(0);
    const [prepared] = await db.sql`SELECT payload FROM trade.operation_intents`;
    const parentId = prepared!.payload.parent.id as string;
    await controls.change(context(), command());
    onGrant = undefined;
    const restarted = build();
    expect(await restarted.recoverAdmittedAlgo(user, parentId)).toMatchObject({ id: parentId, totalQty: amt('2') });
    expect((await restarted.tickAlgo(parentId)).kind).toBe('miss');
    expect(matching.submitted).toHaveLength(0);
    expect((await restarted.recoverAdmittedAlgo(user, parentId))?.misses).toHaveLength(1);
    expect(identityRows.size).toBe(1);
  });
  it('verified copy follow provenance still needs a fresh mirror decision; unknown/foreign follow ids cannot grant', async () => {
    const copy = new CopyService(ledger, { accountAdmission: controls, jurisdictionLaw: { published: true, allowedRegions: ['SG'] } });
    const follow = await copy.follow(principalFor(user), {
      leaderId: operator,
      region: 'SG',
      permittedMarkets: [spot.symbol],
      maxNotionalPerOrder: '500',
      maxAggregateExposure: '1000',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await expect(trade.placeCopyMirror(principalFor(user), order(), randomUUID())).rejects.toMatchObject({
      code: 'auth.credential_denied',
    });
    await controls.change(context(), command());
    await expect(trade.placeCopyMirror(principalFor(user), order(), follow.followId)).rejects.toMatchObject({
      code: 'trade.account_restricted',
    });
    expect(matching.submitted).toHaveLength(0);
    const restored = { ...command(), action: 'restore' as const, expectedVersion: '1' };
    await controls.change(context(), restored);
    const placed = await trade.placeCopyMirror(principalFor(user), order(), follow.followId);
    expect(placed.status).toBe('open');
    const [row] = await db.sql`SELECT intent FROM trade.operation_intents WHERE intent->'operation'->>'kind' = 'copy.mirror'`;
    expect(row?.intent.authority.kind).toBe('delegation');
  });
});
