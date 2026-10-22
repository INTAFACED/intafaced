import { describe, expect, it } from 'vitest';
import { installPasskeyMintRefuse, lastVerifiedAtOnCreds, mintApiKeyAfterPasskey, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  return fn as unknown as Parameters<typeof mintApiKeyAfterPasskey>[1];
}

function makeMinter() {
  const created: unknown[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey(input) {
      created.push(input);
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: input.mode ?? 'live' };
    },
    async revokeApiKey() {
      return true;
    },
  };
  return { minter, created };
}

const base = {
  userId: 'u',
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'],
};

const enrolled = { credentialId: 'cred-1', publicKey: 'pk', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' };
const verifiedAt = '2026-08-25T00:00:00.000Z';

describe('requireVerifiedPasskey', () => {
  it('refuses empty creds as passkey_missing', () => {
    expect(() => requireVerifiedPasskey([])).toThrow(/No enrolled passkey/);
    expect(() => requireVerifiedPasskey(null)).toThrow(/No enrolled passkey/);
    try {
      requireVerifiedPasskey([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
  });

  it('refuses enrolled creds without lastVerifiedAt as verify unavailable', () => {
    try {
      requireVerifiedPasskey([enrolled]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    expect(lastVerifiedAtOnCreds([enrolled])).toBeUndefined();
  });

  it('allows a cred with lastVerifiedAt and does not invent a challenge', () => {
    expect(() => requireVerifiedPasskey([{ ...enrolled, lastVerifiedAt: verifiedAt }])).not.toThrow();
    expect(lastVerifiedAtOnCreds([{ ...enrolled, lastVerifiedAt: verifiedAt }])).toBe(verifiedAt);
  });
});

describe('mintApiKeyAfterPasskey', () => {
  it('refuses a missing passkey and does not mint', async () => {
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterPasskey(minter, fakeSql([{ webauthn_creds: [] }]), base)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    await expect(mintApiKeyAfterPasskey(minter, fakeSql([{ webauthn_creds: null }]), base)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);
  });

  it('refuses creds without lastVerifiedAt and does not mint a secret or a challenge', async () => {
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterPasskey(minter, fakeSql([{ webauthn_creds: [enrolled] }]), base)).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(created).toEqual([]);
  });

  it('mints through AuthService when lastVerifiedAt is persisted', async () => {
    const { minter, created } = makeMinter();
    const minted = await mintApiKeyAfterPasskey(minter, fakeSql([{ webauthn_creds: [{ ...enrolled, lastVerifiedAt: verifiedAt }] }]), base);
    expect(minted).toEqual({ id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: 'live' });
    expect(created).toHaveLength(1);
  });

  it('treats a missing user as not found', async () => {
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterPasskey(minter, fakeSql([]), base)).rejects.toMatchObject({ code: 'auth.not_found' });
    expect(created).toEqual([]);
  });
});

describe('installPasskeyMintRefuse', () => {
  it('refuses mint without a verified passkey; lets a verified user through', async () => {
    const sql = fakeSql([{ webauthn_creds: [] }]);
    let minted = 0;
    const auth = {
      async createApiKey() {
        minted += 1;
        return { id: 'k', key: 'ifc', prefix: 'ifc', mode: 'live' as const };
      },
    };
    installPasskeyMintRefuse(auth as never, sql);
    await expect(auth.createApiKey({ userId: 'u' } as never)).rejects.toMatchObject({ code: 'auth.passkey_missing' });
    expect(minted).toBe(0);

    const verifiedSql = fakeSql([{ webauthn_creds: [{ ...enrolled, lastVerifiedAt: verifiedAt }] }]);
    const live = {
      async createApiKey() {
        minted += 1;
        return { id: 'k', key: 'ifc', prefix: 'ifc', mode: 'live' as const };
      },
    };
    installPasskeyMintRefuse(live as never, verifiedSql);
    await expect(live.createApiKey({ userId: 'u' } as never)).resolves.toMatchObject({ id: 'k' });
    expect(minted).toBe(1);
  });
});
