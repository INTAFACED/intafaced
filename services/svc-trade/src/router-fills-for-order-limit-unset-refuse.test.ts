import { TradeService } from './controls/test-admission.js';
/**
 * Unit card — tRPC fills.forOrder optional limit → named refuse (no invented 100)
 *
 * 1. Promise: fills.forOrder without limit does not dump that order's fills.
 *    Owner may pass 100/500. Reuses fills.mine 1..500 window.
 * 2. Break: orderId-only input called TradeService.fillsForOrder unbounded.
 * 3. Done bar: optional tRPC limit; omit/undefined hits trade.fills_mine_limit_unset;
 *    explicit 50 reaches TradeService.fillsForOrder.
 * 4. Class N
 * 5. Paths: router.ts fills.forOrder
 * 6. RED: omitting limit returns every fill for the order
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTradeRouter } from './router.js';
import { TRADE_FILLS_MINE_LIMIT_UNSET } from './spot/trade-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'a-trade-fills-for-order-limit-test-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
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
    id: 'req-fills-for-order',
  });
}

describe('tRPC fills.forOrder limit unset refuse (no invented 100)', () => {
  it('router.ts does not invent 100 when fills.forOrder omits limit', () => {
    const src = readFileSync(join(HERE, 'router.ts'), 'utf8');
    const start = src.indexOf('forOrder: scopedProcedure');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('convert: router', start));
    expect(fn).toContain('limit: z.number().int().min(1).max(500).optional()');
    expect(fn).toContain('publishedFillsMineLimit(input.limit)');
    expect(fn).not.toMatch(/\?\? 100/);
    expect(fn).not.toMatch(/limit = 100/);
    expect(fn).not.toMatch(/fillsForOrder\(ctx\.principal, input\.orderId\)\)/);
  });

  it('omit / undefined limit is named refuse; owner-explicit 50 reaches fillsForOrder', async () => {
    const seen: Array<{ orderId: string; limit: number }> = [];
    const trade = {
      fillsForOrder: async (_principal: Principal, orderId: string, limit: number) => {
        seen.push({ orderId, limit });
        return [];
      },
    } as unknown as TradeService;
    const caller = createTradeRouter(trade).createCaller(signed());

    await expect(caller.fills.forOrder({ orderId: ORDER })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining(TRADE_FILLS_MINE_LIMIT_UNSET),
    });
    expect(seen).toEqual([]);

    await expect(caller.fills.forOrder({ orderId: ORDER, limit: 50 })).resolves.toEqual([]);
    expect(seen).toEqual([{ orderId: ORDER, limit: 50 }]);
  });
});
