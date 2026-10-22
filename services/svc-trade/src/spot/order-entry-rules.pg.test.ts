/**
 * SP-order-entry-03 write half through the real TradeService and Postgres:
 * price band (cancel / amend), stale reference, blank band, max qty for a
 * market order, and the total / per-verification-level open-order caps.
 * Every refusal is checked to leave no order row (so no hold was taken).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import type { TestDatabase } from '@intafaced/db';
import { TradeService } from '../controls/test-admission.js';
import { ALICE, fund, openTradeDatabase, publishTestCreditLimits, resetAndListMarket } from './__tests__/saga-trade-fixture.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import { SqlPriceCorrectionSource, setPriceCorrection, type OrderEntryRules, type PriceBandRule } from './order-entry-rules.js';
import type { Market } from './types.js';

const NOW = new Date('2026-10-21T10:00:00Z');
let db: TestDatabase;
let stop: () => Promise<void>;
let restoreLimits: () => void;
let ledger: MemoryLedger;
let matching: StubMatching;
let market: Market;

function band(price: string, ageMs = 1_000): PriceBandRule {
  return {
    bandBps: 500,
    maxReferenceAgeMs: 60_000,
    reference: { reference: async () => ({ price: amt(price), at: new Date(NOW.getTime() - ageMs) }) },
  };
}

function rules(over: Partial<OrderEntryRules> = {}): OrderEntryRules {
  return {
    priceBand: band('100'),
    openOrderCaps: { total: 10, byLevel: { basic: 10 } },
    priceCorrection: new SqlPriceCorrectionSource(db.sql),
    ...over,
  };
}

function service(orderEntry: OrderEntryRules): TradeService {
  return new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
    orderEntry,
    marketLifecycle: READY_MARKET_LIFECYCLE,
    spotEnabled: true,
    marketSlippageCapBps: 150,
    feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    now: () => NOW,
  });
}

function limit(side: 'buy' | 'sell', price: string, clientOrderId: string) {
  return { symbol: 'BTC/USDT', side, type: 'limit' as const, qty: amt('0.01'), price: amt(price), tif: 'GTC' as const, clientOrderId };
}

async function orderRows(): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trade.orders`;
  return row!.n;
}

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return 'placed';
}

beforeAll(async () => {
  restoreLimits = publishTestCreditLimits();
  ({ db, stop } = await openTradeDatabase());
}, 120_000);

afterAll(async () => {
  restoreLimits?.();
  await db?.drop();
  await stop?.();
});

beforeEach(async () => {
  ledger = new MemoryLedger();
  matching = new StubMatching();
  market = await resetAndListMarket(db, ledger, matching);
  await db.sql`TRUNCATE trade.account_price_correction`;
  await fund(ledger, ALICE, 'USDT', '100000');
  await fund(ledger, ALICE, 'BTC', '10');
});

describe('SP-order-entry-03 price band', () => {
  it('a buy above the high edge with priceCorrection cancel (the default) refuses trade.price_out_of_band and takes no hold', async () => {
    const code = await refused(service(rules()).placeOrder(principalFor(ALICE), limit('buy', '106', 'band-cancel')));
    expect(code).toBe('trade.price_out_of_band');
    expect(await orderRows()).toBe(0);
  });

  it('a sell below the low edge refuses trade.price_out_of_band', async () => {
    const code = await refused(service(rules()).placeOrder(principalFor(ALICE), limit('sell', '94', 'band-sell')));
    expect(code).toBe('trade.price_out_of_band');
    expect(await orderRows()).toBe(0);
  });

  it('a price inside the band is placed unchanged', async () => {
    const order = await service(rules()).placeOrder(principalFor(ALICE), limit('buy', '105', 'band-in'));
    expect(order.price).toBe(amt('105'));
    expect(order.priceAdjusted).toBe(false);
    expect(order.requestedPrice).toBeNull();
  });

  it('with priceCorrection amend the price moves to the edge, priceAdjusted is true, and the hold uses the edge', async () => {
    await setPriceCorrection(db.sql, ALICE, 'amend');
    const trade = service(rules());
    const order = await trade.placeOrder(principalFor(ALICE), limit('buy', '120', 'band-amend'));
    expect(order.price).toBe(amt('105'));
    expect(order.priceAdjusted).toBe(true);
    expect(order.requestedPrice).toBe(amt('120'));
    // 0.01 x 105 = 1.05 USDT held, not 1.20.
    expect(order.holdAmount).toBe(amt('1.05'));
    const [row] = await db.sql<
      { price: string; hold_amount: string }[]
    >`SELECT price::text, hold_amount::text FROM trade.orders WHERE id = ${order.id}`;
    expect(amt(row!.price)).toBe(amt('105'));
    expect(amt(row!.hold_amount)).toBe(amt('1.05'));
    // A retry with the caller's original request adopts the same order, never a second one.
    const again = await trade.placeOrder(principalFor(ALICE), limit('buy', '120', 'band-amend'));
    expect(again.id).toBe(order.id);
    expect(await orderRows()).toBe(1);
    // The same key with a different price is still a conflict.
    expect(await refused(trade.placeOrder(principalFor(ALICE), limit('buy', '105', 'band-amend')))).toBe('trade.client_order_id_conflict');
  });

  it('a sell amended to the low edge is ceiled onto the tick grid', async () => {
    await setPriceCorrection(db.sql, ALICE, 'amend');
    const order = await service(rules({ priceBand: band('100.01') })).placeOrder(principalFor(ALICE), {
      ...limit('sell', '50', 'band-sell-amend'),
      qty: amt('0.1'),
    });
    // 100.01 x 0.95 = 95.0095 -> ceil to 0.01 tick = 95.01
    expect(order.price).toBe(amt('95.01'));
    expect(order.priceAdjusted).toBe(true);
  });

  it('a blank band refuses a limit order trade.operator_collar before any hold', async () => {
    const code = await refused(service(rules({ priceBand: null })).placeOrder(principalFor(ALICE), limit('buy', '100', 'band-null')));
    expect(code).toBe('trade.operator_collar');
    expect(await orderRows()).toBe(0);
  });

  it('a stale reference refuses trade.reference_stale before any hold', async () => {
    const code = await refused(
      service(rules({ priceBand: band('100', 120_000) })).placeOrder(principalFor(ALICE), limit('buy', '100', 'band-stale')),
    );
    expect(code).toBe('trade.reference_stale');
    expect(await orderRows()).toBe(0);
  });

  it('a missing reference refuses trade.reference_stale', async () => {
    const none: PriceBandRule = { bandBps: 500, maxReferenceAgeMs: 60_000, reference: { reference: async () => null } };
    const code = await refused(service(rules({ priceBand: none })).placeOrder(principalFor(ALICE), limit('buy', '100', 'band-none')));
    expect(code).toBe('trade.reference_stale');
    expect(await orderRows()).toBe(0);
  });
});

describe('SP-order-entry-03 minimums keep their existing codes', () => {
  it('below minQty refuses trade.invalid_qty and below minNotional refuses trade.below_min_notional', async () => {
    const trade = service(rules());
    expect(await refused(trade.placeOrder(principalFor(ALICE), { ...limit('buy', '100', 'min-q'), qty: amt('0.00001') }))).toBe(
      'trade.invalid_qty',
    );
    expect(await refused(trade.placeOrder(principalFor(ALICE), { ...limit('buy', '100', 'min-n'), qty: amt('0.0001') }))).toBe(
      'trade.below_min_notional',
    );
    expect(await orderRows()).toBe(0);
  });
});

describe('SP-order-entry-03 max qty', () => {
  it('a market order on a listing with no maxQty refuses trade.max_qty_unset before any hold', async () => {
    await db.sql`UPDATE trade.markets SET max_qty = NULL WHERE id = ${market.id}`;
    const code = await refused(
      service(rules()).placeOrder(principalFor(ALICE), {
        symbol: 'BTC/USDT',
        side: 'sell',
        type: 'market',
        qty: amt('0.01'),
        tif: 'IOC',
        clientOrderId: 'mq-null',
      }),
    );
    expect(code).toBe('trade.max_qty_unset');
    expect(await orderRows()).toBe(0);
  });
});

describe('SP-order-entry-03 open-order caps', () => {
  it('a blank total cap refuses trade.open_order_cap_unset', async () => {
    const code = await refused(service(rules({ openOrderCaps: null })).placeOrder(principalFor(ALICE), limit('buy', '100', 'cap-null')));
    expect(code).toBe('trade.open_order_cap_unset');
    expect(await orderRows()).toBe(0);
  });

  it("a cap with no entry for the account's verification level refuses trade.open_order_cap_unset", async () => {
    const code = await refused(
      service(rules({ openOrderCaps: { total: 10, byLevel: { full: 10 } } })).placeOrder(
        principalFor(ALICE),
        limit('buy', '100', 'cap-level-null'),
      ),
    );
    expect(code).toBe('trade.open_order_cap_unset');
    expect(await orderRows()).toBe(0);
  });

  it('a blank cap also refuses an order that cannot rest (blank is not off)', async () => {
    const code = await refused(
      service(rules({ openOrderCaps: null })).placeOrder(principalFor(ALICE), { ...limit('buy', '100', 'cap-null-ioc'), tif: 'IOC' }),
    );
    expect(code).toBe('trade.open_order_cap_unset');
    expect(await orderRows()).toBe(0);
  });

  it('the total cap full refuses trade.open_order_cap_total', async () => {
    const trade = service(rules({ openOrderCaps: { total: 1, byLevel: { basic: 10 } } }));
    await trade.placeOrder(principalFor(ALICE), limit('buy', '100', 'cap-t-1'));
    expect(await refused(trade.placeOrder(principalFor(ALICE), limit('buy', '100', 'cap-t-2')))).toBe('trade.open_order_cap_total');
    expect(await orderRows()).toBe(1);
  });

  it('the verification-level cap full refuses trade.open_order_cap_level', async () => {
    const trade = service(rules({ openOrderCaps: { total: 10, byLevel: { basic: 1 } } }));
    await trade.placeOrder(principalFor(ALICE), limit('buy', '100', 'cap-l-1'));
    expect(await refused(trade.placeOrder(principalFor(ALICE), limit('buy', '100', 'cap-l-2')))).toBe('trade.open_order_cap_level');
    expect(await orderRows()).toBe(1);
  });

  it('with no open orders (empty state) the first order is placed', async () => {
    const order = await service(rules({ openOrderCaps: { total: 1, byLevel: { basic: 1 } } })).placeOrder(
      principalFor(ALICE),
      limit('buy', '100', 'cap-empty'),
    );
    expect(order.status).toBe('open');
  });
});
