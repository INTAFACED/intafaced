import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashToken } from './passwords.js';
import { recoveryCodeRevokesOtherSessions, revokeOtherSessionsAfterRecoveryCode } from './redeem-recovery-revoke-sessions.js';

type SessionRow = { id: string; user_id: string; revoked: boolean };

function fakeSql(row: { recovery_code_hashes: unknown } | null, sessions: SessionRow[]) {
  const bag = { updates: [] as unknown[], sessionWrites: 0, sessions };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('recovery_code_hashes')) {
      if (!row) return [];
      return [row];
    }
    if (text.includes('update sessions')) {
      bag.sessionWrites += 1;
      const sessionId = values[0];
      const named = values[1];
      const out: Array<{ id: string }> = [];
      for (const s of bag.sessions) {
        if (s.id === sessionId && s.user_id === named && s.revoked === false) {
          s.revoked = true;
          out.push({ id: s.id });
        }
      }
      return out;
    }
    if (text.includes('select') && text.includes('from sessions')) {
      const named = values[0];
      return bag.sessions.filter((s) => s.user_id === named && s.revoked === false).map((s) => ({ id: s.id }));
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
  }) as unknown as Parameters<typeof revokeOtherSessionsAfterRecoveryCode>[0] & {
    bag: { updates: unknown[]; sessionWrites: number; sessions: SessionRow[] };
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODE = 'A1B2C-D3E4F';
const OTHER = 'FFFFF-00000';
const openInput = { userId: A, sessionId: 'live-1', code: CODE };

function liveSeats(): SessionRow[] {
  return [
    { id: 'live-1', user_id: A, revoked: false },
    { id: 'live-2', user_id: A, revoked: false },
    { id: 'dead', user_id: A, revoked: true },
  ];
}

describe('recoveryCodeRevokesOtherSessions', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeRevokesOtherSessions('');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });
});

describe('revokeOtherSessionsAfterRecoveryCode', () => {
  it('refuses a missing code and does not revoke or burn', async () => {
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE)] }, liveSeats());
    await expect(revokeOtherSessionsAfterRecoveryCode(sql, { ...openInput, code: '' })).rejects.toMatchObject({
      code: 'auth.recovery_missing',
    });
    expect(sql.bag.sessionWrites).toBe(0);
    expect(sql.bag.updates).toEqual([]);
    expect(sql.bag.sessions.map((s) => s.revoked)).toEqual([false, false, true]);
  });

  it('refuses a spent code and does not revoke', async () => {
    const sql = fakeSql({ recovery_code_hashes: [] }, liveSeats());
    await expect(revokeOtherSessionsAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.recovery_spent',
    });
    expect(sql.bag.sessionWrites).toBe(0);
    expect(sql.bag.updates).toEqual([]);
    expect(sql.bag.sessions.map((s) => s.revoked)).toEqual([false, false, true]);
  });

  it('redeems a matching code, revokes every other live session, and keeps the recovered seat', async () => {
    const leftover = hashToken(OTHER);
    const sql = fakeSql({ recovery_code_hashes: [hashToken(CODE), leftover] }, liveSeats());
    await expect(revokeOtherSessionsAfterRecoveryCode(sql, openInput)).resolves.toEqual({
      userId: A,
      sessionId: 'live-1',
      revoked: 1,
    });
    expect(sql.bag.sessionWrites).toBe(1);
    expect(sql.bag.sessions.map((s) => s.revoked)).toEqual([false, true, true]);
    expect(sql.bag.updates).toHaveLength(1);
    const written = sql.bag.updates[0] as unknown[];
    expect(written).toContainEqual([leftover]);
  });

  it('treats a missing user as not found', async () => {
    const sql = fakeSql(null, liveSeats());
    await expect(revokeOtherSessionsAfterRecoveryCode(sql, openInput)).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.bag.sessionWrites).toBe(0);
    expect(sql.bag.updates).toEqual([]);
  });

  it('source reuses hashToken and revokeSession; keeps the recovered session; no invented session', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'redeem-recovery-revoke-sessions.ts'), 'utf8');
    expect(src).toMatch(/hashToken/);
    expect(src).toMatch(/revokeSession/);
    expect(src).not.toMatch(/revokeAllSessions/);
    expect(src).not.toMatch(/INSERT\s+sessions/i);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
  });
});
