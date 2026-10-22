import { describe, expect, it } from 'vitest';
import {
  assertLiveCredential,
  createIdentityOwnershipClient,
  optionalUserStatusFromBody,
  type AccountStatusSnapshot,
  type LiveCredentialPort,
  type OwnershipSnapshot,
} from './live-credential.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const LIVE: OwnershipSnapshot = { id: SESSION, userId: USER, revoked: false };
const LIVE_KEY: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };
const ACTIVE: AccountStatusSnapshot = { userId: USER, status: 'active', lastVerifiedAt: '2026-08-25T00:00:00.000Z' };

function port(opts: {
  session?: OwnershipSnapshot | null;
  key?: OwnershipSnapshot | null;
  account?: AccountStatusSnapshot | null;
  skipAccount?: boolean;
}): LiveCredentialPort {
  return {
    async getSession() {
      return opts.session === undefined ? LIVE : opts.session;
    },
    async getApiKey() {
      return opts.key === undefined ? LIVE_KEY : opts.key;
    },
    ...(opts.skipAccount
      ? {}
      : {
          async getAccount() {
            return opts.account === undefined ? ACTIVE : opts.account;
          },
        }),
  };
}

describe('assertLiveCredential — identity user status', () => {
  it('active session and key stay live', async () => {
    await expect(assertLiveCredential(port({}), { userId: USER, sessionId: SESSION })).resolves.toEqual({
      id: SESSION,
      userId: USER,
      revoked: false,
    });
    await expect(assertLiveCredential(port({}), { userId: USER, sessionId: SESSION, apiKeyId: KEY })).resolves.toEqual({
      id: KEY,
      userId: USER,
      revoked: false,
    });
  });

  it('frozen and closed refuse both seats as auth.account_frozen, not revoked', async () => {
    await expect(
      assertLiveCredential(port({ account: { userId: USER, status: 'frozen' } }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.account_frozen' });
    await expect(
      assertLiveCredential(port({ account: { userId: USER, status: 'closed' } }), {
        userId: USER,
        sessionId: SESSION,
        apiKeyId: KEY,
      }),
    ).rejects.toMatchObject({ code: 'auth.account_frozen' });
  });

  it('missing account and userId mismatch refuse — never invent active', async () => {
    await expect(assertLiveCredential(port({ account: null }), { userId: USER, sessionId: SESSION })).rejects.toMatchObject({
      code: 'auth.account_frozen',
    });
    await expect(
      assertLiveCredential(port({ account: { userId: OTHER, status: 'active' } }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.account_frozen' });
  });

  it('omitted getAccount stays on the credential-only path', async () => {
    await expect(assertLiveCredential(port({ skipAccount: true }), { userId: USER, sessionId: SESSION })).resolves.toEqual({
      id: SESSION,
      userId: USER,
      revoked: false,
    });
  });
});

describe('optionalUserStatusFromBody', () => {
  it('reads identity status; rejects junk', () => {
    expect(optionalUserStatusFromBody({ status: 'frozen' })).toBe('frozen');
    expect(optionalUserStatusFromBody({ status: 'active' })).toBe('active');
    expect(optionalUserStatusFromBody({ userId: USER })).toBeUndefined();
    expect(optionalUserStatusFromBody({ status: 1 })).toBeUndefined();
    expect(optionalUserStatusFromBody(null)).toBeUndefined();
  });
});

describe('createIdentityOwnershipClient — account status', () => {
  it('GETs /internal/account/:id; keeps published status; 404 is null', async () => {
    const seen: string[] = [];
    const client = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test/',
      headers: { 'x-test': '1' },
      fetch: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ userId: USER, status: 'frozen', kycTier: 'none' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await expect(client.getAccount!(USER)).resolves.toEqual({ userId: USER, status: 'frozen' });
    expect(seen[0]).toBe(`http://identity.test/internal/account/${USER}`);

    const missing = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () => new Response('missing', { status: 404 }),
    });
    await expect(missing.getAccount!(USER)).resolves.toBeNull();
  });

  it('userId mismatch and schema miss are unavailable, not active', async () => {
    const mismatch = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () =>
        new Response(JSON.stringify({ userId: OTHER, status: 'active', kycTier: 'none' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(mismatch.getAccount!(USER)).rejects.toMatchObject({ code: 'unavailable' });

    const bad = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () =>
        new Response(JSON.stringify({ userId: USER, status: 'active' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(bad.getAccount!(USER)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
