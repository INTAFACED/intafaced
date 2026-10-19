import { vi } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createOutcomeMarket } from './outcomes/outcome-market.js';
import { memoryOutcomeCatalogue, registerOutcomesRest } from './outcomes-rest.js';
import { fakeOrder } from './private-rest.js';
const EDGE = 'outcomes-rest-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
export function headers(region: string): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE, region),
    'x-intafaced-region': region,
    'content-type': 'application/json',
  };
}
export async function post(region: string, payload: Record<string, unknown>) {
  const market = createOutcomeMarket({
    id: 'fixture-outcome',
    question: 'Q?',
    closeAt: '2026-08-24T12:00:00.000Z',
    settlementAssetId: 'a',
    settlementSource: 's',
  });
  const place = vi.fn(async (_p: unknown, input: any) => fakeOrder({ marketId: input.symbol, qty: input.qty, price: input.price ?? null }));
  const app = Fastify();
  registerOutcomesRest(app, {
    edgeSecret: EDGE,
    serviceName: 'svc-trade',
    internalSecret: 'outcomes-rest-internal-secret-long-enough',
    catalogue: memoryOutcomeCatalogue([market]),
    placeOutcomeOrder: place as never,
    now: () => Date.parse('2026-08-24T11:00:00.000Z'),
  });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/outcomes/orders',
    headers: headers(region),
    payload: { symbol: 'fixture-outcome:YES', side: 'buy', type: 'limit', amount: '2', price: '0.4', clientOrderId: 'k1', ...payload },
  });
  await app.close();
  return { res, place };
}
