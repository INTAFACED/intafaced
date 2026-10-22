import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashToken } from './passwords.js';
import { recoveryCodeRevokesAllKeys, revokeAllApiKeysAfterRecoveryCode } from './redeem-recovery-revoke-keys.js';

type KeyRow = { id: string; user_id: string; revoked: boolean };

function fakeSql(row: { recovery_code_hashes: unknown } | null, keys: KeyRow[]) {
  const bag = { updates: [] as unknown[], keyWrites: 0, keys };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('recovery_code_hashes')) {
      if (!row) return [];
      return [row];
    }
    if (text.includes('update api_keys')) {
      bag.keyWrites += 1;
      const named = values[0];
      const out: Array<{ id: string }> = [];
      for (const k of bag.keys) {
        if (k.user_id === named && k.revoked === false) {
          k.revoked = true;
          out.push({ id: k.id });
        }
      }
      return out;
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
  }) as unknown as Parameters<typeof revokeAllApiKeysAfterRecoveryCode>[0] & {
    bag: { updates: unknown[]; keyWrites: number; keys: KeyRow[] };
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODE = 'A1B2C-D3E4F';
const OTHER = 'FFFFF-00000';
const openInput = { userId: A, code: CODE };

function liveKeys(): KeyRow[] {
  return [
    { id: 'live-1', user_id: A, revoked: false },
    { id: 'live-2', user_id: A, revoked: false },
    { id: 'dead', user_id: A, revoked: true },
  ];
}

describe('recoveryCodeRevokesAllKeys', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeRevokesAllKeys('');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });
});

describe('revokeAllApiKeysAfterRecoveryCode', () => {
  it('refuses a missing code and does not revoke or burn', async () => {
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE)] }, liveKeys());
    await expect(revokeAllApiKeysAfterRecoveryCode(sql, { ...openInput, code: '' })).rejects.toMatchObject({
      code: 'auth.recovery_missing',
    });
    expect(sql.bag.keyWrites).toBe(0);
    expect(sql.bag.updates).toEqual([]);
    expect(sql.bag.keys.map((k) => k.revoked)).toEqual([false, false, true]);
  });

  it('refuses a spent code and does not revoke', async () => {
    const sql = fakeSql({ recovery_code_hashes: [] }, liveKeys());
    await expect(revokeAllApiKeysAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.recovery_spent',
    });
    expect(sql.bag.keyWrites).toBe(0);
    expect(sql.bag.updates).toEqual([]);
    expect(sql.bag.keys.map((k) => k.revoked)).toEqual([false, false, true]);
  });

  it('redeems a matching code and revokes every live API key', async () => {
    const leftover = hashToken(OTHER);
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE), leftover] }, liveKeys());
    await expect(revokeAllApiKeysAfterRecoveryCode(sql, openInput)).resolves.toEqual({
      userId: A,
      revoked: 2,
    });
    expect(sql.bag.keyWrites).toBe(1);
    expect(sql.bag.keys.map((k) => k.revoked)).toEqual([true, true, true]);
    expect(sql.bag.updates).toHaveLength(1);
    const written = sql.bag.updates[0] as unknown[];
    expect(written).toContainEqual([leftover]);
  });

  it('treats a missing user as not found', async () => {
    const sql = fakeSql(null, liveKeys());
    await expect(revokeAllApiKeysAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.bag.keyWrites).toBe(0);
    expect(sql.bag.updates).toEqual([]);
  });

  it('source reuses hashToken and revokeAllApiKeys; not a session redo', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'redeem-recovery-revoke-keys.ts'), 'utf8');
    expect(src).toMatch(/hashToken/);
    expect(src).toMatch(/revokeAllApiKeys/);
    expect(src).not.toMatch(/revokeAllSessions/);
    expect(src).not.toMatch(/revokeSession/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
  });
});
