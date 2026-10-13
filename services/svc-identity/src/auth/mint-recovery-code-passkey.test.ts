import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashToken } from './passwords.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { mintRecoveryCodeAfterPasskey, verifiedPasskeyMintsRecoveryCode } from './mint-recovery-code-passkey.js';

function fakeSql(row: { webauthn_creds: unknown; recovery_code_hashes?: unknown } | null) {
  const updates: unknown[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('webauthn_creds')) {
      if (!row) return [];
      return [row];
    }
    if (text.includes('update') && text.includes('recovery_code_hashes')) {
      updates.push(values);
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    json: (value: unknown) => value,
    get updates() {
      return updates;
    },
  }) as unknown as Parameters<typeof mintRecoveryCodeAfterPasskey>[0] & { updates: unknown[] };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const enrolled = { credentialId: 'cred-1', publicKey: 'pk', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' };
const verifiedAt = '2026-08-25T00:00:00.000Z';
const verified = { ...enrolled, lastVerifiedAt: verifiedAt };
const codeShape = /^[0-9A-F]{5}-[0-9A-F]{5}$/;

describe('verifiedPasskeyMintsRecoveryCode', () => {
  it('refuses empty creds as passkey_missing', () => {
    try {
      verifiedPasskeyMintsRecoveryCode([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    expect(() => requireVerifiedPasskey([])).toThrow(/No enrolled passkey/);
  });

  it('refuses enrolled creds without lastVerifiedAt as verify unavailable', () => {
    try {
      verifiedPasskeyMintsRecoveryCode([enrolled]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
  });

  it('allows a cred with lastVerifiedAt and does not invent a challenge', () => {
    expect(() => verifiedPasskeyMintsRecoveryCode([verified])).not.toThrow();
    expect(() => requireVerifiedPasskey([verified])).not.toThrow();
  });
});

describe('mintRecoveryCodeAfterPasskey', () => {
  it('refuses a missing passkey and does not mint', async () => {
    const sql = fakeSql({ webauthn_creds: [] });
    await expect(mintRecoveryCodeAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.updates).toEqual([]);
  });

  it('refuses creds without lastVerifiedAt and does not mint a code or a challenge', async () => {
    const sql = fakeSql({ webauthn_creds: [enrolled], recovery_code_hashes: [] });
    await expect(mintRecoveryCodeAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.updates).toEqual([]);
  });

  it('mints one recovery code after lastVerifiedAt; stores the hash, not the plaintext', async () => {
    const sql = fakeSql({ webauthn_creds: [verified], recovery_code_hashes: [] });
    const minted = await mintRecoveryCodeAfterPasskey(sql, { userId: A });
    expect(minted.code).toMatch(codeShape);
    expect(sql.updates).toHaveLength(1);
    const written = sql.updates[0] as unknown[];
    expect(written).toContainEqual([hashToken(minted.code)]);
    expect(written.some((value) => value === minted.code)).toBe(false);
  });

  it('treats a missing user as not found', async () => {
    const sql = fakeSql(null);
    await expect(mintRecoveryCodeAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.updates).toEqual([]);
  });

  it('source reuses requireVerifiedPasskey and generateRecoveryCodes; no invented challenge', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'mint-recovery-code-passkey.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).toMatch(/generateRecoveryCodes/);
    expect(src).toMatch(/hashToken/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
