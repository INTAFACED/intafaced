import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StoredPasskey } from './enroll-passkey.js';
import { hashToken } from './passwords.js';
import { enrollPasskeyAfterRecoveryCode, recoveryCodeEnrollsPasskey } from './redeem-recovery-enroll.js';

function fakeSql(row: { recovery_code_hashes: unknown; webauthn_creds?: unknown } | null) {
  const bag = { updates: [] as unknown[] };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('recovery_code_hashes')) {
      if (!row) return [];
      return [row];
    }
    if (text.includes('update') && text.includes('webauthn_creds')) {
      bag.updates.push(values);
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    json: (value: unknown) => value,
    bag,
  }) as unknown as Parameters<typeof enrollPasskeyAfterRecoveryCode>[0] & {
    bag: { updates: unknown[] };
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODE = 'A1B2C-D3E4F';
const OTHER = 'FFFFF-00000';
const cred: StoredPasskey = {
  credentialId: 'cred-new',
  publicKey: 'pk-new',
  counter: 0,
  createdAt: '2026-08-31T15:00:00.000Z',
};
const openInput = { userId: A, code: CODE, cred };

describe('recoveryCodeEnrollsPasskey', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeEnrollsPasskey('');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
    try {
      recoveryCodeEnrollsPasskey('   ');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });

  it('allows a presented code without inventing a challenge', () => {
    expect(() => recoveryCodeEnrollsPasskey(CODE)).not.toThrow();
  });
});

describe('enrollPasskeyAfterRecoveryCode', () => {
  it('refuses a missing code and does not enroll or burn', async () => {
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE)], webauthn_creds: [] });
    await expect(enrollPasskeyAfterRecoveryCode(sql, { ...openInput, code: '' })).rejects.toMatchObject({
      code: 'auth.recovery_missing',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('refuses a spent code (none remain) and does not enroll', async () => {
    const sql = fakeSql({ recovery_code_hashes: [], webauthn_creds: [] });
    await expect(enrollPasskeyAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.recovery_spent',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('refuses a wrong code and does not enroll or burn', async () => {
    const sql = fakeSql({ recovery_code_hashes: [hashToken(OTHER)], webauthn_creds: [] });
    await expect(enrollPasskeyAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.recovery_invalid',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('redeems a matching code, burns the hash, and enrolls the supplied passkey', async () => {
    const leftover = hashToken(OTHER);
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE), leftover], webauthn_creds: [] });
    await expect(enrollPasskeyAfterRecoveryCode(sql, openInput)).resolves.toEqual({ credentialId: 'cred-new' });
    expect(sql.bag.updates).toHaveLength(1);
    const written = sql.bag.updates[0] as unknown[];
    expect(written).toContainEqual([leftover]);
    expect(written).toContainEqual([cred]);
    expect(written.some((value) => value === CODE)).toBe(false);
  });

  it('treats a missing user as not found', async () => {
    const sql = fakeSql(null);
    await expect(enrollPasskeyAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('source reuses hashToken and StoredPasskey; no invented challenge', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'redeem-recovery-enroll.ts'), 'utf8');
    expect(src).toMatch(/hashToken/);
    expect(src).toMatch(/StoredPasskey/);
    expect(src).not.toMatch(/generateRegistrationOptions/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/beginEnrollPasskey/);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
