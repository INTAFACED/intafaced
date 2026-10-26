/**
 * Normal order placement on a market the matching engine holds no book for
 * (matching 404 → MatchingNoBookError) is a named refusal `trade.no_book`,
 * not an HTTP 500. It covers the three book reads on the placement path:
 * bestAsk (market buy), bestBid (market sell) and assertOwnerOrderLimit
 * (replace to a market sell under a published max-order). Nothing is held,
 * no order row is stored, and the original of a replace stays live.
 * Any other matching error is passed on unchanged.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { type IdentityOperationDecision, type IdentityOperationDecisionPort } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { TradingControls } from '../controls/trading-controls.js';
import { TradeService } from './trade-service.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubEmailProof, StubPerks, principalFor } from './testing.js';
import { TradeError } from './types.js';
import { MatchingNoBookError, MatchingUnavailableError, type EngineDepth } from './matching-client.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';

const ALICE = 'a2222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-24T16:00:00.000Z');

class NoBookMatching extends StubMatching {
  fail: 'none' | 'no_book' | 'unavailable' = 'none';
  override async depth(marketId?: string): Promise<EngineDepth> {
    if (this.fail === 'no_book') throw new MatchingNoBookError(marketId ?? '');
    if (this.fail === 'unavailable') throw new MatchingUnavailableError('matching down');
    return super.depth();
  }
}

describe('placeOrder with no matching book (isolated PostgreSQL)', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let matching: NoBookMatching;
  let trade: TradeService;
  let marketId: string;
  const savedMaxOrder = process.env.TRADE_MAX_ORDER;

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

  afterEach(() => {
    if (savedMaxOrder === undefined) delete process.env.TRADE_MAX_ORDER;
    else process.env.TRADE_MAX_ORDER = savedMaxOrder;
  });

  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db.sql);
    ledger = new MemoryLedger();
    matching = new NoBookMatching();
    matching.bids = [['59990', '10']];
    matching.asks = [['60000', '10']];
    const identityRows = new Map<string, IdentityOperationDecision>();
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
        return result;
      },
    };
    const controls = new TradingControls(db.sql, { check: async () => 'enabled' }, identity);
    trade = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      accountAdmission: controls,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketSlippageCapBps: 100,
      emailProof: new StubEmailProof(),
      now: () => NOW,
    });
    const market = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.001'),
      minQty: amt('0.001'),
      maxQty: amt('10000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    marketId = market.id;
  });

  async function fund(assetId: string, amount: string) {
    await ledger.post(recipes.deposit({ userId: ALICE, assetId, amount: amt(amount), rail: 'test', railRef: randomUUID() }));
  }

  async function available(assetId: string) {
    return formatAmount((await ledger.balance(userAvailable(ALICE, assetId))).amount);
  }

  async function orderCount() {
    const rows = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.orders`;
    return rows[0]?.n ?? '0';
  }

  const market = (side: 'buy' | 'sell', clientOrderId: string) => ({
    marketId,
    side,
    type: 'market' as const,
    qty: amt('0.01'),
    clientOrderId,
  });

  it('market buy (bestAsk) refuses with trade.no_book, holds nothing and stores no order', async () => {
    await fund('USDT', '1000');
    matching.fail = 'no_book';
    const refused = await trade.placeOrder(principalFor(ALICE), market('buy', 'mb-no-book')).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TradeError);
    expect(refused).toMatchObject({ code: 'trade.no_book' });
    expect(await available('USDT')).toBe('1000');
    expect(await orderCount()).toBe('0');
    expect(matching.submitted).toHaveLength(0);
  });

  it('market sell (bestBid) refuses with trade.no_book, holds nothing and stores no order', async () => {
    await fund('BTC', '1');
    matching.fail = 'no_book';
    const refused = await trade.placeOrder(principalFor(ALICE), market('sell', 'ms-no-book')).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TradeError);
    expect(refused).toMatchObject({ code: 'trade.no_book' });
    expect(await available('BTC')).toBe('1');
    expect(await orderCount()).toBe('0');
    expect(matching.submitted).toHaveLength(0);
  });

  it('replace to a market sell under a max-order (assertOwnerOrderLimit) refuses with trade.no_book and keeps the original', async () => {
    await fund('BTC', '1');
    process.env.TRADE_MAX_ORDER = '1000000';
    // TEST FIXTURE: a resting original needs a published price band and open-order cap (an approved operator row).
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (gen_random_uuid(), ${marketId}, 1, '0.5', NULL, NULL, '20', NULL, 'op', 'ap', 'test', gen_random_uuid())`;
    const original = await trade.placeOrder(principalFor(ALICE), {
      marketId,
      side: 'sell',
      type: 'limit',
      qty: amt('0.01'),
      price: amt('61000'),
      clientOrderId: 'rp-orig',
    });
    const btcAfterOriginal = await available('BTC');
    const ordersAfterOriginal = await orderCount();
    matching.fail = 'no_book';
    const refused = await trade.replaceOrder(principalFor(ALICE), original.id, market('sell', 'rp-no-book')).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TradeError);
    expect(refused).toMatchObject({ code: 'trade.no_book' });
    expect((await trade.findOrder(original.id))?.status).toBe(original.status);
    expect(matching.cancelledOrders).toHaveLength(0);
    expect(await available('BTC')).toBe(btcAfterOriginal);
    expect(await orderCount()).toBe(ordersAfterOriginal);
  });

  it('passes any other matching error through unchanged', async () => {
    await fund('USDT', '1000');
    matching.fail = 'unavailable';
    const refused = await trade.placeOrder(principalFor(ALICE), market('buy', 'mb-down')).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(MatchingUnavailableError);
    expect(refused).not.toBeInstanceOf(TradeError);
    expect(await available('USDT')).toBe('1000');
    expect(await orderCount()).toBe('0');
  });
});
