import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { newlyEnrolledPasskeyRevokesAllKeys, revokeAllApiKeysAfterNewlyEnrolledPasskey } from './enroll-after-last-revoke-all.js';

type KeyRow = { id: string; user_id: string; revoked: boolean };

function fakeSql(creds: unknown[] | null, keys: KeyRow[]) {
  let keyWrites = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('webauthn_creds')) {
      if (creds === null) return [];
      return [{ webauthn_creds: creds }];
    }
    if (text.includes('update api_keys')) {
      keyWrites += 1;
      const named = values[0];
      const out: Array<{ id: string }> = [];
      for (const k of keys) {
        if (k.user_id === named && k.revoked === false) {
          k.revoked = true;
          out.push({ id: k.id });
        }
      }
      return out;
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  const sql = Object.assign(fn, { keys }) as Parameters<typeof revokeAllApiKeysAfterNewlyEnrolledPasskey>[0] & {
    keyWrites: number;
    keys: KeyRow[];
  };
  Object.defineProperty(sql, 'keyWrites', { get: () => keyWrites });
  return sql;
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

function liveKeys(): KeyRow[] {
  return [
    { id: 'live-1', user_id: A, revoked: false },
    { id: 'live-2', user_id: A, revoked: false },
    { id: 'dead', user_id: A, revoked: true },
  ];
}

describe('newlyEnrolledPasskeyRevokesAllKeys — enroll after last unenroll', () => {
  it('newly enrolled verified cred revokes every live key; no invented challenge', async () => {
    expect(() => newlyEnrolledPasskeyRevokesAllKeys([enrolledAgain])).not.toThrow();
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();
    const sql = fakeSql([enrolledAgain], liveKeys());
    await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(sql, { userId: A })).resolves.toEqual({
      userId: A,
      revoked: 2,
    });
    expect(sql.keyWrites).toBe(1);
    expect(sql.keys.map((k) => k.revoked)).toEqual([true, true, true]);
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokesAllKeys([enrolledUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const sql = fakeSql([enrolledUnverified], liveKeys());
    await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.keyWrites).toBe(0);
    expect(sql.keys.map((k) => k.revoked)).toEqual([false, false, true]);
  });

  it('empty after last unenroll is auth.passkey_missing and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokesAllKeys([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const sql = fakeSql([], liveKeys());
    await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.keyWrites).toBe(0);
    expect(sql.keys.map((k) => k.revoked)).toEqual([false, false, true]);
  });

  it('missing user is auth.not_found and does not revoke', async () => {
    const sql = fakeSql(null, liveKeys());
    await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.keyWrites).toBe(0);
    expect(sql.keys.map((k) => k.revoked)).toEqual([false, false, true]);
  });

  it('source reuses requireVerifiedPasskey and revokeAllApiKeys; no invented challenge; not one-key revoke', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'enroll-after-last-revoke-all.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).toMatch(/revokeAllApiKeys/);
    expect(src).not.toMatch(/revokeApiKey\(/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
