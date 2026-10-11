import { TradeService } from './controls/test-admission.js';
/**
 * Unit card — tRPC orders.open optional limit → named refuse (no invented 100)
 *
 * 1. Promise: orders.open without limit does not dump the caller's open book.
 *    Owner may pass 100.
 * 2. Break: optional marketId-only input called TradeService.openOrders unbounded.
 * 3. Done bar: optional tRPC limit; omit/undefined hits trade.open_orders_limit_unset;
 *    explicit 50 reaches TradeService.openOrders.
 * 4. Class N
 * 5. Paths: router.ts orders.open
 * 6. RED: omitting limit returns every open/pending/recovery order
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTradeRouter } from './router.js';
import { TRADE_OPEN_ORDERS_LIMIT_UNSET } from './spot/trade-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'a-trade-orders-open-limit-test-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function signed() {
  const p = {
    sub: USER,
    userId: USER,
    sid: SESSION,
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
    id: 'req-orders-open',
  });
}

describe('tRPC orders.open limit unset refuse (no invented 100)', () => {
  it('router.ts does not invent 100 when orders.open omits limit', () => {
    const src = readFileSync(join(HERE, 'router.ts'), 'utf8');
    const start = src.indexOf('open: scopedProcedure');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('history: scopedProcedure', start));
    expect(fn).toContain('limit: z.number().int().min(1).max(500).optional()');
    expect(fn).toContain('publishedOpenOrdersLimit(input?.limit)');
    expect(fn).not.toMatch(/\?\? 100/);
    expect(fn).not.toMatch(/limit = 100/);
  });

  it('omit / undefined limit is named refuse; owner-explicit 50 reaches openOrders', async () => {
    const seen: Array<{ marketId: string | undefined; limit: number }> = [];
    const trade = {
      openOrders: async (_principal: Principal, marketId: string | undefined, limit: number) => {
        seen.push({ marketId, limit });
        return [];
      },
    } as unknown as TradeService;
    const caller = createTradeRouter(trade).createCaller(signed());

    await expect(caller.orders.open()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining(TRADE_OPEN_ORDERS_LIMIT_UNSET),
    });
    await expect(caller.orders.open({})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining(TRADE_OPEN_ORDERS_LIMIT_UNSET),
    });
    expect(seen).toEqual([]);

    await expect(caller.orders.open({ limit: 50 })).resolves.toEqual([]);
    expect(seen).toEqual([{ marketId: undefined, limit: 50 }]);
  });
});
