import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { rotateApiKeyAfterPasskey } from './rotate-api-key-passkey.js';
import { remainingPasskeyRotates, rotateApiKeyAfterRemainingPasskey } from './remaining-passkey-rotate.js';

function fakeSql(queue: unknown[][]) {
  let i = 0;
  const fn = async () => {
    const rows = queue[i] ?? [];
    i += 1;
    return rows;
  };
  return fn as unknown as Parameters<typeof rotateApiKeyAfterPasskey>[1];
}

function makeMinter() {
  const created: unknown[] = [];
  const revoked: string[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey(input) {
      created.push(input);
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: input.mode ?? 'live' };
    },
    async revokeApiKey(_userId, keyId) {
      revoked.push(keyId);
      return true;
    },
  };
  return { minter, created, revoked };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const verifiedAt = '2026-08-25T00:00:00.000Z';
const remaining = {
  credentialId: 'cred-2',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T00:00:00.000Z',
  lastVerifiedAt: verifiedAt,
};
const remainingUnverified = { credentialId: 'cred-2', publicKey: 'pk', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' };
const oldRow = {
  id: 'old',
  name: 'desk',
  scopes: ['identity:read'],
  domain_whitelist: [],
  expires_at: null,
  mode: 'live',
  ip_allowlist: [],
  account_id: null,
};
const rotateInput = { userId: A, keyId: 'old', grantorScopes: ['identity:read'] as const };

describe('remainingPasskeyRotates — unenroll first of two', () => {
  it('remaining verified cred rotates; no invented challenge', async () => {
    expect(() => remainingPasskeyRotates([remaining])).not.toThrow();
    expect(() => requireVerifiedPasskey([remaining])).not.toThrow();
    const { minter, created, revoked } = makeMinter();
    await expect(
      rotateApiKeyAfterRemainingPasskey(minter, fakeSql([[{ webauthn_creds: [remaining] }], [oldRow]]), rotateInput),
    ).resolves.toEqual({
      id: 'k1',
      key: 'ifk_live_secret',
      prefix: 'ifk_live',
      mode: 'live',
      revokedKeyId: 'old',
    });
    await expect(
      rotateApiKeyAfterPasskey(minter, fakeSql([[{ webauthn_creds: [remaining] }], [oldRow]]), rotateInput),
    ).resolves.toMatchObject({ id: 'k1', revokedKeyId: 'old' });
    expect(created).toHaveLength(2);
    expect(revoked).toEqual(['old', 'old']);
  });

  it('remaining cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not rotate', async () => {
    try {
      remainingPasskeyRotates([remainingUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const { minter, created, revoked } = makeMinter();
    await expect(
      rotateApiKeyAfterRemainingPasskey(minter, fakeSql([[{ webauthn_creds: [remainingUnverified] }]]), rotateInput),
    ).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('empty remaining creds is auth.passkey_missing and does not rotate', async () => {
    try {
      remainingPasskeyRotates([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const { minter, created, revoked } = makeMinter();
    await expect(rotateApiKeyAfterRemainingPasskey(minter, fakeSql([[{ webauthn_creds: [] }]]), rotateInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('source reuses requireVerifiedPasskey and rotateApiKeyAfterPasskey; no invented challenge', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'remaining-passkey-rotate.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).toMatch(/rotateApiKeyAfterPasskey/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
