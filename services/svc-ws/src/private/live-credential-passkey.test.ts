import { describe, expect, it } from 'vitest';
import {
  assertLiveCredential,
  createIdentityOwnershipClient,
  type AccountStatusSnapshot,
  type LiveCredentialPort,
  type OwnershipSnapshot,
} from './live-credential.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VERIFIED = '2026-08-25T00:00:00.000Z';

const LIVE: OwnershipSnapshot = { id: SESSION, userId: USER, revoked: false };
const LIVE_KEY: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };

function port(account: AccountStatusSnapshot | null | undefined, opts?: { skipAccount?: boolean }): LiveCredentialPort {
  return {
    async getSession() {
      return LIVE;
    },
    async getApiKey() {
      return LIVE_KEY;
    },
    ...(opts?.skipAccount
      ? {}
      : {
          async getAccount() {
            return account === undefined ? { userId: USER, status: 'active' } : account;
          },
        }),
  };
}

describe('assertLiveCredential — session passkey extras', () => {
  it('session + lastVerifiedAt stays live', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, status: 'active', lastVerifiedAt: VERIFIED }), { userId: USER, sessionId: SESSION }),
    ).resolves.toEqual({ id: SESSION, userId: USER, revoked: false });
  });

  it('session + empty creds is auth.passkey_missing', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, status: 'active', webauthnCreds: [] }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.passkey_missing' });
  });

  it('session + no extras is auth.passkey_verify_unavailable', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, status: 'active' }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
  });

  it('key seat with getAccount but no extras still live', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, status: 'active' }), { userId: USER, sessionId: SESSION, apiKeyId: KEY }),
    ).resolves.toEqual({ id: KEY, userId: USER, revoked: false });
  });

  it('skipAccount session still live', async () => {
    await expect(assertLiveCredential(port(undefined, { skipAccount: true }), { userId: USER, sessionId: SESSION })).resolves.toEqual({
      id: SESSION,
      userId: USER,
      revoked: false,
    });
  });
});

describe('createIdentityOwnershipClient — optional passkey extras', () => {
  it('keeps extras from the account body; omits when absent', async () => {
    const withExtras = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () =>
        new Response(
          JSON.stringify({ userId: USER, status: 'active', kycTier: 'none', lastVerifiedAt: VERIFIED, webauthnCreds: [{ id: 'c1' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    });
    await expect(withExtras.getAccount!(USER)).resolves.toEqual({
      userId: USER,
      status: 'active',
      lastVerifiedAt: VERIFIED,
      webauthnCreds: [{ id: 'c1' }],
    });

    const bare = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () =>
        new Response(JSON.stringify({ userId: USER, status: 'active', kycTier: 'none' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const row = await bare.getAccount!(USER);
    expect(row).toEqual({ userId: USER, status: 'active' });
    expect(row && 'lastVerifiedAt' in row).toBe(false);
    expect(row && 'webauthnCreds' in row).toBe(false);
    expect(row && 'passkeyVerified' in row).toBe(false);
  });
});
