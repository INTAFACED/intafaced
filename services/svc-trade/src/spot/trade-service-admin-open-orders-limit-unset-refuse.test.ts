import { TradeService } from '../controls/test-admission.js';
/**
 * Unit card — adminOpenOrders limit unset refuse (no invented 100)
 *
 * 1. Promise: omitted TradeService.adminOpenOrders limit does not become 100.
 *    Owner/query may pass 100.
 * 2. Break: `adminOpenOrders(..., limit = 100)` plus clamp `Math.min(Math.max(limit, 1), 500)`
 *    dressed a blank page as a chosen window (leftover after fills/history #4078).
 * 3. Done bar: no default 100 / no clamp; unset/null/out of 1..500 throw typed
 *    `trade.admin_open_orders_limit_unset` before SQL; explicit 100 is a published window.
 * 4. Class N
 * 5. Paths: trade-service.ts adminOpenOrders
 * 6. RED: omitting limit returns a 100-row page
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  ADMIN_OPEN_ORDERS_LIMIT_MAX,
  AdminOpenOrdersLimitUnsetError,
  publishedAdminOpenOrdersLimit,
  TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET,
} from './trade-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const ADMIN = {
  userId: '11111111-1111-4111-8111-111111111111',
  scopes: ['admin:read'],
} as Principal;

function serviceWithUnreachableSql(): { trade: TradeService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when adminOpenOrders limit is unset');
  }, {}) as never;
  const trade = new TradeService(sql, {} as never, {} as never, {} as never, {} as never);
  return { trade, sqlCalled: () => sqlCalled };
}

describe('adminOpenOrders limit unset refuse (no invented 100)', () => {
  it('trade-service.ts does not invent 100 via default param or clamp', () => {
    const src = readFileSync(join(HERE, 'trade-service.ts'), 'utf8');
    expect(src).not.toMatch(/async adminOpenOrders\([^)]*limit = 100/);
    expect(src).toMatch(/async adminOpenOrders\(principal: Principal, limit: number\)/);
    expect(src).toMatch(/publishedAdminOpenOrdersLimit\(limit\)/);
    expect(src).not.toMatch(/adminOpenOrders[\s\S]{0,200}Math\.min\(Math\.max\(limit, 1\), 500\)/);
  });

  it('blank / non-integer / out of 1..500 throws trade.admin_open_orders_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedAdminOpenOrdersLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AdminOpenOrdersLimitUnsetError);
        expect((err as AdminOpenOrdersLimitUnsetError).code).toBe(TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 100 and 1 are published windows', () => {
    expect(publishedAdminOpenOrdersLimit(100)).toBe(100);
    expect(publishedAdminOpenOrdersLimit(1)).toBe(1);
    expect(publishedAdminOpenOrdersLimit(ADMIN_OPEN_ORDERS_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null adminOpenOrders limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { trade, sqlCalled } = serviceWithUnreachableSql();
      await expect(trade.adminOpenOrders(ADMIN, limit)).rejects.toMatchObject({
        name: 'AdminOpenOrdersLimitUnsetError',
        code: TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
