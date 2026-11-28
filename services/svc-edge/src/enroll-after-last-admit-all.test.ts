import { describe, expect, it, vi } from 'vitest';
import { newlyEnrolledPasskeyAdmitsAllRequests } from './enroll-after-last-admit-all.js';
import { PASSKEY_BODIES, VERIFIED_PASSKEY_BODY, outcomeOf } from './testing/session-door-cases-fixture.js';
import { SessionPasskeyError, assertIdentitySessionPasskey, assertSessionPasskey } from './session-passkey.js';

const USER = '11111111-1111-4111-8111-111111111111';
const VERIFIED = '2026-08-25T00:00:00.000Z';

const ENROLLED_AGAIN = {
  userId: USER,
  webauthnCreds: [{ credentialId: 'cred-3', lastVerifiedAt: VERIFIED }],
};

const options = {
  identityUrl: 'http://identity.test',
  userId: USER,
  identityOwnershipSecret: 'edge-test-identity-ownership-secret-32',
};

describe('newlyEnrolledPasskeyAdmitsAllRequests — enroll after last unenroll', () => {
  it('newly enrolled verified cred admits every private request', async () => {
    expect(() => newlyEnrolledPasskeyAdmitsAllRequests(ENROLLED_AGAIN)).not.toThrow();
    expect(() => assertSessionPasskey(ENROLLED_AGAIN)).not.toThrow();
    const fetchOk = async () =>
      new Response(JSON.stringify(ENROLLED_AGAIN), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(assertIdentitySessionPasskey({ ...options, fetch: fetchOk })).resolves.toBeUndefined();
    await expect(assertIdentitySessionPasskey({ ...options, fetch: fetchOk })).resolves.toBeUndefined();
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable', () => {
    const enrolledUnverified = { userId: USER, webauthnCreds: [{ credentialId: 'cred-3' }] };
    try {
      newlyEnrolledPasskeyAdmitsAllRequests(enrolledUnverified);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
    try {
      assertSessionPasskey(enrolledUnverified);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
  });

  it('empty after last unenroll is auth.passkey_missing', () => {
    const empty = { userId: USER, webauthnCreds: [] };
    try {
      newlyEnrolledPasskeyAdmitsAllRequests(empty);
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

  it('answers every passkey body as assertSessionPasskey does; no invented challenge or session; not one-request admit', async () => {
    // The module is this one door and nothing else: no challenge, no session, no second door beside it.
    const module = await import('./enroll-after-last-admit-all.js');
    expect(Object.keys(module)).toEqual(['newlyEnrolledPasskeyAdmitsAllRequests']);
    expect(module).not.toHaveProperty('newlyEnrolledPasskeyAdmitsRequest');
    // It answers every body identity can send exactly as assertSessionPasskey does, synchronously, asking nobody.
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      for (const body of PASSKEY_BODIES) {
        expect(
          outcomeOf(() => newlyEnrolledPasskeyAdmitsAllRequests(body)),
          JSON.stringify(body),
        ).toEqual(outcomeOf(() => assertSessionPasskey(body)));
      }
      expect(outcomeOf(() => newlyEnrolledPasskeyAdmitsAllRequests(VERIFIED_PASSKEY_BODY))).toEqual({ returned: undefined });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
