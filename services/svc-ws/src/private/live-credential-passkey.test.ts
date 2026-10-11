import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLiveCredential, type LiveCredentialPort, type OwnershipSnapshot } from './live-credential.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VERIFIED = '2026-08-25T00:00:00.000Z';
const SECRET = 'ws-test-identity-ownership-secret-32';

const LIVE: OwnershipSnapshot = { id: SESSION, userId: USER, revoked: false };
const LIVE_KEY: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };

function port(account: unknown, http = 200, opts?: { identityUrl?: string; secret?: string }): LiveCredentialPort {
  return {
    async getSession() {
      return LIVE;
    },
    async getApiKey() {
      return LIVE_KEY;
    },
    sessionPasskey: {
      identityUrl: opts?.identityUrl ?? 'http://identity.test',
      identityOwnershipSecret: opts?.secret ?? SECRET,
      fetch: async () =>
        new Response(typeof account === 'string' ? account : JSON.stringify(account), {
          status: http,
          headers: { 'content-type': 'application/json' },
        }),
    },
  };
}

describe('assertLiveCredential — session passkey', () => {
  it('lastVerifiedAt stays live', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, lastVerifiedAt: VERIFIED }), { userId: USER, sessionId: SESSION }),
    ).resolves.toEqual({ id: SESSION, userId: USER, revoked: false });
  });

  it('empty creds is auth.passkey_missing', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, webauthnCreds: [] }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.passkey_missing' });
  });

  it('missing extras is auth.passkey_verify_unavailable', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, status: 'active' }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.passkey_verify_unavailable' });
  });

  it('identity 500 is verify unavailable', async () => {
    await expect(assertLiveCredential(port({}, 500), { userId: USER, sessionId: SESSION })).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
  });

  it('API-key seats ignore the passkey door', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, webauthnCreds: [] }), {
        userId: USER,
        sessionId: SESSION,
        apiKeyId: KEY,
      }),
    ).resolves.toEqual({ id: KEY, userId: USER, revoked: false });
  });

  it('missing sessionPasskey stays on live-check (no invented passkey check)', async () => {
    const bare: LiveCredentialPort = {
      async getSession() {
        return LIVE;
      },
      async getApiKey() {
        return LIVE_KEY;
      },
    };
    await expect(assertLiveCredential(bare, { userId: USER, sessionId: SESSION })).resolves.toEqual({
      id: SESSION,
      userId: USER,
      revoked: false,
    });
  });

  it('blank identity URL skips the passkey door', async () => {
    await expect(
      assertLiveCredential(port({ userId: USER, webauthnCreds: [] }, 200, { identityUrl: '  ' }), {
        userId: USER,
        sessionId: SESSION,
      }),
    ).resolves.toEqual({ id: SESSION, userId: USER, revoked: false });
  });
});

describe('production session authority', () => {
  it('uses live identity authority while retaining passkey checks for explicit adapters', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(src).not.toMatch(/sessionPasskey:/);
    expect(src).toMatch(/createIdentityAuthorityClient/);
    expect(src).toMatch(/IDENTITY_OWNERSHIP_SECRET/);
    expect(src).not.toMatch(/serviceAuthHeaders\(/);
    expect(src).not.toMatch(/process\.env\.INTERNAL_SERVICE_SECRET/);
  });
});
