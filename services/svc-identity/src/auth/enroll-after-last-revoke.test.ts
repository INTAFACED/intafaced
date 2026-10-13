import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { newlyEnrolledPasskeyRevokes, revokeApiKeyAfterNewlyEnrolledPasskey } from './enroll-after-last-revoke.js';

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  return fn as unknown as Parameters<typeof revokeApiKeyAfterNewlyEnrolledPasskey>[1];
}

function makeMinter() {
  const revoked: string[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey() {
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: 'live' };
    },
    async revokeApiKey(_userId, keyId) {
      revoked.push(keyId);
      return true;
    },
  };
  return { minter, revoked };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const verifiedAt = '2026-08-25T00:00:00.000Z';
const enrolledAgain = {
  credentialId: 'cred-3',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T02:00:00.000Z',
  lastVerifiedAt: verifiedAt,
};
const enrolledUnverified = {
  credentialId: 'cred-3',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T02:00:00.000Z',
};
const revokeInput = { userId: A, keyId: 'old' };

describe('newlyEnrolledPasskeyRevokes — enroll after last unenroll', () => {
  it('newly enrolled verified cred revokes; no invented challenge', async () => {
    expect(() => newlyEnrolledPasskeyRevokes([enrolledAgain])).not.toThrow();
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();
    const { minter, revoked } = makeMinter();
    await expect(
      revokeApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [enrolledAgain] }]), revokeInput),
    ).resolves.toEqual({ revokedKeyId: 'old' });
    expect(revoked).toEqual(['old']);
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokes([enrolledUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const { minter, revoked } = makeMinter();
    await expect(
      revokeApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [enrolledUnverified] }]), revokeInput),
    ).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(revoked).toEqual([]);
  });

  it('empty after last unenroll is auth.passkey_missing and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokes([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const { minter, revoked } = makeMinter();
    await expect(revokeApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [] }]), revokeInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(revoked).toEqual([]);
  });

  it('source reuses requireVerifiedPasskey; no invented challenge', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'enroll-after-last-revoke.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).toMatch(/revokeApiKey/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
