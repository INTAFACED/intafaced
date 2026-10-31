/**
 * TRADEOPSBE acceptance. Real Postgres via TEST_DATABASE_URL. No Docker here.
 * Identity restriction history is not in this feed; that stays in svc-identity.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, orderHoldAccount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { AuthError } from '@intafaced/auth';
import { TradeService } from '../controls/test-admission.js';
import { TradeError } from '../spot/types.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import { TradingControls } from '../controls/trading-controls.js';
import { MemoryApprovalBook, payloadHash } from './common.js';
import { TradeOpsAdmin } from './service.js';
import { currentRisk, currentRiskForMarkets } from './risk.js';
import { readOpenInterestLimits } from '../futures/open-interest-limits.js';
import { readPriceRangeSettings, sqlPriceBandStore } from '../futures/dynamic-price-band.js';
import { tradeOpsAdminRouter } from './router.js';
import { bindTradingRestrictApprovals } from './trading-restrict.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
/**
 * Same host and role as TEST_DATABASE_URL. assertTestDatabase refuses an admin
 * connection whose database name does not end in `_test` (the shared file names
 * the database `test`). `intafaced_test` is the documented admin database on that
 * server; createTestDatabase still creates its own per-run database from it.
 */
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const operator = () => principalFor(OP, ['admin:read']);
const operatorWriter = () => principalFor(OP, ['admin:read', 'admin:write']);
const customer = () => principalFor(ALICE, ['trade:read']);
const BLANK_LIMITS = { collar: null, fatFinger: null, slippageCap: null, throttle: null, circuitBreaker: null };

