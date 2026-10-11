import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { API_KEY_OWNERSHIP_PATH, registerApiKeyOwnershipRoute } from './api-key-ownership-route.js';
import type { ApiKeyOwnershipSnapshot } from './place-door.js';

const SECRET = 'an-identity-test-internal-secret-long-enough-for-hmac';
const EDGE = 'an-identity-test-http-read-secret-long-enough-for-hmac';
const KEY = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ACC = '00000000-0000-4000-8000-000000000003';
const EXPIRES = new Date('2099-01-01T00:00:00.000Z');

function serviceHeaders(): Record<string, string> {
  return serviceAuthHeadersForBody('svc-edge', EDGE, '');
}

function doorWith(row: ApiKeyOwnershipSnapshot | null) {
  return {
    async getApiKeyOwnership(keyId: string): Promise<ApiKeyOwnershipSnapshot | null> {
      return keyId === KEY ? row : null;
    },
  };
}

describe('GET /internal/api-keys/:keyId', () => {
  it('401s without service credentials', async () => {
    const app = Fastify({ logger: false });
    registerApiKeyOwnershipRoute(app, { door: doorWith(null), internalSecret: SECRET, edgeAuthoritySecret: EDGE });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${API_KEY_OWNERSHIP_PATH}/${KEY}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('404s unknown id', async () => {
    const app = Fastify({ logger: false });
    registerApiKeyOwnershipRoute(app, { door: doorWith(null), internalSecret: SECRET, edgeAuthoritySecret: EDGE });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `${API_KEY_OWNERSHIP_PATH}/${KEY}`,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'identity.api_key_not_found' });
    await app.close();
  });

  it('publishes stored binds; empty lists stay empty; unbound account and missing clock omitted; no scopes', async () => {
    const bound: ApiKeyOwnershipSnapshot = {
      id: KEY,
      userId: USER,
      revoked: false,
      productScopes: ['trade'],
      originAllowlist: ['app.example.com'],
      domainWhitelist: ['app.example.com'],
      ipAllowlist: ['203.0.113.10'],
      accountId: ACC,
      expiresAt: EXPIRES,
    };
    const app = Fastify({ logger: false });
    registerApiKeyOwnershipRoute(app, { door: doorWith(bound), internalSecret: SECRET, edgeAuthoritySecret: EDGE });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `${API_KEY_OWNERSHIP_PATH}/${KEY}`,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: KEY,
      userId: USER,
      revoked: false,
      productScopes: ['trade'],
      originAllowlist: ['app.example.com'],
      domainWhitelist: ['app.example.com'],
      ipAllowlist: ['203.0.113.10'],
      accountId: ACC,
      expiresAt: EXPIRES.toISOString(),
    });
    expect(body).not.toHaveProperty('scopes');
    await app.close();
  });

  it('empty bind lists stay empty arrays; unbound account and null expiry omitted', async () => {
    const open: ApiKeyOwnershipSnapshot = {
      id: KEY,
      userId: USER,
      revoked: false,
      productScopes: [],
      originAllowlist: [],
      domainWhitelist: [],
      ipAllowlist: [],
    };
    const app = Fastify({ logger: false });
    registerApiKeyOwnershipRoute(app, { door: doorWith(open), internalSecret: SECRET, edgeAuthoritySecret: EDGE });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `${API_KEY_OWNERSHIP_PATH}/${KEY}`,
      headers: serviceHeaders(),
    });
    const body = res.json() as Record<string, unknown>;
    expect(body.productScopes).toEqual([]);
    expect(body.originAllowlist).toEqual([]);
    expect(body.ipAllowlist).toEqual([]);
    expect(body.productScopes).not.toContain('trade');
    expect(body.originAllowlist).not.toContain('localhost');
    expect(body).not.toHaveProperty('accountId');
    expect(body).not.toHaveProperty('expiresAt');
    expect(body).not.toHaveProperty('scopes');
    await app.close();
  });
});
