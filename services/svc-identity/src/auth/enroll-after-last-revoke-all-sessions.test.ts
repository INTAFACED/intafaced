import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import {
  newlyEnrolledPasskeyRevokesAllSessions,
  revokeAllSessionsAfterNewlyEnrolledPasskey,
} from './enroll-after-last-revoke-all-sessions.js';

type SessionRow = { id: string; user_id: string; revoked: boolean };

function fakeSql(creds: unknown[] | null, sessions: SessionRow[]) {
  let sessionWrites = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('webauthn_creds')) {
      if (creds === null) return [];
      return [{ webauthn_creds: creds }];
    }
    if (text.includes('update sessions')) {
      sessionWrites += 1;
      const sessionId = values[0];
      const named = values[1];
      const out: Array<{ id: string }> = [];
      for (const s of sessions) {
        if (s.id === sessionId && s.user_id === named && s.revoked === false) {
          s.revoked = true;
          out.push({ id: s.id });
        }
      }
      return out;
    }
    if (text.includes('select') && text.includes('from sessions')) {
      const named = values[0];
      return sessions.filter((s) => s.user_id === named && s.revoked === false).map((s) => ({ id: s.id }));
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  const sql = Object.assign(fn, { sessions }) as Parameters<typeof revokeAllSessionsAfterNewlyEnrolledPasskey>[0] & {
    sessionWrites: number;
    sessions: SessionRow[];
  };
  Object.defineProperty(sql, 'sessionWrites', { get: () => sessionWrites });
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

function liveSeats(): SessionRow[] {
  return [
    { id: 'live-1', user_id: A, revoked: false },
    { id: 'live-2', user_id: A, revoked: false },
    { id: 'dead', user_id: A, revoked: true },
  ];
}

describe('newlyEnrolledPasskeyRevokesAllSessions — enroll after last unenroll', () => {
  it('newly enrolled verified cred revokes every live session; no invented challenge', async () => {
    expect(() => newlyEnrolledPasskeyRevokesAllSessions([enrolledAgain])).not.toThrow();
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();
    const sql = fakeSql([enrolledAgain], liveSeats());
    await expect(revokeAllSessionsAfterNewlyEnrolledPasskey(sql, { userId: A })).resolves.toEqual({
      userId: A,
      revoked: 2,
    });
    expect(sql.sessionWrites).toBe(2);
    expect(sql.sessions.map((s) => s.revoked)).toEqual([true, true, true]);
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokesAllSessions([enrolledUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const sql = fakeSql([enrolledUnverified], liveSeats());
    await expect(revokeAllSessionsAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.sessions.map((s) => s.revoked)).toEqual([false, false, true]);
  });

  it('empty after last unenroll is auth.passkey_missing and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokesAllSessions([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const sql = fakeSql([], liveSeats());
    await expect(revokeAllSessionsAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.sessions.map((s) => s.revoked)).toEqual([false, false, true]);
  });

  it('missing user is auth.not_found and does not revoke', async () => {
    const sql = fakeSql(null, liveSeats());
    await expect(revokeAllSessionsAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.sessions.map((s) => s.revoked)).toEqual([false, false, true]);
  });

  it('source reuses requireVerifiedPasskey and revokeAllSessions; no invented challenge; not one-session revoke', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'enroll-after-last-revoke-all-sessions.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).toMatch(/revokeAllSessions/);
    expect(src).not.toMatch(/from '\.\/revoke-session/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
    expect(src).not.toMatch(/INSERT\s+sessions/i);
  });
});