describe('trade operator procedures', () => {
  let db: TestDatabase;
  let trade: TradeService;
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let book: MemoryApprovalBook;
  let admin: TradeOpsAdmin;
  let marketId = '';
  let otherMarketId = '';

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE
      trade.operator_audit,
      trade.operator_requests,
      trade.operator_risk_limits,
      trade.operator_export_jobs,
      trade.operator_mm_seed,
      trade.operator_reconcile_sweeps,
      trade.market_status_transitions,
      trade.account_restrictions,
      trade.account_control_history,
      trade.account_control_requests,
      trade.fills,
      trade.orders,
      trade.positions,
      trade.markets
      RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    matching = new StubMatching();
    trade = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    });
    const btc = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    const eth = await trade.listMarket({
      symbol: 'ETH/USDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.001'),
      minQty: amt('0.001'),
      maxQty: null,
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    marketId = btc.id;
    otherMarketId = eth.id;
    book = new MemoryApprovalBook();
    admin = new TradeOpsAdmin({
      sql: db.sql,
      approvals: book,
      ledger,
      reconcileOrder: (orderId) => trade.reconcileOrder(orderId),
      cancelOrder: async (orderId, userId) => {
        await trade.cancelOrder(principalFor(userId), orderId);
      },
    });
  });

  afterEach(() => {
    delete process.env.TRADE_OPERATOR_EXPORT_CAP;
    delete process.env.TRADE_OPERATOR_EXPORT_SIGNING_KEY;
    delete process.env.IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL;
    delete process.env.TRADE_RECONCILE_JOBS_ENABLED;
    bindTradingRestrictApprovals(null);
  });

  function allow(input: {
    approvalId: string;
    actionType: string;
    targetId: string;
    expectedVersion: string;
    body: unknown;
    /** Identity mints one per four-eyes proposal; its consume refuses any other. */
    operationId?: string;
  }): void {
    book.put({
      ...(input.operationId ? { operationId: input.operationId } : {}),
      approvalId: input.approvalId,
      actionType: input.actionType,
      targetService: 'svc-trade',
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: payloadHash(input.body),
      requesterId: OP,
      approverId: APPROVER,
    });
  }

  async function fund(userId: string, amount: string): Promise<void> {
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: randomUUID() }));
  }

  async function held(userId: string, orderId: string): Promise<string> {
    return formatAmount((await ledger.balance(orderHoldAccount(userId, 'USDT', orderId))).amount);
  }

  it('cancels one market, releases those holds, and leaves the other market', async () => {
    await fund(ALICE, '10000');
    await fund(BOB, '10000');
    const a = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'a-btc',
    });
    const b = await trade.placeOrder(principalFor(BOB), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('90'),
      clientOrderId: 'b-btc',
    });
    const other = await trade.placeOrder(principalFor(ALICE), {
      marketId: otherMarketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: 'a-eth',
    });
    expect(await held(ALICE, a.id)).toBe('100');
    expect(await held(BOB, b.id)).toBe('90');
    const reason = 'clear the btc book';
    const scope = `market:${marketId}|account:`;
    allow({
      approvalId: 'appr-cancel',
      actionType: 'trade.mass_cancel',
      targetId: scope,
      expectedVersion: '0',
      body: { actionType: 'trade.mass_cancel', scope, reason },
    });
    const first = await admin.massCancel(operatorWriter(), {
      market: marketId,
      reason,
      approvalId: 'appr-cancel',
      clientRequestId: 'cancel-btc',
    });
    expect(first.results.map((row) => row.orderId).sort()).toEqual([a.id, b.id].sort());
    expect(first.results.every((row) => row.ok)).toBe(true);
    expect(await held(ALICE, a.id)).toBe('0');
    expect(await held(BOB, b.id)).toBe('0');
    expect(await held(ALICE, other.id)).toBe('50');
    const again = await admin.massCancel(operatorWriter(), {
      market: marketId,
      reason,
      approvalId: 'appr-cancel',
      clientRequestId: 'cancel-btc',
    });
    expect(again).toEqual(first);
    expect((await trade.findOrder(other.id))?.status).toBe('open');
  });

  it('mass cancel reports an order the engine no longer has as not cancelled, and leaves its hold (#6874)', async () => {
    await fund(ALICE, '1000');
    const gone = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'gone-btc',
    });
    // The engine matched it in full a moment ago; the fill has not landed.
    matching.scriptCancelMiss(gone.id);
    const reason = 'clear the btc book';
    const scope = `market:${marketId}|account:`;
    allow({
      approvalId: 'appr-cancel-gone',
      actionType: 'trade.mass_cancel',
      targetId: scope,
      expectedVersion: '0',
      body: { actionType: 'trade.mass_cancel', scope, reason },
    });
    const result = await admin.massCancel(operatorWriter(), {
      market: marketId,
      reason,
      approvalId: 'appr-cancel-gone',
      clientRequestId: 'cancel-gone',
    });
    expect(result.results).toEqual([{ orderId: gone.id, ok: false, code: 'trade.cancel_ahead_of_fill' }]);
    expect(await held(ALICE, gone.id)).toBe('100');
    expect((await trade.findOrder(gone.id))?.status).toBe('open');
  });

  it('refuses a missing, reused, or mismatched approval and cancels nothing', async () => {
    await fund(ALICE, '1000');
    const order = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('10'),
      clientOrderId: 'keep',
    });
    const reason = 'should not run';
    await expect(
      admin.massCancel(operatorWriter(), { market: marketId, reason, approvalId: 'missing', clientRequestId: 'c1' }),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    allow({
      approvalId: 'bad-hash',
      actionType: 'trade.mass_cancel',
      targetId: 'somewhere-else',
      expectedVersion: '0',
      body: { actionType: 'trade.mass_cancel', scope: 'nope', reason },
    });
    await expect(
      admin.massCancel(operatorWriter(), { market: marketId, reason, approvalId: 'bad-hash', clientRequestId: 'c2' }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    const scope = `market:${marketId}|account:`;
    allow({
      approvalId: 'once',
      actionType: 'trade.mass_cancel',
      targetId: scope,
      expectedVersion: '0',
      body: { actionType: 'trade.mass_cancel', scope, reason: 'real clear' },
    });
    await admin.massCancel(operatorWriter(), {
      market: marketId,
      reason: 'real clear',
      approvalId: 'once',
      clientRequestId: 'c3',
    });
    await fund(ALICE, '1000');
    const later = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('10'),
      clientOrderId: 'later',
    });
    await expect(
      admin.massCancel(operatorWriter(), { market: marketId, reason: 'real clear', approvalId: 'once', clientRequestId: 'c4' }),
    ).rejects.toMatchObject({ code: 'approval_reused' });
    expect((await trade.findOrder(later.id))?.status).toBe('open');
    expect((await trade.findOrder(order.id))?.status).toBe('cancelled');
  });

  it('reports one failing order and still cancels the rest', async () => {
    await fund(ALICE, '5000');
    const ok = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('10'),
      clientOrderId: 'ok-order',
    });
    const bad = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('11'),
      clientOrderId: 'bad-order',
    });
    const local = new TradeOpsAdmin({
      sql: db.sql,
      approvals: book,
      ledger,
      reconcileOrder: (orderId) => trade.reconcileOrder(orderId),
      cancelOrder: async (orderId, userId) => {
        if (orderId === bad.id) throw new TradeError('matching refused this one', 'trade.order_not_open');
        await trade.cancelOrder(principalFor(userId), orderId);
      },
    });
    const reason = 'partial clear';
    const scope = `market:${marketId}|account:`;
    allow({
      approvalId: 'partial',
      actionType: 'trade.mass_cancel',
      targetId: scope,
      expectedVersion: '0',
      body: { actionType: 'trade.mass_cancel', scope, reason },
    });
    const result = await local.massCancel(operatorWriter(), {
      market: marketId,
      reason,
      approvalId: 'partial',
      clientRequestId: 'partial-1',
    });
    expect(result.results.find((row) => row.orderId === ok.id)).toMatchObject({ ok: true });
    expect(result.results.find((row) => row.orderId === bad.id)).toMatchObject({ ok: false, code: 'trade.order_not_open' });
    expect(await held(ALICE, ok.id)).toBe('0');
    expect(await held(ALICE, bad.id)).toBe('11');
  });

  it('refuses a whole-venue cancel and a session without admin:read', async () => {
    await expect(
      admin.massCancel(operatorWriter(), { reason: 'everything', approvalId: 'x', clientRequestId: 'venue' }),
    ).rejects.toMatchObject({
      code: 'mass_cancel_venue_refused',
    });
    await expect(
      admin.massCancel(customer(), { market: marketId, reason: 'nope', approvalId: 'x', clientRequestId: 'cust' }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('refuses a stale or unapproved risk write and keeps every version', async () => {
    const reason = 'publish the fat-finger ceiling';
    await expect(
      admin.riskSet(operatorWriter(), {
        market: marketId,
        limits: { ...BLANK_LIMITS, fatFinger: '50' },
        expectedVersion: '0',
        reason,
        approvalId: 'none',
        operationId: 'op-none',
      }),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    expect(await admin.riskHistory(operator(), marketId)).toEqual([]);
    const limits = { ...BLANK_LIMITS, fatFinger: '50' };
    allow({
      approvalId: 'risk-1',
      actionType: 'trade.risk_set',
      operationId: 'op-risk-1',
      targetId: marketId,
      expectedVersion: '0',
      body: { actionType: 'trade.risk_set', market: marketId, limits, expectedVersion: '0', reason },
    });
    // The approval's own operation id, never its approval id: identity mints a separate one and refuses any other.
    await expect(
      admin.riskSet(operatorWriter(), {
        market: marketId,
        limits,
        expectedVersion: '0',
        reason,
        approvalId: 'risk-1',
        operationId: 'risk-1',
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    const first = await admin.riskSet(operatorWriter(), {
      market: marketId,
      limits,
      expectedVersion: '0',
      reason,
      approvalId: 'risk-1',
      operationId: 'op-risk-1',
    });
    expect(first.version).toBe('1');
    expect(first.fatFinger).toBe('50');
    expect(first.collar).toBeNull();
    allow({
      approvalId: 'risk-stale',
      actionType: 'trade.risk_set',
      operationId: 'op-risk-stale',
      targetId: marketId,
      expectedVersion: '0',
      body: { actionType: 'trade.risk_set', market: marketId, limits, expectedVersion: '0', reason },
    });
    await expect(
      admin.riskSet(operatorWriter(), {
        market: marketId,
        limits,
        expectedVersion: '0',
        reason,
        approvalId: 'risk-stale',
        operationId: 'op-risk-stale',
      }),
    ).rejects.toMatchObject({ code: 'risk_limit_stale' });
    const next = { ...BLANK_LIMITS, fatFinger: '80' };
    allow({
      approvalId: 'risk-2',
      actionType: 'trade.risk_set',
      operationId: 'op-risk-2',
      targetId: marketId,
      expectedVersion: '1',
      body: { actionType: 'trade.risk_set', market: marketId, limits: next, expectedVersion: '1', reason },
    });
    await admin.riskSet(operatorWriter(), {
      market: marketId,
      limits: next,
      expectedVersion: '1',
      reason,
      approvalId: 'risk-2',
      operationId: 'op-risk-2',
    });
    const history = await admin.riskHistory(operator(), marketId);
    expect(history.map((row) => row.version)).toEqual(['1', '2']);
    expect(history.every((row) => row.operatorId === OP && row.approverId === APPROVER)).toBe(true);
    expect(await admin.riskGet(operator(), marketId)).toMatchObject({ version: '2', fatFinger: '80', slippageCap: null });
  });

  it('writes the open-interest pair, keeps it on a write that leaves it out, and clears it on null (D-margin-05)', async () => {
    const reason = 'publish the open-interest limits';
    const write = async (limits: Record<string, string | null>, expectedVersion: string, approvalId: string) => {
      allow({
        approvalId,
        actionType: 'trade.risk_set',
        operationId: `op-${approvalId}`,
        targetId: marketId,
        expectedVersion,
        body: { actionType: 'trade.risk_set', market: marketId, limits, expectedVersion, reason },
      });
      return admin.riskSet(operatorWriter(), {
        market: marketId,
        limits: limits as typeof BLANK_LIMITS,
        expectedVersion,
        reason,
        approvalId,
        operationId: `op-${approvalId}`,
      });
    };
    for (const bad of [
      { oiShareBps: '0' },
      { oiShareBps: '10001' },
      { oiShareBps: '12.5' },
      { oiLimit: '-1' },
      { oiLimit: `1${'0'.repeat(40)}` },
    ]) {
      await expect(write({ ...BLANK_LIMITS, oiLimit: '1000', oiShareBps: '1000', ...bad }, '0', 'oi-bad')).rejects.toMatchObject({
        code: 'risk_limit_not_exact',
      });
    }
    const first = await write({ ...BLANK_LIMITS, oiLimit: '1000', oiShareBps: '1000' }, '0', 'oi-1');
    expect(first).toMatchObject({ version: '1', oiLimit: '1000', oiShareBps: '1000' });
    expect(readOpenInterestLimits(await currentRisk(db.sql, marketId))).toEqual({ limit: amt('1000'), shareBps: 1000 });

    // An older desk that sends only the five other fields keeps the pair: its approval covers what it sent.
    const older = await write({ ...BLANK_LIMITS, fatFinger: '50' }, '1', 'oi-2');
    expect(older).toMatchObject({ version: '2', fatFinger: '50', oiLimit: '1000', oiShareBps: '1000' });

    const cleared = await write({ ...BLANK_LIMITS, fatFinger: '50', oiLimit: null, oiShareBps: '1000' }, '2', 'oi-3');
    expect(cleared).toMatchObject({ version: '3', oiLimit: null, oiShareBps: '1000' });
    expect(readOpenInterestLimits(await currentRisk(db.sql, marketId))).toBeNull();
    expect(await admin.riskGet(operator(), marketId)).toMatchObject({ version: '3', oiLimit: null, oiShareBps: '1000' });
  });

  it('writes the dynamic price range, keeps it on a write that leaves it out, and the band record keeps each change (D-instruments-08)', async () => {
    const reason = 'publish the dynamic price range';
    const write = async (limits: Record<string, string | null>, expectedVersion: string, approvalId: string) => {
      allow({
        approvalId,
        actionType: 'trade.risk_set',
        operationId: `op-${approvalId}`,
        targetId: marketId,
        expectedVersion,
        body: { actionType: 'trade.risk_set', market: marketId, limits, expectedVersion, reason },
      });
      return admin.riskSet(operatorWriter(), {
        market: marketId,
        limits: limits as typeof BLANK_LIMITS,
        expectedVersion,
        reason,
        approvalId,
        operationId: `op-${approvalId}`,
      });
    };
    const range = { priceRangeMax: '0.2', priceRangeTrigger: '0.001', priceRangeCadenceSeconds: '30' };
    for (const bad of [
      { priceRangeMax: '0' },
      { priceRangeMax: '1' },
      { priceRangeMax: '-0.1' },
      { priceRangeTrigger: '1' },
      { priceRangeTrigger: 'x' },
      { priceRangeCadenceSeconds: '0' },
      { priceRangeCadenceSeconds: '86401' },
      { priceRangeCadenceSeconds: '1.5' },
    ]) {
      await expect(write({ ...BLANK_LIMITS, ...range, ...bad }, '0', 'range-bad')).rejects.toMatchObject({ code: 'risk_limit_not_exact' });
    }
    const first = await write({ ...BLANK_LIMITS, ...range }, '0', 'range-1');
    expect(first).toMatchObject({ version: '1', ...range });
    expect(readPriceRangeSettings(await currentRisk(db.sql, marketId))).toEqual({
      max: amt('0.2'),
      trigger: amt('0.001'),
      cadenceSeconds: 30,
    });
    // A write that sends only the first five keeps the range, as it keeps the open-interest pair.
    expect(await write({ ...BLANK_LIMITS, fatFinger: '50' }, '1', 'range-2')).toMatchObject({ version: '2', ...range });
    // One value cleared would leave a range that never widens anything: refused before the approval is used.
    await expect(write({ ...BLANK_LIMITS, priceRangeTrigger: null }, '2', 'range-3')).rejects.toMatchObject({
      code: 'risk_limit_not_exact',
    });
    const none = { priceRangeMax: null, priceRangeTrigger: null, priceRangeCadenceSeconds: null };
    const cleared = await write({ ...BLANK_LIMITS, ...none }, '2', 'range-4');
    expect(cleared).toMatchObject({ version: '3', ...none });
    expect(readPriceRangeSettings(await currentRisk(db.sql, marketId))).toBeNull();

    // The band record: the band in force is upserted on each working; a change of value is kept once.
    const store = sqlPriceBandStore(db.sql);
    const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, s));
    const working = { marketId, staticBand: amt('0.05'), premium: amt('0.01'), mark: amt('65000'), bookMid: amt('65650') };
    // Two hosts working the market at once, with no row yet: one change is kept, not two.
    const raced = await Promise.all([
      store.record({ ...working, band: amt('0.06'), reason: 'widened', riskVersion: '3', checkedAt: at(0) }),
      store.record({ ...working, band: amt('0.06'), reason: 'widened', riskVersion: '3', checkedAt: at(0) }),
    ]);
    expect(raced.map((r) => r.recorded).sort()).toEqual([false, true]);
    expect(await store.record({ ...working, band: amt('0.06'), reason: 'widened', riskVersion: '3', checkedAt: at(30) })).toEqual({
      recorded: true,
      changed: false,
    });
    // A working older than the one kept is dropped.
    expect(await store.record({ ...working, band: amt('0.09'), reason: 'widened', riskVersion: '3', checkedAt: at(20) })).toEqual({
      recorded: false,
      changed: false,
    });
    expect(await store.current(marketId)).toMatchObject({ band: amt('0.06'), checkedAt: at(30), changedAt: at(0), riskVersion: '3' });
    await store.record({ ...working, band: amt('0.05'), premium: amt('0'), reason: 'within_trigger', riskVersion: '3', checkedAt: at(60) });
    const changes = await store.changes(marketId, 10);
    expect(changes.map((c) => [c.band, c.previousBand, c.reason])).toEqual([
      [amt('0.05'), amt('0.06'), 'within_trigger'],
      [amt('0.06'), null, 'widened'],
    ]);
    // The operator reads the same, as decimal strings; an unworked market reads as nothing kept.
    expect(await admin.riskPriceBand(operator(), marketId)).toMatchObject({
      marketId,
      current: { band: '0.05', reason: 'within_trigger', riskVersion: '3', checkedAt: at(60).toISOString() },
      changes: [
        { band: '0.05', previousBand: '0.06' },
        { band: '0.06', previousBand: null },
      ],
    });
    expect(await admin.riskPriceBand(operator(), randomUUID())).toEqual({ marketId: expect.any(String), current: null, changes: [] });
  });

  it('reads the latest version as the newest one past version 9, not by its text', async () => {
    const reason = 'many versions';
    for (let v = 0; v < 11; v += 1) {
      const limits = { ...BLANK_LIMITS, fatFinger: String(100 + v) };
      const expectedVersion = String(v);
      allow({
        approvalId: `risk-many-${v}`,
        actionType: 'trade.risk_set',
        operationId: `op-risk-many-${v}`,
        targetId: marketId,
        expectedVersion,
        body: { actionType: 'trade.risk_set', market: marketId, limits, expectedVersion, reason },
      });
      await admin.riskSet(operatorWriter(), {
        market: marketId,
        limits,
        expectedVersion,
        reason,
        approvalId: `risk-many-${v}`,
        operationId: `op-risk-many-${v}`,
      });
    }
    expect(await admin.riskGet(operator(), marketId)).toMatchObject({ version: '11', fatFinger: '110' });
    expect((await currentRiskForMarkets(db.sql, [marketId])).get(marketId)).toMatchObject({ version: '11', fatFinger: '110' });
    expect((await admin.riskHistory(operator(), marketId)).map((row) => row.version)).toEqual(
      Array.from({ length: 11 }, (_, i) => String(i + 1)),
    );
  });

  it('refuses an order past a newly set fat-finger limit and accepts one inside it', async () => {
    const reason = 'cap the notional';
    const limits = { ...BLANK_LIMITS, fatFinger: '50' };
    allow({
      approvalId: 'risk-order',
      actionType: 'trade.risk_set',
      operationId: 'op-risk-order',
      targetId: marketId,
      expectedVersion: '0',
      body: { actionType: 'trade.risk_set', market: marketId, limits, expectedVersion: '0', reason },
    });
    await admin.riskSet(operatorWriter(), {
      market: marketId,
      limits,
      expectedVersion: '0',
      reason,
      approvalId: 'risk-order',
      operationId: 'op-risk-order',
    });
    await fund(ALICE, '1000');
    await expect(
      trade.placeOrder(principalFor(ALICE), {
        marketId,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'too-big',
      }),
    ).rejects.toMatchObject({ code: 'trade.operator_fat_finger' });
    const small = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('0.1'),
      price: amt('20'),
      clientOrderId: 'small-enough',
    });
    expect(small.status).toBe('open');
  });

  it('returns another account terminal order to an operator, writes one audit row, and pages the list', async () => {
    const filled = randomUUID();
    const cancelled0 = randomUUID();
    const cancelled1 = randomUUID();
    const cancelled2 = randomUUID();
    const cancelled = [cancelled0, cancelled1, cancelled2];
    await db.sql`INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset, hold_amount, fee_discount_bps, created_at
    ) VALUES
      (${filled}, ${BOB}, ${marketId}, 'filled-1', 'buy', 'limit', 10, 2, 2, 'filled', 'GTC', 'USDT', 20, 0, '2026-10-01T00:00:00Z'),
      (${cancelled0}, ${BOB}, ${marketId}, 'c0', 'buy', 'limit', 10, 1, 0, 'cancelled', 'GTC', 'USDT', 10, 0, '2026-10-02T00:00:00Z'),
      (${cancelled1}, ${ALICE}, ${marketId}, 'c1', 'buy', 'limit', 10, 1, 0, 'cancelled', 'GTC', 'USDT', 10, 0, '2026-10-03T00:00:00Z'),
      (${cancelled2}, ${ALICE}, ${otherMarketId}, 'c2', 'buy', 'limit', 10, 1, 0, 'cancelled', 'GTC', 'USDT', 10, 0, '2026-10-04T00:00:00Z')`;
    await db.sql`INSERT INTO trade.fills (
      id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
    ) VALUES (
      ${randomUUID()}, ${filled}, ${randomUUID()}, ${marketId}, ${BOB}, 'buy', 'taker', 10, 2, 20, 'USDT', 0, 0, 1
    )`;
    const before = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_audit`;
    const got = await admin.getOrder(operator(), filled);
    expect(got.order.user_id).toBe(BOB);
    expect(got.order.status).toBe('filled');
    expect(got.fills).toHaveLength(1);
    expect(got.order.holdReference.purpose).toBe(`order:${filled}`);
    const after = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_audit WHERE kind = 'orders.get'`;
    expect(Number(after[0]?.n) - Number(before[0]?.n ?? 0)).toBe(1);
    await expect(admin.getOrder(customer(), filled)).rejects.toBeInstanceOf(AuthError);
    const page1 = await admin.listOrders(operator(), { status: 'cancelled', limit: 2 });
    const page2 = await admin.listOrders(operator(), { status: 'cancelled', limit: 2, cursor: page1.nextCursor });
    const ids = [...page1.rows, ...page2.rows].map((row) => row.id).sort();
    expect(ids).toEqual([...cancelled].sort());
    expect(page2.nextCursor).toBeNull();
    await expect(admin.listOrders(customer(), { status: 'cancelled', limit: 2 })).rejects.toBeInstanceOf(AuthError);
  });

  it('lists positions for two accounts and returns a null insurance fund when the account does not exist', async () => {
    await db.sql`INSERT INTO trade.positions (
      id, user_id, market_id, side, status, size, entry_price, margin_initial, margin_current, margin_asset
    ) VALUES
      (${randomUUID()}, ${ALICE}, ${marketId}, 'long', 'open', 1, 10, 5, 5, 'USDT'),
      (${randomUUID()}, ${BOB}, ${marketId}, 'short', 'open', 2, 11, 5, 5, 'USDT')`;
    const listed = await admin.listPositions(operator(), { limit: 10 });
    expect(listed.rows.map((row) => row.userId).sort()).toEqual([ALICE, BOB].sort());
    await expect(admin.listPositions(customer(), { limit: 10 })).rejects.toBeInstanceOf(AuthError);
    const snap = await admin.futuresSnapshot(operator(), marketId);
    expect(snap.status).toBe('active');
    expect(snap.insuranceFund).toEqual({ value: null, reason: 'insurance_fund_unconfigured', asset: 'USDT' });
    expect(snap.clearingPot).toEqual({ value: '0', reason: null, asset: 'USDT', owed: '0', owedCount: 0 });
    expect(snap.leverageCap).toEqual({ value: null, reason: 'trade.leverage_cap_unset' });
    expect(snap.insuranceFund.value).not.toBe('0');
  });

  it('neutralises hostile export cells, refuses over the cap, and replays the same job', async () => {
    process.env.TRADE_OPERATOR_EXPORT_CAP = '10';
    process.env.TRADE_OPERATOR_EXPORT_SIGNING_KEY = 'test-export-key';
    await db.sql`INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, reject_code
    ) VALUES
      (${randomUUID()}, ${ALICE}, ${marketId}, 'e1', 'buy', 'limit', 10, 2, 'cancelled', 'GTC', 'USDT', 20, ${'=1+1'}),
      (${randomUUID()}, ${BOB}, ${marketId}, 'e2', 'buy', 'limit', 10, 3, 'cancelled', 'GTC', 'USDT', 30, ${'+cmd'})`;
    const created = await admin.createExport(operator(), { kind: 'orders', filters: { market: marketId }, clientRequestId: 'exp-1' });
    const file = await admin.downloadExport(operator(), created.downloadRef ?? '');
    expect(file.csv).toContain(`'=1+1`);
    expect(file.csv).toContain(`'+cmd`);
    expect(file.csv).not.toMatch(/(^|,)=1\+1/);
    const qty = file.csv
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(',')[2] ?? '0');
    expect(formatAmount(qty.reduce((sum, cell) => sum + amt(cell), 0n))).toBe('5');
    const [table] = await db.sql<
      Array<{ qty: string }>
    >`SELECT COALESCE(sum(qty), 0)::text AS qty FROM trade.orders WHERE market_id = ${marketId}`;
    expect(formatAmount(amt(table?.qty ?? '0'))).toBe('5');
    const replay = await admin.createExport(operator(), { kind: 'orders', filters: { market: marketId }, clientRequestId: 'exp-1' });
    expect(replay.id).toBe(created.id);
    await expect(admin.createExport(customer(), { kind: 'orders', filters: {}, clientRequestId: 'exp-c' })).rejects.toBeInstanceOf(
      AuthError,
    );
    process.env.TRADE_OPERATOR_EXPORT_CAP = '1';
    await expect(
      admin.createExport(operator(), { kind: 'orders', filters: { market: marketId }, clientRequestId: 'exp-over' }),
    ).rejects.toMatchObject({ code: 'export_over_cap' });
    delete process.env.TRADE_OPERATOR_EXPORT_CAP;
    await expect(admin.createExport(operator(), { kind: 'orders', filters: {}, clientRequestId: 'exp-blank' })).rejects.toMatchObject({
      code: 'export_cap_unset',
    });
  });

  it('feeds operator actions and refuses a customer or an edit', async () => {
    const reason = 'publish the ceiling';
    const limits = { ...BLANK_LIMITS, fatFinger: '10' };
    allow({
      approvalId: 'feed-risk',
      actionType: 'trade.risk_set',
      operationId: 'op-feed-risk',
      targetId: marketId,
      expectedVersion: '0',
      body: { actionType: 'trade.risk_set', market: marketId, limits, expectedVersion: '0', reason },
    });
    await admin.riskSet(operatorWriter(), {
      market: marketId,
      limits,
      expectedVersion: '0',
      reason,
      approvalId: 'feed-risk',
      operationId: 'op-feed-risk',
    });
    const scope = `market:${marketId}|account:`;
    const cancelReason = 'clear nothing';
    allow({
      approvalId: 'feed-cancel',
      actionType: 'trade.mass_cancel',
      targetId: scope,
      expectedVersion: '0',
      body: { actionType: 'trade.mass_cancel', scope, reason: cancelReason },
    });
    await admin.massCancel(operatorWriter(), {
      market: marketId,
      reason: cancelReason,
      approvalId: 'feed-cancel',
      clientRequestId: 'feed-cancel',
    });
    await trade.setMarketStatus(marketId, 'halted');
    await trade.setMarketStatus(marketId, 'active');
    const controls = new TradingControls(db.sql, { check: async () => 'enabled' }, null);
    const actor = {
      principal: { ...principalFor(OP, ['admin:read']), mfa: true },
      region: 'XX' as const,
      service: null,
      requestId: randomUUID(),
    };
    await controls.change(actor, {
      requestId: randomUUID(),
      target: { area: 'trading', userId: ALICE },
      action: 'restrict',
      reason: 'Operator investigation',
      expectedVersion: '0',
    });
    process.env.TRADE_OPERATOR_EXPORT_CAP = '10';
    process.env.TRADE_OPERATOR_EXPORT_SIGNING_KEY = 'test-export-key';
    await admin.createExport(operator(), { kind: 'orders', filters: { market: marketId }, clientRequestId: 'feed-export' });
    const orderId = randomUUID();
    await db.sql`INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount
    ) VALUES (
      ${orderId}, ${ALICE}, ${marketId}, 'feed-order', 'buy', 'limit', 10, 1, 'cancelled', 'GTC', 'USDT', 10
    )`;
    await admin.getOrder(operator(), orderId);
    const feed = await admin.auditFeed(operator(), { limit: 50 });
    const kinds = feed.rows.map((row) => row.kind);
    for (const kind of ['risk_limit.set', 'mass_cancel', 'market_status', 'restriction.apply', 'exports.create', 'orders.get']) {
      expect(kinds).toContain(kind);
    }
    const risk = feed.rows.find((row) => row.kind === 'risk_limit.set');
    expect(risk).toMatchObject({ operatorId: OP, approverId: APPROVER, reason });
    expect(risk?.occurredAt).toMatch(/^\d{4}-/);
    await expect(admin.auditFeed(customer(), { limit: 10 })).rejects.toBeInstanceOf(AuthError);
    await expect(db.sql`UPDATE trade.operator_audit SET reason = 'tamper'`).rejects.toThrow(/append-only/);
  });

  it('reports seeded totals and refuses the seed switch without approval', async () => {
    await db.sql`INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, seeded
    ) VALUES
      (${randomUUID()}, ${ALICE}, ${marketId}, 's1', 'buy', 'limit', 10, 1, 'open', 'GTC', 'USDT', 10, true),
      (${randomUUID()}, ${ALICE}, ${marketId}, 's2', 'sell', 'limit', 11, 2, 'open', 'GTC', 'BTC', 2, true),
      (${randomUUID()}, ${ALICE}, ${marketId}, 's3', 'buy', 'limit', 10, 9, 'open', 'GTC', 'USDT', 90, false)`;
    const seeded = await db.sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE seeded = true AND market_id = ${marketId} LIMIT 1`;
    await db.sql`INSERT INTO trade.fills (
      id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
    ) VALUES (
      ${randomUUID()}, ${seeded[0]!.id}, ${randomUUID()}, ${marketId}, ${ALICE}, 'buy', 'maker', 10, 0.4, 4, 'USDT', 0, 0, 7
    )`;
    const report = await admin.seedReport(operator(), { market: marketId });
    expect(report.orders).toBe('2');
    expect(report.orderQty).toBe('3');
    expect(report.fills).toBe('1');
    expect(report.fillQty).toBe('0.4');
    expect(report.enabled).toBe(false);
    await expect(
      admin.setSeed(operatorWriter(), { market: marketId, enabled: true, approvalId: 'nope', clientRequestId: 'seed-1' }),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    expect(await admin.seedEnabled(marketId)).toBe(false);
    const [versionRow] = await db.sql<Array<{ version: string | null }>>`
      SELECT version::text FROM trade.operator_mm_seed WHERE market_id = ${marketId} ORDER BY version DESC LIMIT 1`;
    const version = versionRow?.version ?? '0';
    allow({
      approvalId: 'seed-ok',
      actionType: 'trade.mm_seed',
      targetId: marketId,
      expectedVersion: version,
      body: { actionType: 'trade.mm_seed', market: marketId, enabled: true, expectedVersion: version },
    });
    const set = await admin.setSeed(operatorWriter(), {
      market: marketId,
      enabled: true,
      approvalId: 'seed-ok',
      clientRequestId: 'seed-2',
    });
    expect(set.enabled).toBe(true);
    expect(await admin.seedEnabled(marketId)).toBe(true);
  });

  it('reports a drifted order repair, refuses a sweep while the flag is off, and has no sweep status yet', async () => {
    expect(await admin.reconcileStatus(operator())).toEqual({ lastSweepAt: null, result: null });
    await fund(ALICE, '1000');
    const order = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('2'),
      price: amt('100'),
      clientOrderId: 'drift',
    });
    matching.scriptCancelMiss(order.id);
    const verdict = await admin.reconcile(operatorWriter(), { orderId: order.id, clientRequestId: 'recon-1' });
    expect(verdict.case).toBe('open_hold_no_engine');
    expect(verdict.action).toBe('released');
    expect(await held(ALICE, order.id)).toBe('0');
    const replay = await admin.reconcile(operatorWriter(), { orderId: order.id, clientRequestId: 'recon-1' });
    expect(replay).toEqual(verdict);
    await expect(admin.startReconcileSweep(operatorWriter(), { clientRequestId: 'sweep-1' })).rejects.toMatchObject({
      code: 'reconcile_jobs_disabled',
    });
    expect(process.env.TRADE_RECONCILE_JOBS_ENABLED ?? '').not.toBe('true');
    expect(await admin.reconcileStatus(operator())).toEqual({ lastSweepAt: null, result: null });
    await expect(admin.reconcile(customer(), { orderId: order.id, clientRequestId: 'recon-c' })).rejects.toBeInstanceOf(AuthError);
  });

  it('records halt then resume in order and refuses an edit', async () => {
    await trade.setMarketStatus(marketId, 'halted');
    await trade.setMarketStatus(marketId, 'active');
    const page = await admin.statusHistory(operator(), { market: marketId, limit: 10 });
    expect(page.unknownBefore).toBe('history_starts_at');
    expect(page.rows.map((row) => `${row.fromStatus}->${row.toStatus}`)).toEqual(['active->halted', 'halted->active']);
    expect(page.rows[0]?.occurredAt).toBe(page.historyStartsAt);
    await expect(db.sql`UPDATE trade.market_status_transitions SET reason = 'tamper'`).rejects.toThrow(/append-only/);
    await expect(admin.statusHistory(customer(), { market: marketId, limit: 10 })).rejects.toBeInstanceOf(AuthError);
  });

  it('requires a trading.restrict approval only when the identity flag is on', async () => {
    const controls = new TradingControls(db.sql, { check: async () => 'enabled' }, null);
    const actor = {
      principal: { ...principalFor(OP, ['admin:read']), mfa: true },
      region: 'XX' as const,
      service: null,
      requestId: randomUUID(),
    };
    const command = (requestId: string, version = '0') => ({
      requestId,
      target: { area: 'trading' as const, userId: ALICE },
      action: 'restrict' as const,
      reason: 'Operator investigation',
      expectedVersion: version,
    });
    expect(await controls.change(actor, command(randomUUID()))).toMatchObject({ outcome: 'changed', after: { restricted: true } });
    await controls.change(actor, { ...command(randomUUID(), '1'), action: 'restore' });
    process.env.IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL = 'true';
    const local = new MemoryApprovalBook();
    bindTradingRestrictApprovals(local);
    const refused = await controls.change(actor, command(randomUUID(), '2'));
    expect(refused).toMatchObject({ outcome: 'refused', code: 'restriction_no_four_eyes' });
    const [state] = await db.sql<Array<{ version: string; restricted: boolean }>>`
      SELECT version::text, restricted FROM trade.account_restrictions WHERE user_id = ${ALICE}`;
    expect(state).toMatchObject({ version: '2', restricted: false });
    const body = {
      actionType: 'trading.restrict',
      userId: ALICE,
      action: 'restrict',
      reason: 'Operator investigation',
      expectedVersion: '2',
    };
    local.put({
      approvalId: 'restrict-1',
      actionType: 'trading.restrict',
      targetService: 'svc-trade',
      targetId: ALICE,
      expectedVersion: '2',
      payloadHash: payloadHash(body),
      requesterId: OP,
      approverId: APPROVER,
    });
    expect(await controls.change(actor, command(randomUUID(), '2'), 'restrict-1')).toMatchObject({
      outcome: 'changed',
      after: { restricted: true, version: '3' },
    });
  });

  it('refuses operator writes that hold only admin:read and changes nothing', async () => {
    await fund(ALICE, '1000');
    const order = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('10'),
      clientOrderId: 'read-only-hold',
    });
    expect(await held(ALICE, order.id)).toBe('10');
    const reader = operator();
    await expect(
      admin.massCancel(reader, { market: marketId, reason: 'read only', approvalId: 'x', clientRequestId: 'ro-cancel' }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      admin.riskSet(reader, {
        market: marketId,
        limits: { ...BLANK_LIMITS, fatFinger: '1' },
        expectedVersion: '0',
        reason: 'read only',
        approvalId: 'x',
        operationId: 'op-x',
      }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      admin.setSeed(reader, { market: marketId, enabled: true, approvalId: 'x', clientRequestId: 'ro-seed' }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(admin.reconcile(reader, { orderId: order.id, clientRequestId: 'ro-recon' })).rejects.toBeInstanceOf(AuthError);
    await expect(admin.startReconcileSweep(reader, { clientRequestId: 'ro-sweep' })).rejects.toBeInstanceOf(AuthError);
    expect((await trade.findOrder(order.id))?.status).toBe('open');
    expect(await held(ALICE, order.id)).toBe('10');
    const [risk] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_risk_limits`;
    const [seed] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_mm_seed`;
    const [requests] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_requests`;
    expect(risk?.n).toBe('0');
    expect(seed?.n).toBe('0');
    expect(requests?.n).toBe('0');
  });

  it('router refuses risk.set on admin:read and serves risk.get', async () => {
    const caller = tradeOpsAdminRouter(admin).createCaller({
      principal: principalFor(OP, ['admin:read']),
      region: 'XX',
      service: null,
      requestId: randomUUID(),
    });
    await expect(
      caller.risk.set({
        market: marketId,
        limits: BLANK_LIMITS,
        expectedVersion: '0',
        reason: 'read only set',
        approvalId: 'router-risk',
        operationId: 'op-router-risk',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [risk] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_risk_limits`;
    expect(risk?.n).toBe('0');
    await expect(caller.risk.get({ market: marketId })).resolves.toMatchObject({
      marketId,
      version: '0',
      fatFinger: null,
      collar: null,
    });
  });

  it('refuses reconcile of a pending order still inside the hold in-flight bound', async () => {
    const orderId = randomUUID();
    await db.sql`INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, updated_at
    ) VALUES (
      ${orderId}, ${ALICE}, ${marketId}, 'inflight', 'buy', 'limit', 10, 1, 'pending', 'GTC', 'USDT', 10, now()
    )`;
    await expect(admin.reconcile(operatorWriter(), { orderId, clientRequestId: 'inflight-1' })).rejects.toMatchObject({
      code: 'reconcile_order_in_flight',
      message: expect.stringMatching(/\d+s left/),
    });
    const [still] = await db.sql<Array<{ status: string }>>`SELECT status::text FROM trade.orders WHERE id = ${orderId}`;
    expect(still?.status).toBe('pending');
    const [requests] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_requests`;
    const [refused] = await db.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM trade.operator_audit WHERE kind = 'orders.reconcile_refused'`;
    expect(requests?.n).toBe('0');
    expect(refused?.n).toBe('1');
    await db.sql`UPDATE trade.orders SET updated_at = now() - interval '8 minutes' WHERE id = ${orderId}`;
    const verdict = await admin.reconcile(operatorWriter(), { orderId, clientRequestId: 'inflight-1' });
    expect(verdict.case).toBe('orphan_pending');
  });

  it('returns an export download reference and never the csv', async () => {
    process.env.TRADE_OPERATOR_EXPORT_CAP = '10';
    process.env.TRADE_OPERATOR_EXPORT_SIGNING_KEY = 'test-export-key';
    await db.sql`INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount
    ) VALUES (
      ${randomUUID()}, ${ALICE}, ${marketId}, 'csv-1', 'buy', 'limit', 10, 1, 'cancelled', 'GTC', 'USDT', 10
    )`;
    const created = await admin.createExport(operator(), { kind: 'orders', filters: { market: marketId }, clientRequestId: 'exp-get' });
    const before = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_audit WHERE kind = 'exports.get'`;
    const got = await admin.getExport(operator(), created.id);
    expect(got).not.toHaveProperty('csv');
    expect(got.downloadRef).toEqual(expect.any(String));
    expect(got.refusal).toBeNull();
    expect(got).toMatchObject({ id: created.id, kind: 'orders', rowCount: 1 });
    expect(got.createdAt).toMatch(/^\d{4}-/);
    const file = await admin.downloadExport(operator(), got.downloadRef ?? '');
    expect(file.csv.length).toBeGreaterThan(0);
    const after = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_audit WHERE kind = 'exports.get'`;
    expect(Number(after[0]?.n) - Number(before[0]?.n ?? 0)).toBe(1);
    delete process.env.TRADE_OPERATOR_EXPORT_SIGNING_KEY;
    const unsigned = await admin.getExport(operator(), created.id);
    expect(unsigned).not.toHaveProperty('csv');
    expect(unsigned.downloadRef).toBeNull();
    expect(unsigned.refusal).toBe('export_signing_key_unset');
  });
});
