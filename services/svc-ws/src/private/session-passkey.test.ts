import { describe, expect, it } from 'vitest';
import { SERVICE_BODY_DIGEST_HEADER, serviceAuthHeaders, serviceBodyDigest, verifyServiceHeaders } from '@intafaced/contracts';
import {
  SessionPasskeyError,
  assertIdentitySessionPasskey,
  assertSessionPasskey,
  optionalLastVerifiedAt,
  optionalPasskeyCreds,
} from './session-passkey.js';

const USER = '11111111-1111-4111-8111-111111111111';
const VERIFIED = '2026-08-25T00:00:00.000Z';

describe('assertSessionPasskey', () => {
  it('enrolled + lastVerifiedAt may keep the stream open', () => {
    expect(() =>
      assertSessionPasskey({
        userId: USER,
        webauthnCreds: [{ credentialId: 'cred-1', lastVerifiedAt: VERIFIED }],
      }),
    ).not.toThrow();
    expect(optionalLastVerifiedAt({ lastVerifiedAt: VERIFIED })).toBe(VERIFIED);
  });

  it('empty webauthn_creds cannot keep the stream open', () => {
    try {
      assertSessionPasskey({ userId: USER, webauthn_creds: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_missing');
    }
  });

  it('missing creds/lastVerifiedAt refuses verify unavailable', () => {
    try {
      assertSessionPasskey({ userId: USER, status: 'active' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
    expect(optionalPasskeyCreds({ userId: USER })).toBeUndefined();
  });

  it('creds without lastVerifiedAt refuses (no invented challenge)', () => {
    try {
      assertSessionPasskey({ userId: USER, webauthnCreds: [{ credentialId: 'cred-1' }] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
  });

  it('passkeyVerified true may keep the stream open', () => {
    expect(() => assertSessionPasskey({ userId: USER, passkeyVerified: true })).not.toThrow();
  });

  it('verified true on the body may keep the stream open', () => {
    expect(() => assertSessionPasskey({ userId: USER, verified: true })).not.toThrow();
  });

  it('root last_verified_at may keep the stream open', () => {
    expect(() => assertSessionPasskey({ userId: USER, last_verified_at: VERIFIED })).not.toThrow();
  });

  it('walks a tRPC envelope', () => {
    expect(() => assertSessionPasskey({ result: { data: { json: { lastVerifiedAt: VERIFIED } } } })).not.toThrow();
  });
});

describe('assertIdentitySessionPasskey', () => {
  const options = {
    identityUrl: 'http://identity.test',
    userId: USER,
    identityOwnershipSecret: 'ws-test-identity-ownership-secret-32',
  };

  it('200 with lastVerifiedAt proceeds', async () => {
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () =>
          new Response(JSON.stringify({ userId: USER, lastVerifiedAt: VERIFIED }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toBeUndefined();
  });

  it('sends svc-ws v2 headers bound to the empty GET body (not svc-edge, not v1)', async () => {
    const seen: Record<string, string>[] = [];
    await assertIdentitySessionPasskey({
      ...options,
      fetch: async (_input, init) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response(JSON.stringify({ userId: USER, lastVerifiedAt: VERIFIED }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const headers = seen[0]!;
    expect(headers['x-intafaced-service']).toBe('svc-ws');
    expect(JSON.stringify(headers)).not.toMatch(/svc-edge/);
    expect(headers[SERVICE_BODY_DIGEST_HEADER]).toBe(serviceBodyDigest(''));
    expect(
      verifyServiceHeaders(headers, options.identityOwnershipSecret, {
        rawBody: { retained: true, bytes: Buffer.from('') },
        mode: 'require',
      }),
    ).toEqual({ service: 'svc-ws', rejected: null, scheme: 'v2' });
    expect(headers[SERVICE_BODY_DIGEST_HEADER]).not.toBe(
      serviceAuthHeaders('svc-ws', options.identityOwnershipSecret)[SERVICE_BODY_DIGEST_HEADER],
    );
    expect(serviceAuthHeaders('svc-ws', options.identityOwnershipSecret)[SERVICE_BODY_DIGEST_HEADER]).toBeUndefined();
  });

  it('500 / 401 / 403 / 404 / network refuse verify unavailable', async () => {
    for (const status of [500, 401, 403, 404]) {
      await expect(
        assertIdentitySessionPasskey({
          ...options,
          fetch: async () => new Response('nope', { status }),
        }),
      ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () => {
          throw new Error('network');
        },
      }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
  });

  it('userId mismatch refuses', async () => {
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () =>
          new Response(JSON.stringify({ userId: '99999999-9999-4999-8999-999999999999', lastVerifiedAt: VERIFIED }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
  });

  it('tRPC envelope for a different user does not keep the stream open', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () =>
          new Response(
            JSON.stringify({
              result: { data: { json: { userId: other, lastVerifiedAt: VERIFIED } } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
  });

  it('tRPC envelope for the requested user with an honest passkey keeps the stream open', async () => {
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () =>
          new Response(
            JSON.stringify({
              result: { data: { json: { userId: USER, lastVerifiedAt: VERIFIED } } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      }),
    ).resolves.toBeUndefined();
  });

  it('missing userId on the request refuses', async () => {
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        userId: '   ',
        fetch: async () =>
          new Response(JSON.stringify({ userId: USER, lastVerifiedAt: VERIFIED }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
  });

  it('empty creds cannot keep the stream open', async () => {
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () =>
          new Response(JSON.stringify({ userId: USER, webauthnCreds: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.passkey_missing' });
  });

  it('bad JSON is verify unavailable', async () => {
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () => new Response('not-json', { status: 200 }),
      }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
  });
});
