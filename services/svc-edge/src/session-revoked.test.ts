import { describe, expect, it } from 'vitest';
import { serviceBodyDigest } from '@intafaced/contracts';
import {
  assertIdentitySessionLive,
  assertSessionNotRevoked,
  optionalSessionRevoked,
  optionalSessionRevokedFromExchange,
  sessionIsRevoked,
  SessionRevokedError,
} from './session-revoked.js';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SECRET = 'edge-test-identity-ownership-secret-32';

describe('optionalSessionRevoked', () => {
  it('reads boolean revoked; never invents a revoke', () => {
    expect(optionalSessionRevoked({ revoked: true })).toBe(true);
    expect(optionalSessionRevoked({ revoked: false })).toBe(false);
    expect(optionalSessionRevoked({ id: SESSION })).toBeUndefined();
    expect(optionalSessionRevoked({ revoked: 'true' })).toBeUndefined();
    expect(optionalSessionRevoked(null)).toBeUndefined();
  });
});

describe('optionalSessionRevokedFromExchange', () => {
  it('reads tRPC envelope or bare body', () => {
    expect(optionalSessionRevokedFromExchange({ result: { data: { json: { revoked: true } } } })).toBe(true);
    expect(optionalSessionRevokedFromExchange({ result: { data: { revoked: false } } })).toBe(false);
    expect(optionalSessionRevokedFromExchange({ revoked: true })).toBe(true);
    expect(optionalSessionRevokedFromExchange({ accessToken: 'x' })).toBeUndefined();
  });
});

describe('sessionIsRevoked / assertSessionNotRevoked', () => {
  it('revoked refuses; missing and false stay open', () => {
    expect(sessionIsRevoked(true)).toBe(true);
    expect(sessionIsRevoked(false)).toBe(false);
    expect(sessionIsRevoked(undefined)).toBe(false);
    expect(sessionIsRevoked(null)).toBe(false);
    expect(() => assertSessionNotRevoked(true)).toThrow(SessionRevokedError);
    try {
      assertSessionNotRevoked(true);
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.session_revoked' });
    }
    expect(() => assertSessionNotRevoked(false)).not.toThrow();
    expect(() => assertSessionNotRevoked(undefined)).not.toThrow();
  });
});

describe('assertIdentitySessionLive', () => {
  it('active proceeds; revoked cannot', async () => {
    await expect(
      assertIdentitySessionLive({
        identityUrl: 'http://identity.test',
        sessionId: SESSION,
        userId: USER,
        identityOwnershipSecret: SECRET,
        fetch: async () =>
          new Response(JSON.stringify({ id: SESSION, userId: USER, revoked: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertIdentitySessionLive({
        identityUrl: 'http://identity.test',
        sessionId: SESSION,
        userId: USER,
        identityOwnershipSecret: SECRET,
        fetch: async () =>
          new Response(JSON.stringify({ id: SESSION, userId: USER, revoked: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.session_revoked' });
  });

  it('GETs /internal/sessions/:id with svc-edge ownership headers, never INTERNAL_SERVICE_SECRET', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await assertIdentitySessionLive({
      identityUrl: 'http://identity.test/',
      sessionId: SESSION,
      userId: USER,
      identityOwnershipSecret: SECRET,
      fetch: async (input, init) => {
        seen.url = String(input);
        seen.headers = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: SESSION, userId: USER, revoked: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(seen.url).toBe(`http://identity.test/internal/sessions/${SESSION}`);
    expect(seen.headers?.get('x-intafaced-service')).toBe('svc-edge');
    expect(seen.headers?.get('x-intafaced-service-sig')).toBeTruthy();
    expect(seen.headers?.get('x-intafaced-service-body')).toBe(serviceBodyDigest(''));
    expect(seen.headers?.get('authorization')).toBeNull();
  });

  it('404, 401, mismatch, and transport cannot open as live', async () => {
    const base = {
      identityUrl: 'http://identity.test',
      sessionId: SESSION,
      userId: USER,
      identityOwnershipSecret: SECRET,
    };
    await expect(assertIdentitySessionLive({ ...base, fetch: async () => new Response(null, { status: 404 }) })).rejects.toMatchObject({
      code: 'auth.session_denied',
    });
    await expect(assertIdentitySessionLive({ ...base, fetch: async () => new Response(null, { status: 401 }) })).rejects.toMatchObject({
      code: 'auth.session_denied',
    });
    await expect(
      assertIdentitySessionLive({
        ...base,
        fetch: async () =>
          new Response(JSON.stringify({ id: SESSION, userId: OTHER, revoked: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.session_denied' });
    await expect(
      assertIdentitySessionLive({
        ...base,
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toMatchObject({ code: 'auth.session_denied' });
  });
});
