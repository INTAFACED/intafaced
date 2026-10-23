import Fastify, { type FastifyRequest } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { publicProcedure, retainRawBody, router, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createIdentityRequestContext } from '../controls/founder-context.js';
import { createApiKeyAccountRouter } from '../api-key-account-router.js';
import { createApiKeyProductRouter } from '../api-key-product-router.js';

const INTERNAL = 'synthetic-generic-identity-service-key-long-enough';
const EDGE = 'synthetic-http-read-identity-key-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const REQUEST = {
  method: 'POST',
  path: '/api/pay/v1/payments',
  timestamp: '1700000000',
  nonce: 'nonce-fresh-1',
  bodyHash: 'ab'.repeat(32),
  signature: 'cd'.repeat(32),
};

function contextConfig() {
  return {
    secret: 'synthetic-edge-principal-signing-key-long-enough',
    serviceName: 'svc-identity',
    internalSecret: INTERNAL,
    edgeAuthoritySecret: EDGE,
    privateAuthoritySecret: 'synthetic-private-read-identity-key-long-enough',
  };
}

describe('exchange routes accept request material only from svc-edge', () => {
  it('sets service only when the edge authority key signs an exchange procedure', async () => {
    const createContext = createIdentityRequestContext(contextConfig());
    const routes = router({
      apiKeys: router({
        exchange: publicProcedure.mutation(({ ctx }) => ({ service: ctx.service })),
      }),
      exchangeApiKeyForProduct: publicProcedure.mutation(({ ctx }) => ({ service: ctx.service })),
      exchangeApiKeyForAccount: publicProcedure.mutation(({ ctx }) => ({ service: ctx.service })),
      attribution: router({
        exchange: publicProcedure.mutation(({ ctx }) => ({ service: ctx.service })),
      }),
    });
    const app = Fastify();
    retainRawBody(app);
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: { router: routes, createContext: ({ req }: { req: FastifyRequest }) => createContext(req) },
    });
    try {
      for (const path of ['apiKeys.exchange', 'exchangeApiKeyForProduct', 'exchangeApiKeyForAccount', 'attribution.exchange']) {
        const payload = JSON.stringify({ json: {} });
        const open = await app.inject({ method: 'POST', url: `/trpc/${path}`, payload, headers: { 'content-type': 'application/json' } });
        expect(open.statusCode, path).toBe(200);
        expect(open.json()).toMatchObject({ result: { data: { service: null } } });
        const edge = await app.inject({
          method: 'POST',
          url: `/trpc/${path}`,
          payload,
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-edge', EDGE, payload) },
        });
        expect(edge.statusCode, path).toBe(200);
        expect(edge.json()).toMatchObject({ result: { data: { service: 'svc-edge' } } });
        const wrong = await app.inject({
          method: 'POST',
          url: `/trpc/${path}`,
          payload,
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-edge', INTERNAL, payload) },
        });
        expect(wrong.statusCode, path).toBe(200);
        expect(wrong.json()).toMatchObject({ result: { data: { service: null } } });
      }
      const mixed = JSON.stringify({ 0: { json: {} }, 1: { json: {} } });
      const batch = await app.inject({
        method: 'POST',
        url: '/trpc/apiKeys.exchange,exchangeApiKeyForProduct?batch=1',
        payload: mixed,
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-edge', EDGE, mixed) },
      });
      expect(batch.statusCode).toBe(200);
      const batchText = JSON.stringify(batch.json());
      expect(batchText).toContain('"service":"svc-edge"');
      expect(batchText).not.toContain('"service":null');
    } finally {
      await app.close();
    }
  });

  it('refuses a public request field and returns signing flags on the product and account exchanges', async () => {
    let calls = 0;
    const minter = {
      async createApiKey() {
        throw new Error('mint is not this test');
      },
      async revokeApiKey() {
        return true;
      },
      async acceptFreshFactor() {
        throw new Error('factor is not this test');
      },
      async exchangeApiKey() {
        calls += 1;
        return {
          accessToken: 'token',
          expiresAt: new Date('2026-10-16T01:00:00.000Z'),
          userId: USER,
          keyId: KEY,
          scopes: ['pay:read'],
          mode: 'live' as const,
          requireSignature: true,
          requireNonEmptyIpAllowlist: true,
          ipAllowlist: ['203.0.113.10'],
        };
      },
    };
    const sql = (async () => []) as unknown as Sql;
    const product = createApiKeyProductRouter(sql, minter);
    const account = createApiKeyAccountRouter(sql, minter);
    const anonymous = { principal: null, service: null, region: 'DE', requestId: 'r' };
    const edge = { ...anonymous, service: 'svc-edge' };
    await expect(
      product.createCaller(anonymous).exchangeApiKeyForProduct({ key: 'ifc_live_testkey', product: 'pay', request: REQUEST }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      account.createCaller(anonymous).exchangeApiKeyForAccount({
        key: 'ifc_live_testkey',
        accountId: '33333333-3333-4333-8333-333333333333',
        request: REQUEST,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toBe(0);
    await expect(product.createCaller(edge).exchangeApiKeyForProduct({ key: 'ifc_live_testkey', product: 'pay' })).resolves.toMatchObject({
      requireSignature: true,
      requireNonEmptyIpAllowlist: true,
      ipAllowlist: ['203.0.113.10'],
      product: 'pay',
    });
    await expect(
      account.createCaller(edge).exchangeApiKeyForAccount({
        key: 'ifc_live_testkey',
        accountId: '33333333-3333-4333-8333-333333333333',
      }),
    ).resolves.toMatchObject({
      requireSignature: true,
      requireNonEmptyIpAllowlist: true,
      ipAllowlist: ['203.0.113.10'],
    });
    expect(calls).toBe(2);
  });
});
