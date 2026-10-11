import { TradeService } from '../controls/test-admission.js';
/**
 * Unit card — openOrders limit unset refuse (no invented 100)
 *
 * 1. Promise: omitted TradeService.openOrders limit does not dump every
 *    open/pending/recovery row. Owner/query may pass 100.
 * 2. Break: `openOrders(principal, marketId)` SELECT with no LIMIT (leftover
 *    after adminOpenOrders / orders.history mill).
 * 3. Done bar: no default 100 / no clamp; unset/null/out of 1..500 throw typed
 *    `trade.open_orders_limit_unset` before SQL; explicit 2/50/100 are published
 *    windows and SQL carries LIMIT.
 * 4. Class N
 * 5. Paths: trade-service.ts openOrders
 * 6. RED: omitting limit returns every open order
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { OrderRow } from './rows.js';
import {
  OPEN_ORDERS_LIMIT_MAX,
  OpenOrdersLimitUnsetError,
  publishedOpenOrdersLimit,
  TRADE_OPEN_ORDERS_LIMIT_UNSET,
} from './trade-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const READER = {
  userId: '11111111-1111-4111-8111-111111111111',
  scopes: ['trade:read'],
} as Principal;

function fakeOpenRow(i: number): OrderRow {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    user_id: READER.userId,
    sub_account_id: null,
    market_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    client_order_id: null,
    side: 'buy',
    type: 'limit',
    price: '100',
    qty: '1',
    filled_qty: '0',
    status: 'open',
    tif: 'GTC',
    hold_asset: 'USDT',
    hold_amount: '100',
    amend_released: '0',
    fee_discount_bps: '0',
    protection_price: null,
    engine_sequence: null,
    engine_version: 1,
    seeded: false,
    reject_code: null,
    recovery_reason: null,
    reconciliation_key: null,
    lifecycle_proof: null,
    replacement_of: null,
    replacement_request_hash: null,
    session_id: null,
    api_key_id: null,
    created_at: new Date(0),
  };
}

function serviceWithUnreachableSql(): { trade: TradeService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when openOrders limit is unset');
  }, {}) as never;
  const trade = new TradeService(sql, {} as never, {} as never, {} as never, {} as never);
  return { trade, sqlCalled: () => sqlCalled };
}

function serviceWithCapturingSql(pool: OrderRow[]): {
  trade: TradeService;
  queries: Array<{ text: string; values: unknown[] }>;
} {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values });
    const limit = values.find((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1);
    return Promise.resolve(limit === undefined ? pool : pool.slice(0, limit));
  }, {}) as never;
  const trade = new TradeService(sql, {} as never, {} as never, {} as never, {} as never);
  return { trade, queries };
}

describe('openOrders limit unset refuse (no invented 100)', () => {
  it('trade-service.ts does not invent 100 via default param or clamp', () => {
    const src = readFileSync(join(HERE, 'trade-service.ts'), 'utf8');
    expect(src).not.toMatch(/async openOrders\([^)]*limit = 100/);
    expect(src).toMatch(/async openOrders\(principal: Principal, marketId: string \| undefined, limit: number\)/);
    expect(src).toMatch(/publishedOpenOrdersLimit\(limit\)/);
    expect(src).not.toMatch(/openOrders[\s\S]{0,400}Math\.min\(Math\.max\(limit, 1\), 500\)/);
  });

  it('blank / non-integer / out of 1..500 throws trade.open_orders_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedOpenOrdersLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(OpenOrdersLimitUnsetError);
        expect((err as OpenOrdersLimitUnsetError).code).toBe(TRADE_OPEN_ORDERS_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 100 / 1 / 2 / 50 are published windows', () => {
    expect(publishedOpenOrdersLimit(100)).toBe(100);
    expect(publishedOpenOrdersLimit(1)).toBe(1);
    expect(publishedOpenOrdersLimit(2)).toBe(2);
    expect(publishedOpenOrdersLimit(50)).toBe(50);
    expect(publishedOpenOrdersLimit(OPEN_ORDERS_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null openOrders limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { trade, sqlCalled } = serviceWithUnreachableSql();
      await expect(trade.openOrders(READER, undefined, limit)).rejects.toMatchObject({
        name: 'OpenOrdersLimitUnsetError',
        code: TRADE_OPEN_ORDERS_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });

  it('published 2 or 50 slices and SQL carries LIMIT', async () => {
    const pool = Array.from({ length: 80 }, (_, i) => fakeOpenRow(i + 1));
    for (const window of [2, 50] as const) {
      const { trade, queries } = serviceWithCapturingSql(pool);
      const rows = await trade.openOrders(READER, undefined, window);
      expect(rows).toHaveLength(window);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.text.toUpperCase()).toContain('LIMIT');
      expect(queries[0]!.values).toContain(window);
    }
  });
});
