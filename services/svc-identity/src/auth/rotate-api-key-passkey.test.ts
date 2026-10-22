import { describe, expect, it } from 'vitest';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { rotateApiKeyAfterPasskey } from './rotate-api-key-passkey.js';

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

const rotateInput = { userId: 'u', keyId: 'old', grantorScopes: ['identity:read'] as const };

const enrolled = { credentialId: 'cred-1', publicKey: 'pk', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' };
const verifiedAt = '2026-08-25T00:00:00.000Z';

describe('rotateApiKeyAfterPasskey', () => {
  it('refuses a missing passkey and does not mint or revoke', async () => {
    const { minter, created, revoked } = makeMinter();
    await expect(rotateApiKeyAfterPasskey(minter, fakeSql([[{ webauthn_creds: [] }]]), rotateInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    await expect(rotateApiKeyAfterPasskey(minter, fakeSql([[{ webauthn_creds: null }]]), rotateInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('refuses creds without lastVerifiedAt and does not mint', async () => {
    const { minter, created, revoked } = makeMinter();
    await expect(rotateApiKeyAfterPasskey(minter, fakeSql([[{ webauthn_creds: [enrolled] }]]), rotateInput)).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('rotates through AuthService when lastVerifiedAt is persisted', async () => {
    const { minter, created, revoked } = makeMinter();
    const out = await rotateApiKeyAfterPasskey(
      minter,
      fakeSql([[{ webauthn_creds: [{ ...enrolled, lastVerifiedAt: verifiedAt }] }], [oldRow]]),
      rotateInput,
    );
    expect(out).toEqual({
      id: 'k1',
      key: 'ifk_live_secret',
      prefix: 'ifk_live',
      mode: 'live',
      revokedKeyId: 'old',
    });
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(['old']);
  });

  it('treats a missing user as not found and does not mint', async () => {
    const { minter, created, revoked } = makeMinter();
    await expect(rotateApiKeyAfterPasskey(minter, fakeSql([[]]), rotateInput)).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });
});
