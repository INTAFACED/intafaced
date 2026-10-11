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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
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

const HERE = dirname(fileURLToPath(import.meta.url));

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
  it('router.ts does not invent 100 via ?? or optional limit', () => {
    const src = readFileSync(join(HERE, '../router.ts'), 'utf8');
    expect(src).not.toMatch(/myFills\(ctx\.principal, input\?\.limit \?\? 100\)/);
    expect(src).toMatch(/trade\.myFills\(ctx\.principal, input\.limit\)/);
    const historyStart = src.indexOf('history: scopedProcedure');
    expect(historyStart).toBeGreaterThan(-1);
    const historyFn = src.slice(historyStart, src.indexOf('fills: router', historyStart));
    expect(historyFn).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)/);
    expect(historyFn).not.toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.optional\(\)/);
    expect(src).toMatch(/orderHistory\(ctx\.principal, \{ marketId: input\.marketId, limit: input\.limit \}\)/);
  });

  it('trade-service.ts does not invent 100 via default param or clamp', () => {
    const src = readFileSync(join(HERE, 'trade-service.ts'), 'utf8');
    expect(src).not.toMatch(/async myFills\([^)]*limit = 100/);
    expect(src).toMatch(/async myFills\(principal: Principal, limit: number/);
    expect(src).toMatch(/publishedFillsMineLimit\(limit\)/);
    expect(src).not.toMatch(/input\.limit \?\? 100/);
    expect(src).toMatch(/publishedOrderHistoryLimit\(input\.limit\)/);
    expect(src).toMatch(/async fillsForOrder\(principal: Principal, orderId: string, limit: number\)/);
    expect(src).toMatch(/ORDER BY ts ASC LIMIT \$\{capped\}/);
    expect(src).not.toMatch(/async fillsForOrder\(principal: Principal, orderId: string\): Promise/);
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
