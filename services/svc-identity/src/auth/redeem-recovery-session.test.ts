import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashToken } from './passwords.js';
import { openLiveSessionAfterRecoveryCode, recoveryCodeOpensSession } from './redeem-recovery-session.js';

function fakeSql(row: { recovery_code_hashes: unknown } | null, session?: { id: string; user_id: string; revoked: boolean }) {
  const bag = { updates: [] as unknown[], sessionReads: 0 };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('recovery_code_hashes')) {
      if (!row) return [];
      return [row];
    }
    if (text.includes('from sessions')) {
      bag.sessionReads += 1;
      if (!session) return [];
      return [
        {
          id: session.id,
          user_id: session.user_id,
          revoked: session.revoked,
          expires_at: new Date(Date.now() + 60_000),
        },
      ];
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
  }) as unknown as Parameters<typeof openLiveSessionAfterRecoveryCode>[0] & {
    bag: { updates: unknown[]; sessionReads: number };
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODE = 'A1B2C-D3E4F';
const OTHER = 'FFFFF-00000';
const live = { id: 'live-1', user_id: A, revoked: false };
const openInput = { userId: A, sessionId: 'live-1', code: CODE };

describe('recoveryCodeOpensSession', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeOpensSession('');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
    try {
      recoveryCodeOpensSession('   ');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });

  it('allows a presented code without inventing a challenge', () => {
    expect(() => recoveryCodeOpensSession(CODE)).not.toThrow();
  });
});

describe('openLiveSessionAfterRecoveryCode', () => {
  it('refuses a missing code and does not open or burn', async () => {
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE)] }, live);
    await expect(openLiveSessionAfterRecoveryCode(sql, { ...openInput, code: '' })).rejects.toMatchObject({
      code: 'auth.recovery_missing',
    });
    expect(sql.bag.sessionReads).toBe(0);
    expect(sql.bag.updates).toEqual([]);
  });

  it('refuses a spent code (none remain) and does not open', async () => {
    const sql = fakeSql({ recovery_code_hashes: [] }, live);
    await expect(openLiveSessionAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.recovery_spent',
    });
    expect(sql.bag.sessionReads).toBe(0);
    expect(sql.bag.updates).toEqual([]);
  });

  it('refuses a wrong code and does not open or burn', async () => {
    const sql = fakeSql({ recovery_code_hashes: [hashToken(OTHER)] }, live);
    await expect(openLiveSessionAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.recovery_invalid',
    });
    expect(sql.bag.sessionReads).toBe(0);
    expect(sql.bag.updates).toEqual([]);
  });

  it('redeems a matching code, burns the hash, and opens the existing live session', async () => {
    const leftover = hashToken(OTHER);
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE), leftover] }, live);
    await expect(openLiveSessionAfterRecoveryCode(sql, openInput)).resolves.toEqual({
      id: 'live-1',
      userId: A,
    });
    expect(sql.bag.sessionReads).toBe(1);
    expect(sql.bag.updates).toHaveLength(1);
    const written = sql.bag.updates[0] as unknown[];
    expect(written).toContainEqual([leftover]);
    expect(written.some((value) => value === CODE || (Array.isArray(value) && value.includes(hashToken(CODE))))).toBe(false);
  });

  it('does not invent a session when the existing one is missing', async () => {
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE)] });
    await expect(openLiveSessionAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.session_denied',
    });
    expect(sql.bag.sessionReads).toBe(1);
    expect(sql.bag.updates).toEqual([]);
  });

  it('treats a missing user as not found', async () => {
    const sql = fakeSql(null, live);
    await expect(openLiveSessionAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.bag.sessionReads).toBe(0);
    expect(sql.bag.updates).toEqual([]);
  });

  it('source reuses hashToken and PlaceDoor; no invented challenge or session', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'redeem-recovery-session.ts'), 'utf8');
    expect(src).toMatch(/hashToken/);
    expect(src).toMatch(/PlaceDoor/);
    expect(src).toMatch(/assertSessionLive/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/generateRecoveryCodes/);
    expect(src).not.toMatch(/INSERT\s+sessions/i);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
