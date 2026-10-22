import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { mintApiKeyAfterPasskey, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { mintApiKeyAfterRemainingPasskey, remainingPasskeyMints } from './remaining-passkey-mint.js';

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
const mintInput = {
  userId: A,
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'] as const,
};

describe('remainingPasskeyMints — unenroll first of two', () => {
  it('remaining verified cred mints; no invented challenge', async () => {
    expect(() => remainingPasskeyMints([remaining])).not.toThrow();
    expect(() => requireVerifiedPasskey([remaining])).not.toThrow();
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterRemainingPasskey(minter, fakeSql([{ webauthn_creds: [remaining] }]), mintInput)).resolves.toEqual({
      id: 'k1',
      key: 'ifk_live_secret',
      prefix: 'ifk_live',
      mode: 'live',
    });
    await expect(mintApiKeyAfterPasskey(minter, fakeSql([{ webauthn_creds: [remaining] }]), mintInput)).resolves.toMatchObject({
      id: 'k1',
    });
    expect(created).toHaveLength(2);
  });

  it('remaining cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not mint', async () => {
    try {
      remainingPasskeyMints([remainingUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const { minter, created } = makeMinter();
    await expect(
      mintApiKeyAfterRemainingPasskey(minter, fakeSql([{ webauthn_creds: [remainingUnverified] }]), mintInput),
    ).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(created).toEqual([]);
  });

  it('empty remaining creds is auth.passkey_missing and does not mint', async () => {
    try {
      remainingPasskeyMints([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterRemainingPasskey(minter, fakeSql([{ webauthn_creds: [] }]), mintInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);
  });

  it('source reuses requireVerifiedPasskey and mintApiKeyAfterPasskey; no invented challenge', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'remaining-passkey-mint.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).toMatch(/mintApiKeyAfterPasskey/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
