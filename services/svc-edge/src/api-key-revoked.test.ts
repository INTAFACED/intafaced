import { describe, expect, it } from 'vitest';
import { serviceBodyDigest } from '@intafaced/contracts';
import {
  assertApiKeyNotRevoked,
  assertIdentityApiKeyLive,
  apiKeyIsRevoked,
  ApiKeyRevokedError,
  optionalApiKeyRevoked,
  optionalApiKeyRevokedFromExchange,
} from './api-key-revoked.js';

const USER = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const SECRET = 'edge-test-identity-ownership-secret-32';

describe('optionalApiKeyRevoked', () => {
  it('reads boolean revoked; never invents a revoke', () => {
    expect(optionalApiKeyRevoked({ revoked: true })).toBe(true);
    expect(optionalApiKeyRevoked({ revoked: false })).toBe(false);
    expect(optionalApiKeyRevoked({ id: KEY })).toBeUndefined();
    expect(optionalApiKeyRevoked({ revoked: 'true' })).toBeUndefined();
    expect(optionalApiKeyRevoked(null)).toBeUndefined();
  });
});

describe('optionalApiKeyRevokedFromExchange', () => {
  it('reads tRPC envelope or bare body', () => {
    expect(optionalApiKeyRevokedFromExchange({ result: { data: { json: { revoked: true } } } })).toBe(true);
    expect(optionalApiKeyRevokedFromExchange({ result: { data: { revoked: false } } })).toBe(false);
    expect(optionalApiKeyRevokedFromExchange({ revoked: true })).toBe(true);
    expect(optionalApiKeyRevokedFromExchange({ accessToken: 'x' })).toBeUndefined();
  });
});

describe('apiKeyIsRevoked / assertApiKeyNotRevoked', () => {
  it('revoked refuses; missing and false stay open', () => {
    expect(apiKeyIsRevoked(true)).toBe(true);
    expect(apiKeyIsRevoked(false)).toBe(false);
    expect(apiKeyIsRevoked(undefined)).toBe(false);
    expect(apiKeyIsRevoked(null)).toBe(false);
    expect(() => assertApiKeyNotRevoked(true)).toThrow(ApiKeyRevokedError);
    try {
      assertApiKeyNotRevoked(true);
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.api_key_revoked' });
    }
    expect(() => assertApiKeyNotRevoked(false)).not.toThrow();
    expect(() => assertApiKeyNotRevoked(undefined)).not.toThrow();
  });
});

describe('assertIdentityApiKeyLive', () => {
  it('active proceeds; revoked cannot', async () => {
    await expect(
      assertIdentityApiKeyLive({
        identityUrl: 'http://identity.test',
        apiKeyId: KEY,
        userId: USER,
        identityOwnershipSecret: SECRET,
        fetch: async () =>
          new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toMatchObject({ id: KEY, userId: USER, revoked: false });

    await expect(
      assertIdentityApiKeyLive({
        identityUrl: 'http://identity.test',
        apiKeyId: KEY,
        userId: USER,
        identityOwnershipSecret: SECRET,
        fetch: async () =>
          new Response(JSON.stringify({ id: KEY, userId: USER, revoked: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.api_key_revoked' });
  });

  it('GETs /internal/api-keys/:id with svc-edge ownership headers, never INTERNAL_SERVICE_SECRET', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await assertIdentityApiKeyLive({
      identityUrl: 'http://identity.test/',
      apiKeyId: KEY,
      userId: USER,
      identityOwnershipSecret: SECRET,
      fetch: async (input, init) => {
        seen.url = String(input);
        seen.headers = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(seen.url).toBe(`http://identity.test/internal/api-keys/${KEY}`);
    expect(seen.headers?.get('x-intafaced-service')).toBe('svc-edge');
    expect(seen.headers?.get('x-intafaced-service-sig')).toBeTruthy();
    expect(seen.headers?.get('x-intafaced-service-body')).toBe(serviceBodyDigest(''));
    expect(seen.headers?.get('authorization')).toBeNull();
  });

  it('404, 401, 403, mismatch, and transport cannot open as live', async () => {
    const base = {
      identityUrl: 'http://identity.test',
      apiKeyId: KEY,
      userId: USER,
      identityOwnershipSecret: SECRET,
    };
    await expect(assertIdentityApiKeyLive({ ...base, fetch: async () => new Response(null, { status: 404 }) })).rejects.toMatchObject({
      code: 'auth.api_key_denied',
    });
    await expect(assertIdentityApiKeyLive({ ...base, fetch: async () => new Response(null, { status: 401 }) })).rejects.toMatchObject({
      code: 'auth.api_key_denied',
    });
    await expect(assertIdentityApiKeyLive({ ...base, fetch: async () => new Response(null, { status: 403 }) })).rejects.toMatchObject({
      code: 'auth.api_key_denied',
    });
    await expect(
      assertIdentityApiKeyLive({
        ...base,
        fetch: async () =>
          new Response(JSON.stringify({ id: KEY, userId: OTHER, revoked: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.api_key_denied' });
    await expect(
      assertIdentityApiKeyLive({
        ...base,
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toMatchObject({ code: 'auth.api_key_denied' });
  });
});
