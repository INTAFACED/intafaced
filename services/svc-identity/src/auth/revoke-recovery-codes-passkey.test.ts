import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { revokeAllRecoveryCodesAfterPasskey, verifiedPasskeyRevokesAllRecoveryCodes } from './revoke-recovery-codes-passkey.js';

function fakeSql(row: { webauthn_creds: unknown; recovery_code_hashes?: unknown } | null) {
  const bag = { updates: [] as unknown[] };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('webauthn_creds')) {
      if (!row) return [];
      return [row];
    }
    if (text.includes('update') && text.includes('recovery_code_hashes')) {
      bag.updates.push(values);
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    json: (value: unknown) => value,
    bag,
  }) as unknown as Parameters<typeof revokeAllRecoveryCodesAfterPasskey>[0] & {
    bag: { updates: unknown[] };
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const enrolled = { credentialId: 'cred-1', publicKey: 'pk', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' };
const verifiedAt = '2026-08-25T00:00:00.000Z';
const verified = { ...enrolled, lastVerifiedAt: verifiedAt };
const hashes = ['hash-1', 'hash-2'];

describe('verifiedPasskeyRevokesAllRecoveryCodes', () => {
  it('refuses empty creds as passkey_missing', () => {
    try {
      verifiedPasskeyRevokesAllRecoveryCodes([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    expect(() => requireVerifiedPasskey([])).toThrow(/No enrolled passkey/);
  });

  it('refuses enrolled creds without lastVerifiedAt as verify unavailable', () => {
    try {
      verifiedPasskeyRevokesAllRecoveryCodes([enrolled]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
  });

  it('allows a cred with lastVerifiedAt and does not invent a challenge', () => {
    expect(() => verifiedPasskeyRevokesAllRecoveryCodes([verified])).not.toThrow();
    expect(() => requireVerifiedPasskey([verified])).not.toThrow();
  });
});

describe('revokeAllRecoveryCodesAfterPasskey', () => {
  it('refuses a missing passkey and does not revoke', async () => {
    const sql = fakeSql({ webauthn_creds: [], recovery_code_hashes: hashes });
    await expect(revokeAllRecoveryCodesAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('refuses creds without lastVerifiedAt and does not revoke', async () => {
    const sql = fakeSql({ webauthn_creds: [enrolled], recovery_code_hashes: hashes });
    await expect(revokeAllRecoveryCodesAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('clears every recovery hash after lastVerifiedAt', async () => {
    const sql = fakeSql({ webauthn_creds: [verified], recovery_code_hashes: hashes });
    await expect(revokeAllRecoveryCodesAfterPasskey(sql, { userId: A })).resolves.toEqual({ revoked: 2 });
    expect(sql.bag.updates).toHaveLength(1);
    const written = sql.bag.updates[0] as unknown[];
    expect(written).toContainEqual([]);
    expect(written.some((value) => Array.isArray(value) && value.includes('hash-1'))).toBe(false);
  });

  it('treats a missing user as not found', async () => {
    const sql = fakeSql(null);
    await expect(revokeAllRecoveryCodesAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('source reuses requireVerifiedPasskey; no invented challenge', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'revoke-recovery-codes-passkey.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/generateRegistrationOptions/);
    expect(src).not.toMatch(/generateRecoveryCodes/);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
