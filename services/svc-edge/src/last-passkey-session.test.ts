import { describe, expect, it, vi } from 'vitest';
import { lastPasskeyUnenrollClosesSession } from './last-passkey-session.js';
import { PASSKEY_BODIES, VERIFIED_PASSKEY_BODY, outcomeOf } from './testing/session-door-cases-fixture.js';
import { SessionPasskeyError, assertIdentitySessionPasskey, assertSessionPasskey } from './session-passkey.js';

const USER = '11111111-1111-4111-8111-111111111111';
const VERIFIED = '2026-08-25T00:00:00.000Z';

const LAST_VERIFIED = {
  userId: USER,
  webauthnCreds: [{ credentialId: 'cred-2', lastVerifiedAt: VERIFIED }],
};

const options = {
  identityUrl: 'http://identity.test',
  userId: USER,
  identityOwnershipSecret: 'edge-test-identity-ownership-secret-32',
};

describe('lastPasskeyUnenrollClosesSession — last enrolled passkey unenrolled', () => {
  it('last remaining verified cred still keeps the existing session', async () => {
    expect(() => lastPasskeyUnenrollClosesSession(LAST_VERIFIED)).not.toThrow();
    expect(() => assertSessionPasskey(LAST_VERIFIED)).not.toThrow();
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () =>
          new Response(JSON.stringify(LAST_VERIFIED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toBeUndefined();
  });

  it('last cred without lastVerifiedAt is auth.passkey_verify_unavailable', () => {
    const lastUnverified = { userId: USER, webauthnCreds: [{ credentialId: 'cred-2' }] };
    try {
      lastPasskeyUnenrollClosesSession(lastUnverified);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
    try {
      assertSessionPasskey(lastUnverified);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
  });

  it('empty after last unenroll is auth.passkey_missing', () => {
    const empty = { userId: USER, webauthnCreds: [] };
    try {
      lastPasskeyUnenrollClosesSession(empty);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_missing');
    }
    try {
      assertSessionPasskey(empty);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_missing');
    }
  });

  it('answers every passkey body as assertSessionPasskey does; no invented challenge or session', async () => {
    // The module is this one door and nothing else: no challenge, no session, no second door beside it.
    const module = await import('./last-passkey-session.js');
    expect(Object.keys(module)).toEqual(['lastPasskeyUnenrollClosesSession']);
    // It answers every body identity can send exactly as assertSessionPasskey does, synchronously, asking nobody.
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      for (const body of PASSKEY_BODIES) {
        expect(
          outcomeOf(() => lastPasskeyUnenrollClosesSession(body)),
          JSON.stringify(body),
        ).toEqual(outcomeOf(() => assertSessionPasskey(body)));
      }
      expect(outcomeOf(() => lastPasskeyUnenrollClosesSession(VERIFIED_PASSKEY_BODY))).toEqual({ returned: undefined });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
