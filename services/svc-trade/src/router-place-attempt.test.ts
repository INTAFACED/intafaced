/**
 * TRD-0308. A risk officer can look up the first custodial place by clientOrderId.
 * A tier.insufficient refusal is stored with the user and tier, and available
 * balance does not move. The same clientOrderId does not create two orders.
 * A timeout is stored as unknown, not as a fill.
 *
 * Amounts below are TEST figures, not a customer balance.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTradeRouter } from './router.js';
import type { OrderRecord } from './spot/types.js';
import type { TradeService } from './spot/trade-service.js';

const SECRET = 'a-trade-place-attempt-test-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OFFICER = '55555555-5555-4555-8555-555555555555';
const SESSION = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const MARKET_ID = '44444444-4444-4444-8444-444444444444';
/** TEST available balance: 2.5 scaled by 10^18. */
const TEST_AVAILABLE = 2_500_000_000_000_000_000n;
const ONE = 1_000_000_000_000_000_000n;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function contextFor(principal: Principal, region: string) {
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
      'x-intafaced-region': region,
    },
    id: 'req-place-attempt',
  });
}

function principal(userId: string, tier: Principal['tier'], scopes: string[]): Principal {
  return {
    sub: userId,
    userId,
    sid: SESSION,
    scopes,
    tier,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

const placeBody = {
  symbol: 'BTC-USDT',
  side: 'buy' as const,
  type: 'limit' as const,
  qty: '1',
  price: '100',
  clientOrderId: 'first-refused-1',
};

function openOrder(clientOrderId: string): OrderRecord {
  return {
    id: ORDER_ID,
    userId: USER,
    subAccountId: null,
    marketId: MARKET_ID,
    clientOrderId,
    side: 'buy',
    type: 'limit',
    price: 100n * ONE,
    qty: ONE,
    filledQty: 0n,
    status: 'open',
    tif: 'GTC',
    holdAsset: 'USDT',
    holdAmount: 100n * ONE,
    amendReleased: 0n,
    feeDiscountBps: 0,
    protectionPrice: null,
    engineSequence: null,
    engineVersion: 0,
    seeded: false,
    rejectCode: null,
    recoveryReason: null,
    reconciliationKey: null,
    lifecycleProof: null,
    replacementOf: null,
    replacementRequestHash: null,
    sessionId: SESSION,
    apiKeyId: null,
    createdAt: new Date('2026-10-18T00:00:00.000Z'),
  };
}

describe('TRD-0308 place attempt on orders.create', () => {
  it('stores tier.insufficient for the officer and leaves available balance unchanged', async () => {
    let available = TEST_AVAILABLE;
    let placeCalls = 0;
    const trade = {
      placeOrder: async () => {
        placeCalls += 1;
        available -= ONE;
        return openOrder(placeBody.clientOrderId);
      },
    } as unknown as TradeService;
    const app = createTradeRouter(trade);
    const trader = app.createCaller(contextFor(principal(USER, 'none', ['trade:write']), 'SG'));
    const officer = app.createCaller(contextFor(principal(OFFICER, 'full', ['admin:read']), 'SG'));

    await expect(trader.orders.create(placeBody)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'tier.insufficient' },
    });
    await expect(trader.orders.create(placeBody)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'tier.insufficient' },
    });

    expect(placeCalls).toBe(0);
    expect(available).toBe(TEST_AVAILABLE);
    await expect(officer.orders.placeAttempt({ clientOrderId: placeBody.clientOrderId })).resolves.toEqual({
      userId: USER,
      tier: 'none',
      clientOrderId: placeBody.clientOrderId,
      outcome: 'refused',
      reason: 'tier.insufficient',
      orderId: null,
    });
  });

  it('does not create a second order for the same clientOrderId', async () => {
    let available = TEST_AVAILABLE;
    let placeCalls = 0;
    const trade = {
      placeOrder: async () => {
        placeCalls += 1;
        available -= ONE;
        return openOrder('same-client-1');
      },
    } as unknown as TradeService;
    const caller = createTradeRouter(trade).createCaller(contextFor(principal(USER, 'basic', ['trade:write']), 'SG'));
    const body = { ...placeBody, clientOrderId: 'same-client-1' };

    const first = await caller.orders.create(body);
    const second = await caller.orders.create(body);

    expect(placeCalls).toBe(1);
    expect(first.id).toBe(ORDER_ID);
    expect(second.id).toBe(ORDER_ID);
    expect(available).toBe(1_500_000_000_000_000_000n);
  });

  it('stores unknown when place times out and does not return a fill', async () => {
    let available = TEST_AVAILABLE;
    let placeCalls = 0;
    const trade = {
      placeOrder: async () => {
        placeCalls += 1;
        throw Object.assign(new Error('ledger timeout'), { code: 'ETIMEDOUT' });
      },
    } as unknown as TradeService;
    const app = createTradeRouter(trade);
    const caller = app.createCaller(contextFor(principal(USER, 'basic', ['trade:write']), 'SG'));
    const officer = app.createCaller(contextFor(principal(OFFICER, 'full', ['admin:read']), 'SG'));
    const body = { ...placeBody, clientOrderId: 'timeout-1' };

    await expect(caller.orders.create(body)).rejects.toMatchObject({
      cause: { code: 'trade.hold_unknown' },
    });
    await expect(caller.orders.create(body)).rejects.toMatchObject({
      cause: { code: 'trade.hold_unknown' },
    });

    expect(placeCalls).toBe(1);
    expect(available).toBe(TEST_AVAILABLE);
    await expect(officer.orders.placeAttempt({ clientOrderId: 'timeout-1' })).resolves.toEqual({
      userId: USER,
      tier: 'basic',
      clientOrderId: 'timeout-1',
      outcome: 'unknown',
      reason: null,
      orderId: null,
    });
  });

  it('still refuses a basic tier in a region whose trade rule requires full, with no hold', async () => {
    let available = TEST_AVAILABLE;
    let placeCalls = 0;
    const trade = {
      placeOrder: async () => {
        placeCalls += 1;
        available -= ONE;
        return openOrder('us-basic-1');
      },
    } as unknown as TradeService;
    const app = createTradeRouter(trade);
    const trader = app.createCaller(contextFor(principal(USER, 'basic', ['trade:write']), 'US'));
    const officer = app.createCaller(contextFor(principal(OFFICER, 'full', ['admin:read']), 'SG'));

    await expect(trader.orders.create({ ...placeBody, clientOrderId: 'us-basic-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'denied.kyc_required' },
    });
    expect(placeCalls).toBe(0);
    expect(available).toBe(TEST_AVAILABLE);
    await expect(officer.orders.placeAttempt({ clientOrderId: 'us-basic-1' })).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'denied.kyc_required',
      orderId: null,
    });
  });
});
