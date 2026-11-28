import { TradeService } from '../controls/test-admission.js';
/**
 * Unit card — fills.mine / orders.history limit unset refuse (no invented 100)
 *
 * 1. Promise: omitted tRPC fills.mine / orders.history limit does not become 100.
 *    Owner/query may pass 100.
 * 2. Break: `myFills(..., limit = 100)` and `orderHistory` `input.limit ?? 100`
 *    plus tRPC `input?.limit ?? 100` dressed a blank page as a chosen window
 *    (leftover after private REST #4060-class mill).
 * 3. Done bar: no `?? 100` on fills.mine / no myFills default 100 / no
 *    orderHistory `?? 100`; unset/null/out of 1..500 throw typed codes before
 *    SQL; explicit 100 is a published window.
 * 4. Class N
 * 5. Paths: router.ts fills.mine + orders.history; trade-service.ts myFills +
 *    orderHistory
 * 6. RED: omitting limit returns a 100-row tape/page
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTradeRouter } from '../router.js';
import {
  FILLS_MINE_LIMIT_MAX,
  FillsMineLimitUnsetError,
  ORDER_HISTORY_LIMIT_MAX,
  OrderHistoryLimitUnsetError,
  publishedFillsMineLimit,
  publishedOrderHistoryLimit,
  TRADE_FILLS_MINE_LIMIT_UNSET,
  TRADE_ORDER_HISTORY_LIMIT_UNSET,
} from './trade-service.js';

const SECRET = 'a-trade-fills-history-limit-test-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const MARKET = '44444444-4444-4444-8444-444444444444';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function signed() {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-fills-history',
  });
}

const READER = {
  userId: '11111111-1111-4111-8111-111111111111',
  scopes: ['trade:read'],
} as Principal;

function serviceWithUnreachableSql(): { trade: TradeService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when fills/history limit is unset');
  }, {}) as never;
  const trade = new TradeService(sql, {} as never, {} as never, {} as never, {} as never);
  return { trade, sqlCalled: () => sqlCalled };
}

describe('fills.mine / orders.history limit unset refuse (no invented 100)', () => {
  it("the router hands fills.mine and orders.history the caller's own limit, and refuses a read outside 1..500", async () => {
    const seen: unknown[] = [];
    const trade = partial<TradeService>({
      myFills: async (_principal: Principal, limit: number) => {
        seen.push(['myFills', limit]);
        return [];
      },
      orderHistory: async (_principal: Principal, input: { marketId?: string; limit: number }) => {
        seen.push(['orderHistory', input]);
        return [];
      },
    });
    const caller = createTradeRouter(trade).createCaller(signed());

    for (const input of [{}, { limit: 0 }, { limit: 501 }, { limit: 1.5 }]) {
      const label = JSON.stringify(input);
      await expect(caller.fills.mine(input as { limit: number }), label).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(caller.orders.history(input as { limit: number }), label).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(seen).toEqual([]);
    await expect(caller.fills.mine({ limit: 50 })).resolves.toEqual([]);
    await expect(caller.orders.history({ marketId: MARKET, limit: 20 })).resolves.toEqual([]);
    await expect(caller.orders.history({ limit: 500 })).resolves.toEqual([]);
    expect(seen).toEqual([
      ['myFills', 50],
      ['orderHistory', { marketId: MARKET, limit: 20 }],
      ['orderHistory', { marketId: undefined, limit: 500 }],
    ]);
  });

  it('blank / non-integer / out of 1..500 throws trade.fills_mine_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedFillsMineLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(FillsMineLimitUnsetError);
        expect((err as FillsMineLimitUnsetError).code).toBe(TRADE_FILLS_MINE_LIMIT_UNSET);
      }
    }
  });

  it('blank / non-integer / out of 1..500 throws trade.order_history_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedOrderHistoryLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(OrderHistoryLimitUnsetError);
        expect((err as OrderHistoryLimitUnsetError).code).toBe(TRADE_ORDER_HISTORY_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 100 and 1 are published windows', () => {
    expect(publishedFillsMineLimit(100)).toBe(100);
    expect(publishedFillsMineLimit(1)).toBe(1);
    expect(publishedFillsMineLimit(FILLS_MINE_LIMIT_MAX)).toBe(500);
    expect(publishedOrderHistoryLimit(100)).toBe(100);
    expect(publishedOrderHistoryLimit(1)).toBe(1);
    expect(publishedOrderHistoryLimit(ORDER_HISTORY_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null myFills limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { trade, sqlCalled } = serviceWithUnreachableSql();
      await expect(trade.myFills(READER, limit)).rejects.toMatchObject({
        name: 'FillsMineLimitUnsetError',
        code: TRADE_FILLS_MINE_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });

  it('omitted / undefined / null orderHistory limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { trade, sqlCalled } = serviceWithUnreachableSql();
      await expect(trade.orderHistory(READER, { limit })).rejects.toMatchObject({
        name: 'OrderHistoryLimitUnsetError',
        code: TRADE_ORDER_HISTORY_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });

  it('omitted / undefined / null fillsForOrder limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { trade, sqlCalled } = serviceWithUnreachableSql();
      await expect(trade.fillsForOrder(READER, '33333333-3333-4333-8333-333333333333', limit)).rejects.toMatchObject({
        name: 'FillsMineLimitUnsetError',
        code: TRADE_FILLS_MINE_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
