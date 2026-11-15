/**
 * TRADEOPSBE acceptance. Real Postgres via TEST_DATABASE_URL. No Docker here.
 * Identity restriction history is not in this feed; that stays in svc-identity.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { BUST_ACTION_TYPE, bustApprovalBody } from './bust.js';
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

  it('writes the seeding configuration as a versioned two-person write; blanks refuse by name; a retry is the same write (J-cex-spot-20 #5)', async () => {
    const full = {
      enabled: true,
      halfSpreadBps: '500',
      stepBps: '50',
      levels: '3',
      qtyPerLevel: '10',
      midSource: 'configured' as const,
      configuredMid: '1',
    };
    const before = await admin.seedConfig.currentVersion(otherMarketId);
    // A blank step refuses before any approval is looked at.
    await expect(
      admin.seedConfig.set(operatorWriter(), {
        market: otherMarketId,
        config: { ...full, stepBps: null },
        expectedVersion: before,
        approvalId: 'none',
        clientRequestId: 'seedcfg-0',
      }),
    ).rejects.toMatchObject({ code: 'mm.seed_unset', message: expect.stringContaining('step') });
    // No approval: refused, nothing written.
    await expect(
      admin.seedConfig.set(operatorWriter(), {
        market: otherMarketId,
        config: full,
        expectedVersion: before,
        approvalId: 'nope',
        clientRequestId: 'seedcfg-1',
      }),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    expect(await admin.seedConfig.currentVersion(otherMarketId)).toBe(before);
    // An approval for other values does not write these.
    allow({
      approvalId: 'seedcfg-other',
      actionType: 'trade.mm_seed',
      targetId: otherMarketId,
      expectedVersion: before,
      body: { actionType: 'trade.mm_seed', market: otherMarketId, expectedVersion: before, config: { ...full, levels: '4' } },
    });
    await expect(
      admin.seedConfig.set(operatorWriter(), {
        market: otherMarketId,
        config: full,
        expectedVersion: before,
        approvalId: 'seedcfg-other',
        clientRequestId: 'seedcfg-2',
      }),
    ).rejects.toBeTruthy();
    expect(await admin.seedConfig.currentVersion(otherMarketId)).toBe(before);

    allow({
      approvalId: 'seedcfg-ok',
      actionType: 'trade.mm_seed',
      targetId: otherMarketId,
      expectedVersion: before,
      body: { actionType: 'trade.mm_seed', market: otherMarketId, expectedVersion: before, config: full },
    });
    const written = await admin.seedConfig.set(operatorWriter(), {
      market: otherMarketId,
      config: full,
      expectedVersion: before,
      approvalId: 'seedcfg-ok',
      clientRequestId: 'seedcfg-3',
    });
    expect(written).toMatchObject({
      ...full,
      market: otherMarketId,
      version: String(Number(before) + 1),
      approvalId: 'seedcfg-ok',
      approverId: APPROVER,
    });
    // The same request again answers the same write, and no second version appears.
    const again = await admin.seedConfig.set(operatorWriter(), {
      market: otherMarketId,
      config: full,
      expectedVersion: before,
      approvalId: 'seedcfg-ok',
      clientRequestId: 'seedcfg-3',
    });
    expect(again).toEqual(written);
    expect(await admin.seedConfig.currentVersion(otherMarketId)).toBe(written.version);
    const listed = (await admin.seedConfig.list(operator())).configs.find((c) => c.market === otherMarketId);
    expect(listed).toMatchObject({ ...full, version: written.version });
    // A proposal bound to the version before is stale once this one is written.
    await expect(
      admin.seedConfig.set(operatorWriter(), {
        market: otherMarketId,
        config: full,
        expectedVersion: before,
        approvalId: 'seedcfg-ok',
        clientRequestId: 'seedcfg-4',
      }),
    ).rejects.toMatchObject({ code: 'mm.seed_stale' });
    // The job reads it complete; a reader without write scope cannot write.
    const { operatorSeedTargets } = await import('./seed-config.js');
    const target = (await operatorSeedTargets(db.sql)).find((t) => t.marketId === otherMarketId);
    expect(target).toMatchObject({ enabled: true, config: { ok: true, levels: 3, stepBps: 50, qtyPerLevel: '10', configuredMid: '1' } });
    await expect(
      admin.seedConfig.set(operator(), {
        market: otherMarketId,
        config: full,
        expectedVersion: written.version,
        approvalId: 'x',
        clientRequestId: 'seedcfg-5',
      }),
    ).rejects.toBeInstanceOf(AuthError);
    // The older on/off switch turns the seed off and keeps every value the operator wrote.
    allow({
      approvalId: 'seedcfg-switch',
      actionType: 'trade.mm_seed',
      targetId: otherMarketId,
      expectedVersion: written.version,
      body: { actionType: 'trade.mm_seed', market: otherMarketId, enabled: false, expectedVersion: written.version },
    });
    await admin.setSeed(operatorWriter(), {
      market: otherMarketId,
      enabled: false,
      approvalId: 'seedcfg-switch',
      clientRequestId: 'seedcfg-6',
    });
    const switched = (await admin.seedConfig.list(operator())).configs.find((c) => c.market === otherMarketId);
    expect(switched).toMatchObject({ ...full, enabled: false, version: String(Number(written.version) + 1) });
  });

  it('reports a drifted order repair, refuses a sweep while its switch is off, and has no sweep status yet', async () => {
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
    // The sweep's switch is off by default: it refuses and looks at nothing.
    await expect(admin.startReconcileSweep(operatorWriter(), { clientRequestId: 'sweep-1', reason: 'TEST sweep' })).rejects.toMatchObject({
      code: 'reconcile_sweep_disabled',
    });
    expect(process.env.TRADE_RECONCILE_JOBS_ENABLED ?? '').not.toBe('true');
    expect(await admin.reconcileStatus(operator())).toEqual({ lastSweepAt: null, result: null });
    await expect(admin.reconcile(customer(), { orderId: order.id, clientRequestId: 'recon-c' })).rejects.toBeInstanceOf(AuthError);
  });

  describe('operator reconcile sweep (J-cex-spot-18 #3)', () => {
    let lists: string[] = [];
    function sweeper(
      values: {
        limit?: number | null;
        minAge?: number | null;
        enabled?: boolean;
        reconcile?: (orderId: string, opts?: { leaveLive?: boolean }) => Promise<import('../spot/types.js').ReconcileResult>;
      } = {},
    ): TradeOpsAdmin {
      return new TradeOpsAdmin({
        sql: db.sql,
        approvals: book,
        ledger,
        reconcileOrder: values.reconcile ?? ((orderId, opts) => trade.reconcileOrder(orderId, opts)),
        engineLiveOrderIds: async (market) => {
          lists.push(market);
          return trade.engineLiveOrderIds(market);
        },
        cancelOrder: async (orderId, userId) => {
          await trade.cancelOrder(principalFor(userId), orderId);
        },
        sweepEnabled: values.enabled ?? true,
        sweepLimit: values.limit === undefined ? 100 : values.limit,
        sweepMinAgeSeconds: values.minAge === undefined ? 60 : values.minAge,
      });
    }
    beforeEach(() => {
      lists = [];
    });
    const restingBuy = (clientOrderId: string, price = '100') =>
      trade.placeOrder(principalFor(ALICE), { marketId, side: 'buy', type: 'limit', qty: amt('1'), price: amt(price), clientOrderId });
    const age = (orderId: string) => db.sql`UPDATE trade.orders SET updated_at = now() - interval '10 minutes' WHERE id = ${orderId}`;
    /** The first sighting of an engine miss, moved back past the floor: the next sweep is its second look. */
    const ageSighting = (orderId: string) =>
      db.sql`UPDATE trade.operator_sweep_sightings SET first_seen_at = now() - interval '10 minutes' WHERE order_id = ${orderId}`;
    const available = async () => formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
    const sweep = (admin2: TradeOpsAdmin, clientRequestId: string, reason = 'TEST sweep') =>
      admin2.startReconcileSweep(operatorWriter(), { clientRequestId, reason });

    it('releases an orphan hold only on a second sighting a floor after the first, once, and leaves the live order alone', async () => {
      await fund(ALICE, '1000');
      const live = await restingBuy('sweep-live');
      const orphan = await restingBuy('sweep-orphan', '90');
      await age(live.id);
      await age(orphan.id);
      // The book no longer has the orphan; the trade service still holds its funds.
      matching.scriptCancelMiss(orphan.id);
      const availableBefore = await available();
      const liveHold = await held(ALICE, live.id);
      const orphanHold = await held(ALICE, orphan.id);
      expect(amt(orphanHold) > 0n).toBe(true);

      // First look: an empty book and an empty trade.fills are not proof yet. Nothing is released.
      const first = await sweep(sweeper(), 'sweep-a');
      expect(first).toMatchObject({ checked: 2, released: 0, firstSightedOrderIds: [orphan.id] });
      expect(await held(ALICE, orphan.id)).toBe(orphanHold);
      // A look again inside the floor still waits.
      expect(await sweep(sweeper(), 'sweep-a2')).toMatchObject({ released: 0, waitingOrderIds: [orphan.id] });

      await ageSighting(orphan.id);
      const second = await sweep(sweeper(), 'sweep-b');
      expect(second).toMatchObject({ checked: 2, released: 1, releasedOrderIds: [orphan.id], failedClosedOrderIds: [] });
      expect(await held(ALICE, orphan.id)).toBe('0');
      expect(amt(await available()) - amt(availableBefore)).toBe(amt(orphanHold));
      expect(await held(ALICE, live.id)).toBe(liveHold);
      const [liveRow] = await db.sql<Array<{ status: string }>>`SELECT status::text FROM trade.orders WHERE id = ${live.id}`;
      expect(liveRow!.status).toBe('open');

      const third = await sweep(sweeper(), 'sweep-c');
      expect(third).toMatchObject({ released: 0, releasedOrderIds: [] });
      expect(amt(await available()) - amt(availableBefore)).toBe(amt(orphanHold));

      // The same request again is the same run: its counts, and nothing runs.
      expect(await sweep(sweeper(), 'sweep-b')).toEqual(second);
      const runs = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_reconcile_sweeps`;
      expect(runs[0]!.n).toBe('4');
      const audit = await db.sql<Array<{ kind: string; object_id: string }>>`
        SELECT kind, object_id FROM trade.operator_audit WHERE kind IN ('orders.reconcile', 'orders.reconcile_sweep') ORDER BY occurred_at, kind`;
      expect(audit.filter((row) => row.kind === 'orders.reconcile').map((row) => row.object_id)).toEqual([orphan.id]);
      expect(audit.filter((row) => row.kind === 'orders.reconcile_sweep').map((row) => row.object_id)).toEqual([
        'sweep-a',
        'sweep-a2',
        'sweep-b',
        'sweep-c',
      ]);
      expect((await admin.reconcileStatus(operator())).lastSweepAt).not.toBeNull();
    });

    it('keeps the hold of a long-resting order whose fill reached trade.fills after the first look (an unrecorded fill)', async () => {
      await fund(ALICE, '1000');
      const filled = await restingBuy('sweep-late-fill', '95');
      await age(filled.id);
      const hold = await held(ALICE, filled.id);
      // The engine filled it and dropped it from the book; its fill is still on the bus.
      matching.scriptCancelMiss(filled.id);
      const first = await sweep(sweeper(), 'sweep-late-1');
      expect(first).toMatchObject({ released: 0, firstSightedOrderIds: [filled.id] });
      expect(await held(ALICE, filled.id)).toBe(hold);
      // The fill lands.
      await db.sql`INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${randomUUID()}, ${filled.id}, ${randomUUID()}, ${marketId}, ${ALICE}, 'buy', 'maker', 95, 1, 95, 'USDT', 0, 0, 3
      )`;
      await ageSighting(filled.id);
      const second = await sweep(sweeper(), 'sweep-late-2');
      expect(second).toMatchObject({ released: 0, failedClosedOrderIds: [filled.id] });
      expect(await held(ALICE, filled.id)).toBe(hold);
    });

    it('runs one sweep for a request id however often it is sent at once, and refuses the id with another reason', async () => {
      await fund(ALICE, '1000');
      const orphan = await restingBuy('sweep-race', '90');
      await age(orphan.id);
      matching.scriptCancelMiss(orphan.id);
      const slow = sweeper({
        reconcile: async (orderId, opts) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return trade.reconcileOrder(orderId, opts);
        },
      });
      await sweep(slow, 'sweep-race-0');
      await ageSighting(orphan.id);
      const [a, b] = await Promise.allSettled([sweep(slow, 'sweep-race-1'), sweep(slow, 'sweep-race-1')]);
      const answers = [a, b].filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<unknown>).value);
      const refusals = [a, b].filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.code);
      expect(answers.length + refusals.length).toBe(2);
      expect(refusals.every((code) => code === 'reconcile_sweep_in_flight')).toBe(true);
      expect(answers[0]).toMatchObject({ released: 1, releasedOrderIds: [orphan.id] });
      const rows = await db.sql`SELECT 1 FROM trade.operator_reconcile_sweeps WHERE client_request_id = 'sweep-race-1'`;
      expect(rows).toHaveLength(1);
      expect(await db.sql`SELECT 1 FROM trade.operator_audit WHERE kind = 'orders.reconcile' AND object_id = ${orphan.id}`).toHaveLength(1);
      // Asked again after it ended: the stored answer.
      expect(await sweep(slow, 'sweep-race-1')).toMatchObject({ released: 1, releasedOrderIds: [orphan.id] });
      await expect(sweep(slow, 'sweep-race-1', 'TEST another reason')).rejects.toMatchObject({ code: 'client_request_conflict' });
    });

    it('reports an error thrown after the reconcile acted apart from one that did nothing, and a no-hold terminal as what it did', async () => {
      await fund(ALICE, '1000');
      const acted = await restingBuy('sweep-acted', '90');
      const untouched = await restingBuy('sweep-untouched', '91');
      const noHold = await restingBuy('sweep-nohold', '92');
      for (const o of [acted, untouched, noHold]) {
        await age(o.id);
        matching.scriptCancelMiss(o.id);
      }
      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
      const odd = sweeper({
        reconcile: async (orderId, opts) => {
          if (orderId === acted.id) {
            await trade.reconcileOrder(orderId, opts);
            throw new Error('TEST audit write failed after finalize');
          }
          if (orderId === untouched.id) throw new Error('TEST ledger unreachable');
          return {
            orderId,
            case: 'open_engine_no_hold',
            action: 'fail_closed',
            holdBefore: '0',
            engineLive: false,
            detail: 'TEST terminalized with no hold',
          };
        },
      });
      await sweep(odd, 'sweep-odd-0');
      for (const o of [acted, untouched, noHold]) await ageSighting(o.id);
      const result = await sweep(odd, 'sweep-odd-1');
      spy.mockRestore();
      expect(result.erroredAfterActingOrderIds).toEqual([acted.id]);
      expect(result.unreadableOrderIds).toEqual([untouched.id]);
      expect(result.terminalizedNoHoldOrderIds).toEqual([noHold.id]);
      expect(result.failedClosedOrderIds).toEqual([]);
      expect(errors.some((line) => line.includes('errored_after_acting') && line.includes(acted.id))).toBe(true);
      expect(errors.some((line) => line.includes('not_read') && line.includes(untouched.id))).toBe(true);
    });

    it('starts the wait again when the book lists the order between two misses (CI review run 42229413718, finding 1)', async () => {
      await fund(ALICE, '1000');
      const order = await restingBuy('sweep-flicker', '90');
      await age(order.id);
      const hold = await held(ALICE, order.id);
      // A transient miss (an engine restart, a list taken mid-replay): first sighted, and the floor passes.
      matching.scriptCancelMiss(order.id);
      expect(await sweep(sweeper(), 'sweep-flicker-1')).toMatchObject({ firstSightedOrderIds: [order.id] });
      await ageSighting(order.id);
      // The book lists it again: the miss was not continuous, and the sighting goes.
      matching.scriptLive(order.id, marketId);
      expect(await sweep(sweeper(), 'sweep-flicker-2')).toMatchObject({ released: 0, firstSightedOrderIds: [], waitingOrderIds: [] });
      expect(await db.sql`SELECT 1 FROM trade.operator_sweep_sightings WHERE order_id = ${order.id}`).toHaveLength(0);
      // Then it really leaves the book (its fill may still be on the bus): a first sighting again, nothing released.
      matching.scriptCancelMiss(order.id);
      expect(await sweep(sweeper(), 'sweep-flicker-3')).toMatchObject({ released: 0, firstSightedOrderIds: [order.id] });
      expect(await held(ALICE, order.id)).toBe(hold);
    });

    it('drops the sighting when the reconcile’s own list finds the order live', async () => {
      await fund(ALICE, '1000');
      const order = await restingBuy('sweep-left-live', '90');
      await age(order.id);
      matching.scriptCancelMiss(order.id);
      await sweep(sweeper(), 'sweep-left-1');
      await ageSighting(order.id);
      const leftLive = sweeper({
        reconcile: async (orderId) => ({
          orderId,
          case: 'open_engine_live_left',
          action: 'none',
          holdBefore: '90',
          engineLive: true,
          detail: 'TEST listed again by the reconcile',
        }),
      });
      expect(await sweep(leftLive, 'sweep-left-2')).toMatchObject({ released: 0 });
      expect(await db.sql`SELECT 1 FROM trade.operator_sweep_sightings WHERE order_id = ${order.id}`).toHaveLength(0);
    });

    it('counts a market whose book list is a full page as not read, and records no sighting there (finding 2)', async () => {
      await fund(ALICE, '1000');
      const order = await restingBuy('sweep-full-page', '90');
      await age(order.id);
      const full = Array.from({ length: 500 }, (_, i) => ({
        marketId,
        orderId: randomUUID(),
        accountId: '',
        kind: 'book' as const,
        side: 'buy' as const,
        price: '1',
        remaining: '1',
        sequence: i + 1,
        version: 1,
      }));
      const spy = vi.spyOn(matching, 'listOrders').mockResolvedValue({ marketId, orders: full });
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await sweep(sweeper(), 'sweep-full');
      spy.mockRestore();
      quiet.mockRestore();
      expect(result).toMatchObject({ checked: 1, released: 0, unreadableOrderIds: [order.id], firstSightedOrderIds: [] });
      expect(await db.sql`SELECT 1 FROM trade.operator_sweep_sightings WHERE order_id = ${order.id}`).toHaveLength(0);
    });

    it('does not look at an order changed within the floor, even when the book no longer lists it (finding 3)', async () => {
      await fund(ALICE, '1000');
      const fresh = await restingBuy('sweep-fresh', '90');
      const hold = await held(ALICE, fresh.id);
      matching.scriptCancelMiss(fresh.id);
      expect(await sweep(sweeper(), 'sweep-fresh-1')).toMatchObject({ checked: 0, firstSightedOrderIds: [] });
      expect(await db.sql`SELECT 1 FROM trade.operator_sweep_sightings WHERE order_id = ${fresh.id}`).toHaveLength(0);
      expect(await held(ALICE, fresh.id)).toBe(hold);
    });

    it('lists each market’s book once per sweep, not once per order', async () => {
      await fund(ALICE, '1000');
      for (const id of ['sweep-one-1', 'sweep-one-2', 'sweep-one-3']) await age((await restingBuy(id, '80')).id);
      const result = await sweep(sweeper(), 'sweep-one');
      expect(result.checked).toBe(3);
      expect(lists).toEqual([marketId]);
    });

    it('refuses while switched off, with each owner value blank, and for a reader, and records nothing', async () => {
      await expect(sweep(sweeper({ enabled: false }), 'sweep-off')).rejects.toMatchObject({ code: 'reconcile_sweep_disabled' });
      for (const values of [{ limit: null }, { minAge: null }]) {
        await expect(sweep(sweeper(values), 'sweep-u')).rejects.toMatchObject({ code: 'reconcile_sweep_unconfigured' });
      }
      await expect(sweeper().startReconcileSweep(operator(), { clientRequestId: 'sweep-r', reason: 'TEST sweep' })).rejects.toBeInstanceOf(
        AuthError,
      );
      const runs = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.operator_reconcile_sweeps`;
      expect(runs[0]!.n).toBe('0');
    });
  });

  describe('trade bust (J-cex-spot-18 #4)', () => {
    async function filledOrder(): Promise<string> {
      await fund(ALICE, '1000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bust-me',
      });
      await db.sql`INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${randomUUID()}, ${order.id}, ${randomUUID()}, ${marketId}, ${ALICE}, 'buy', 'taker', 100, 0.5, 50, 'USDT', 0, 0, 5
      )`;
      return order.id;
    }
    const reason = 'TEST customer reported a wrong fill';

    it('with a second operator approval, refuses trade_bust_recipe_missing, moves nothing and audits both operators once', async () => {
      const orderId = await filledOrder();
      const holdBefore = await held(ALICE, orderId);
      const fillsBefore = await db.sql<Array<{ id: string }>>`SELECT id FROM trade.fills WHERE order_id = ${orderId}`;
      allow({
        approvalId: 'bust-1',
        actionType: BUST_ACTION_TYPE,
        targetId: orderId,
        expectedVersion: '1',
        body: bustApprovalBody({ orderId, expectedVersion: '1', reason }),
        operationId: 'bust-req-1',
      });
      await expect(
        admin.bust(operatorWriter(), { orderId, approvalId: 'bust-1', clientRequestId: 'bust-req-1', reason }),
      ).rejects.toMatchObject({ code: 'trade_bust_recipe_missing' });
      expect(await held(ALICE, orderId)).toBe(holdBefore);
      expect(await db.sql`SELECT id FROM trade.fills WHERE order_id = ${orderId}`).toEqual(fillsBefore);
      const audit = await db.sql<Array<{ operator_id: string; approver_id: string; account_id: string }>>`
        SELECT operator_id::text, approver_id::text, account_id::text FROM trade.operator_audit WHERE kind = 'orders.bust_refused'`;
      expect(audit).toEqual([{ operator_id: OP, approver_id: APPROVER, account_id: ALICE }]);
      const [detail] = await db.sql<Array<{ detail: { requesterId: string; code: string } }>>`
        SELECT detail FROM trade.operator_audit WHERE kind = 'orders.bust_refused'`;
      expect(detail!.detail).toMatchObject({ requesterId: OP, code: 'trade_bust_recipe_missing' });
      // The approval is spent: the same request again is refused as reused, and writes no second row.
      await expect(
        admin.bust(operatorWriter(), { orderId, approvalId: 'bust-1', clientRequestId: 'bust-req-1', reason }),
      ).rejects.toMatchObject({ code: 'approval_reused' });
      expect(await db.sql`SELECT 1 FROM trade.operator_audit WHERE kind = 'orders.bust_refused'`).toHaveLength(1);
    });

    it('refuses when the operator carrying it out is the one who approved it, and records the proposer', async () => {
      const orderId = await filledOrder();
      book.put({
        approvalId: 'bust-self',
        actionType: BUST_ACTION_TYPE,
        targetService: 'svc-trade',
        targetId: orderId,
        expectedVersion: '1',
        payloadHash: payloadHash(bustApprovalBody({ orderId, expectedVersion: '1', reason })),
        requesterId: BOB,
        approverId: OP,
      });
      await expect(
        admin.bust(operatorWriter(), { orderId, approvalId: 'bust-self', clientRequestId: 'bust-self-1', reason }),
      ).rejects.toMatchObject({ code: 'approval_executor_is_approver' });
      const [row] = await db.sql<Array<{ approver_id: string; detail: { requesterId: string; code: string } }>>`
        SELECT approver_id::text, detail FROM trade.operator_audit WHERE kind = 'orders.bust_refused'`;
      expect(row).toMatchObject({ approver_id: OP, detail: { requesterId: BOB, code: 'approval_executor_is_approver' } });
    });

    it('refuses with no approval, with an approval for another reason, for an order with no fill, and for a reader', async () => {
      // Placed before the fill below is recorded, so the stub book's sequence stays ahead of trade.fills.
      await fund(ALICE, '1000');
      const unfilled = await trade.placeOrder(principalFor(ALICE), {
        marketId,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('90'),
        clientOrderId: 'bust-unfilled',
      });
      const orderId = await filledOrder();
      await expect(
        admin.bust(operatorWriter(), { orderId, approvalId: 'none', clientRequestId: 'bust-req-2', reason }),
      ).rejects.toMatchObject({ code: 'approval_missing' });
      allow({
        approvalId: 'bust-other',
        actionType: BUST_ACTION_TYPE,
        targetId: orderId,
        expectedVersion: '1',
        body: bustApprovalBody({ orderId, expectedVersion: '1', reason: 'TEST a different reason' }),
      });
      await expect(
        admin.bust(operatorWriter(), { orderId, approvalId: 'bust-other', clientRequestId: 'bust-req-3', reason }),
      ).rejects.toMatchObject({ code: 'approval_mismatch' });
      await expect(
        admin.bust(operatorWriter(), { orderId: unfilled.id, approvalId: 'x', clientRequestId: 'bust-req-4', reason }),
      ).rejects.toMatchObject({ code: 'trade_bust_no_fill' });
      await expect(admin.bust(operator(), { orderId, approvalId: 'x', clientRequestId: 'bust-req-5', reason })).rejects.toBeInstanceOf(
        AuthError,
      );
      expect(await db.sql`SELECT 1 FROM trade.operator_audit WHERE kind = 'orders.bust_refused'`).toHaveLength(0);
    });
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
    await expect(admin.startReconcileSweep(reader, { clientRequestId: 'ro-sweep', reason: 'TEST sweep' })).rejects.toBeInstanceOf(
      AuthError,
    );
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
