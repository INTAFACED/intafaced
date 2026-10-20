/**
 * Private REST: GET /api/v1/orders/:id/amendments lists every amend and replace of one order.
 * Unwired mounts a typed 503; another user's order is the usual not-found; nothing is invented.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import { TradeError } from './spot/types.js';

const SECRET = 'a-trade-private-rest-amendments-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const ORDER = '33333333-3333-4333-8333-333333333333';

function headers(scopes: string[]): Record<string, string> {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

async function get(deps: Partial<PrivateRestDeps>, scopes = ['trade:read']) {
  const app = Fastify({ logger: false });
  registerPrivateRest(app, { edgeSecret: SECRET, serviceName: 'svc-trade', ...deps } as unknown as PrivateRestDeps);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: `/api/v1/orders/${ORDER}/amendments`, headers: headers(scopes) });
  await app.close();
  return res;
}

describe('GET /api/v1/orders/:id/amendments', () => {
  it('returns the rows the service lists, with the order id', async () => {
    const rows = [
      { kind: 'amend', at: '2026-10-01T00:00:00.000Z', quantity: '1', price: '50', version: '1', relatedOrderId: null, direction: null },
    ];
    const seen: string[] = [];
    const res = await get({
      orderAmendments: async (_p: Principal, id: string) => {
        seen.push(id);
        return rows as never;
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orderId: ORDER, amendments: rows });
    expect(seen).toEqual([ORDER]);
  });

  it('an order never changed lists nothing', async () => {
    const res = await get({ orderAmendments: async () => [] });
    expect(res.json()).toEqual({ orderId: ORDER, amendments: [] });
  });

  it('refuses with a typed 503 when the door is not wired', async () => {
    const res = await get({});
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('trade.amendments_unconfigured');
  });

  it('maps a missing or foreign order to the typed not-found', async () => {
    const res = await get({
      orderAmendments: async () => {
        throw new TradeError('order not found', 'trade.order_not_found');
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('OrderNotFound');
  });
});
