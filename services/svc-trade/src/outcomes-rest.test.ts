import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, serviceAuthHeaders, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createOutcomeMarket } from './outcomes/outcome-market.js';
import { memoryOutcomeCatalogue, registerOutcomesRest } from './outcomes-rest.js';
import { fakeOrder } from './private-rest.js';

const EDGE_SECRET = 'outcomes-rest-edge-secret-long-enough';
const INTERNAL_SECRET = 'outcomes-rest-internal-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';

function signedHeaders(): Record<string, string> {
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
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

describe('outcome markets REST', () => {
  it('GET /api/v1/outcomes/markets is empty array, not fake events', async () => {
    const app = Fastify();
    registerOutcomesRest(app, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-trade',
      internalSecret: INTERNAL_SECRET,
      catalogue: memoryOutcomeCatalogue([]),
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/v1/outcomes/markets' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([]);
    await app.close();
  });

  it.each([
    ['a deadline', { requestDeadline: '2026-08-24T11:30:00.000Z' }],
    ['a self-trade mode', { stpMode: 'cancel_maker' }],
    ['a tag', { tag: 'x' }],
    ['a trigger source', { triggerBy: 'mark' }],
  ])('refuses %s rather than dropping it', async (_name, extra) => {
    const market = createOutcomeMarket({
      id: 'fixture-outcome',
      question: 'Will the fixture condition be met?',
      closeAt: '2026-08-24T12:00:00.000Z',
      settlementAssetId: 'fixture-settlement-asset',
      settlementSource: 'fixture-owner-source',
    });
    const placeOutcomeOrder = vi.fn();
    const app = Fastify();
    registerOutcomesRest(app, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-trade',
      internalSecret: INTERNAL_SECRET,
      catalogue: memoryOutcomeCatalogue([market]),
      placeOutcomeOrder,
      now: () => Date.parse('2026-08-24T11:00:00.000Z'),
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/outcomes/orders',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'fixture-outcome:YES', side: 'buy', type: 'limit', amount: '2.5', price: '0.4', clientOrderId: 'k-1', ...extra },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(placeOutcomeOrder).not.toHaveBeenCalled();
    await app.close();
  });

  it('places through the injected canonical order path with decimal strings', async () => {
    const market = createOutcomeMarket({
      id: 'fixture-outcome',
      question: 'Will the fixture condition be met?',
      closeAt: '2026-08-24T12:00:00.000Z',
      settlementAssetId: 'fixture-settlement-asset',
      settlementSource: 'fixture-owner-source',
    });
    const placeOutcomeOrder = vi.fn(async (_principal, input) =>
      fakeOrder({ marketId: input.symbol, qty: input.qty, price: input.price ?? null }),
    );
    const app = Fastify();
    registerOutcomesRest(app, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-trade',
      internalSecret: INTERNAL_SECRET,
      catalogue: memoryOutcomeCatalogue([market]),
      placeOutcomeOrder,
      now: () => Date.parse('2026-08-24T11:00:00.000Z'),
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/outcomes/orders',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        symbol: 'fixture-outcome:YES',
        side: 'buy',
        type: 'limit',
        amount: '2.5',
        price: '0.4',
        clientOrderId: 'fixture-retry-key',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(placeOutcomeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      expect.objectContaining({
        symbol: 'fixture-outcome:YES',
        qty: parseAmount('2.5'),
        price: parseAmount('0.4'),
        collateralAssetId: 'fixture-settlement-asset',
        collateralAmount: '2.5',
      }),
    );
    expect(response.json()).toMatchObject({ symbol: 'fixture-outcome:YES', amount: '2.5', price: '0.4' });
    await app.close();
  });

  it('the publish door refuses owner.decision until the determination decision is made, and lists nothing', async () => {
    const app = Fastify();
    registerOutcomesRest(app, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-trade',
      internalSecret: INTERNAL_SECRET,
      catalogue: memoryOutcomeCatalogue([]),
    });
    await app.ready();
    const url = '/api/v1/outcomes/markets/publish';
    const unsigned = await app.inject({ method: 'POST', url, payload: { marketId: 'test-market', expectedOrdinal: 1 } });
    expect(unsigned.statusCode).toBe(401);
    const signed = (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      return app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-admin', INTERNAL_SECRET, body) },
        payload: body,
      });
    };
    const malformed = await signed({ marketId: 'Not An Id' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: 'trade.outcome_move_invalid' });
    const refused = await signed({ marketId: 'test-market', expectedOrdinal: 1 });
    expect(refused.statusCode).toBe(412);
    expect(refused.json()).toMatchObject({ error: 'owner.decision' });
    const listed = await app.inject({ method: 'GET', url: '/api/v1/outcomes/markets' });
    expect(listed.json()).toEqual([]);
    await app.close();
  });

  it('settlement is S2S and must match the listed source', async () => {
    const market = createOutcomeMarket({
      id: 'fixture-outcome',
      question: 'Will the fixture condition be met?',
      closeAt: '2026-08-24T12:00:00.000Z',
      settlementAssetId: 'fixture-settlement-asset',
      settlementSource: 'fixture-owner-source',
    });
    const settleMarket = vi.fn(async () => undefined);
    const app = Fastify();
    registerOutcomesRest(app, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-trade',
      internalSecret: INTERNAL_SECRET,
      catalogue: memoryOutcomeCatalogue([market]),
      settleMarket,
    });
    await app.ready();
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/v1/outcomes/settle',
      payload: { marketId: market.id, settlementSource: market.settlementSource, result: 'yes', settlementId: 'settle-fixture-1' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const wrongSourceBody = JSON.stringify({
      marketId: market.id,
      settlementSource: 'not-the-listed-source',
      result: 'yes',
      settlementId: 'settle-fixture-1',
    });
    const wrongSource = await app.inject({
      method: 'POST',
      url: '/api/v1/outcomes/settle',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-outcome-oracle', INTERNAL_SECRET, wrongSourceBody),
      },
      payload: wrongSourceBody,
    });
    expect(wrongSource.statusCode).toBe(400);
    expect(settleMarket).not.toHaveBeenCalled();

    const settledBody = JSON.stringify({
      marketId: market.id,
      settlementSource: market.settlementSource,
      result: 'no',
      settlementId: 'settle-fixture-1',
    });
    const settled = await app.inject({
      method: 'POST',
      url: '/api/v1/outcomes/settle',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-outcome-oracle', INTERNAL_SECRET, settledBody),
      },
      payload: settledBody,
    });
    expect(settled.statusCode).toBe(200);
    expect(settleMarket).toHaveBeenCalledWith(market, 'no', 'settle-fixture-1');
    await app.close();
  });

  it('settle requires body-bound HMAC — v1 header-only and tampered payload are 401', async () => {
    const market = createOutcomeMarket({
      id: 'fixture-outcome',
      question: 'Will the fixture condition be met?',
      closeAt: '2026-08-24T12:00:00.000Z',
      settlementAssetId: 'fixture-settlement-asset',
      settlementSource: 'fixture-owner-source',
    });
    const settleMarket = vi.fn(async () => undefined);
    const app = Fastify();
    registerOutcomesRest(app, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-trade',
      internalSecret: INTERNAL_SECRET,
      catalogue: memoryOutcomeCatalogue([market]),
      settleMarket,
    });
    await app.ready();
    const body = JSON.stringify({
      marketId: market.id,
      settlementSource: market.settlementSource,
      result: 'yes',
      settlementId: 'settle-fixture-1',
    });
    const v1 = await app.inject({
      method: 'POST',
      url: '/api/v1/outcomes/settle',
      headers: { 'content-type': 'application/json', ...serviceAuthHeaders('svc-outcome-oracle', INTERNAL_SECRET) },
      payload: body,
    });
    expect(v1.statusCode).toBe(401);
    const tampered = await app.inject({
      method: 'POST',
      url: '/api/v1/outcomes/settle',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-outcome-oracle', INTERNAL_SECRET, body),
      },
      payload: JSON.stringify({
        marketId: market.id,
        settlementSource: market.settlementSource,
        result: 'no',
        settlementId: 'settle-fixture-1',
      }),
    });
    expect(tampered.statusCode).toBe(401);
    expect(settleMarket).not.toHaveBeenCalled();
    await app.close();
  });
});
