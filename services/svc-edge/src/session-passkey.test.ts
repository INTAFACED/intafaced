import { describe, expect, it } from 'vitest';
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
  it('enrolled + lastVerifiedAt places', () => {
    expect(() =>
      assertSessionPasskey({
        userId: USER,
        webauthnCreds: [{ credentialId: 'cred-1', lastVerifiedAt: VERIFIED }],
      }),
    ).not.toThrow();
    expect(optionalLastVerifiedAt({ lastVerifiedAt: VERIFIED })).toBe(VERIFIED);
  });

  it('empty webauthn_creds cannot place', () => {
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

  it('passkeyVerified true places', () => {
    expect(() => assertSessionPasskey({ userId: USER, passkeyVerified: true })).not.toThrow();
  });

  it('walks a tRPC envelope', () => {
    expect(() => assertSessionPasskey({ result: { data: { json: { lastVerifiedAt: VERIFIED } } } })).not.toThrow();
  });
});

describe('assertIdentitySessionPasskey', () => {
  const options = {
    identityUrl: 'http://identity.test',
    userId: USER,
    identityOwnershipSecret: 'edge-test-identity-ownership-secret-32',
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

  it('500 / 401 / network refuse verify unavailable', async () => {
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () => new Response('nope', { status: 500 }),
      }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () => new Response('nope', { status: 401 }),
      }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
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

  it('empty creds cannot place', async () => {
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
});
