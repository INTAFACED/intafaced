import { describe, expect, it, vi } from 'vitest';
import { remainingPasskeyOpensSession } from './remaining-passkey-session.js';
import { PASSKEY_BODIES, VERIFIED_PASSKEY_BODY, outcomeOf } from './testing/session-door-cases-fixture.js';
import { SessionPasskeyError, assertIdentitySessionPasskey, assertSessionPasskey } from './session-passkey.js';

const USER = '11111111-1111-4111-8111-111111111111';
const VERIFIED = '2026-08-25T00:00:00.000Z';

const REMAINING_VERIFIED = {
  userId: USER,
  webauthnCreds: [{ credentialId: 'cred-2', lastVerifiedAt: VERIFIED }],
};

const options = {
  identityUrl: 'http://identity.test',
  userId: USER,
  identityOwnershipSecret: 'edge-test-identity-ownership-secret-32',
};

describe('remainingPasskeyOpensSession — unenroll first of two', () => {
  it('remaining verified cred opens the session; no new session minted', async () => {
    expect(() => remainingPasskeyOpensSession(REMAINING_VERIFIED)).not.toThrow();
    expect(() => assertSessionPasskey(REMAINING_VERIFIED)).not.toThrow();
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () =>
          new Response(JSON.stringify(REMAINING_VERIFIED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toBeUndefined();
  });

  it('remaining cred without lastVerifiedAt is auth.passkey_verify_unavailable', () => {
    const remainingUnverified = { userId: USER, webauthnCreds: [{ credentialId: 'cred-2' }] };
    try {
      remainingPasskeyOpensSession(remainingUnverified);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
    try {
      assertSessionPasskey(remainingUnverified);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
  });

  it('empty remaining creds is auth.passkey_missing', () => {
    const empty = { userId: USER, webauthnCreds: [] };
    try {
      remainingPasskeyOpensSession(empty);
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
    const module = await import('./remaining-passkey-session.js');
    expect(Object.keys(module)).toEqual(['remainingPasskeyOpensSession']);
    // It answers every body identity can send exactly as assertSessionPasskey does, synchronously, asking nobody.
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      for (const body of PASSKEY_BODIES) {
        expect(
          outcomeOf(() => remainingPasskeyOpensSession(body)),
          JSON.stringify(body),
        ).toEqual(outcomeOf(() => assertSessionPasskey(body)));
      }
      expect(outcomeOf(() => remainingPasskeyOpensSession(VERIFIED_PASSKEY_BODY))).toEqual({ returned: undefined });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
