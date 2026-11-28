import { describe, expect, it } from 'vitest';
import { lastPasskeyUnenrollDropsStream } from './last-passkey-stream.js';
import { SessionPasskeyError, assertSessionPasskey } from './session-passkey.js';
import { assertLiveCredential, type LiveCredentialPort, type OwnershipSnapshot } from './live-credential.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VERIFIED = '2026-08-25T00:00:00.000Z';
const SECRET = 'ws-test-identity-ownership-secret-32';

const LIVE: OwnershipSnapshot = { id: SESSION, userId: USER, revoked: false };
const LIVE_KEY: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };

const LAST_VERIFIED = {
  userId: USER,
  webauthnCreds: [{ credentialId: 'cred-2', lastVerifiedAt: VERIFIED }],
};
const EMPTY = { userId: USER, webauthnCreds: [] };

function port(account: unknown, http = 200): LiveCredentialPort {
  return {
    async getSession() {
      return LIVE;
    },
    async getApiKey() {
      return LIVE_KEY;
    },
    sessionPasskey: {
      identityUrl: 'http://identity.test',
      identityOwnershipSecret: SECRET,
      fetch: async () =>
        new Response(typeof account === 'string' ? account : JSON.stringify(account), {
          status: http,
          headers: { 'content-type': 'application/json' },
        }),
    },
  };
}

describe('lastPasskeyUnenrollDropsStream — last enrolled passkey unenrolled', () => {
  it('last remaining verified cred still keeps the existing session', async () => {
    expect(() => lastPasskeyUnenrollDropsStream(LAST_VERIFIED)).not.toThrow();
    expect(() => assertSessionPasskey(LAST_VERIFIED)).not.toThrow();
    await expect(assertLiveCredential(port(LAST_VERIFIED), { userId: USER, sessionId: SESSION })).resolves.toEqual({
      id: SESSION,
      userId: USER,
      revoked: false,
    });
  });

  it('empty after last unenroll is auth.passkey_missing', async () => {
    try {
      lastPasskeyUnenrollDropsStream(EMPTY);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_missing');
    }
    try {
      assertSessionPasskey(EMPTY);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_missing');
    }
    await expect(assertLiveCredential(port(EMPTY), { userId: USER, sessionId: SESSION })).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
  });

  it('answers exactly as assertSessionPasskey on every account body; no invented challenge or session; no invented challenge or session', () => {
    const bodies: unknown[] = [
      { userId: USER, webauthnCreds: [{ credentialId: 'cred-1', lastVerifiedAt: VERIFIED }] },
      { result: { data: { json: { userId: USER, webauthnCreds: [{ credentialId: 'cred-2', lastVerifiedAt: VERIFIED }] } } } },
      { userId: USER, webauthnCreds: [] },
      { userId: USER, webauthnCreds: [{ credentialId: 'cred-unverified' }] },
      { userId: USER, passkeyVerified: false, webauthnCreds: [{ credentialId: 'cred-4', lastVerifiedAt: VERIFIED }] },
      { userId: USER },
      null,
      'not-an-account',
    ];
    const outcome = (check: (body: unknown) => void, body: unknown) => {
      try {
        return { ok: check(body) === undefined };
      } catch (err) {
        return { error: err instanceof SessionPasskeyError ? err.code : String(err) };
      }
    };
    for (const body of bodies) {
      expect(outcome(lastPasskeyUnenrollDropsStream, body)).toEqual(outcome(assertSessionPasskey, body));
    }
    expect(outcome(lastPasskeyUnenrollDropsStream, bodies[0])).toEqual({ ok: true });
    expect(outcome(lastPasskeyUnenrollDropsStream, bodies[2])).toEqual({ error: 'auth.passkey_missing' });
    // It takes only the account body and returns nothing: no port to mint a challenge or write a session.
    expect(lastPasskeyUnenrollDropsStream.length).toBe(1);
  });
});
