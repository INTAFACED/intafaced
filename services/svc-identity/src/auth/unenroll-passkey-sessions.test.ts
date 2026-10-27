import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PlaceDoor } from './place-door.js';
import { unenrollPasskeyAndRevokeSessions } from './unenroll-passkey-sessions.js';

/** The factor-changed outbox rows each removal queued. */
const factorNotices: unknown[][] = [];

type StoredCred = { credentialId?: unknown };
type UserRow = { id: string; webauthn_creds: StoredCred[] };
type SessionRow = { id: string; user_id: string; revoked: boolean };

function combinedStore(users: UserRow[], sessions: SessionRow[]) {
  let sessionWrites = 0;
  const written: unknown[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    // The last-way-in check (I-account-lifecycle-07) reads the account's methods: these accounts also hold a password.
    if (text.includes('password_set')) {
      const userId = values[0];
      return users
        .filter((u) => u.id === userId)
        .map((u) => ({
          status: 'active',
          password_set: true,
          email: null,
          email_verified_at: null,
          email_code_signin: false,
          handle: 'h',
          passkeys: u.webauthn_creds.length,
        }));
    }
    if (text.includes('from wallet_identities') || text.includes('from social_identities')) return [];
    if (text.includes('select') && text.includes('webauthn_creds')) {
      const userId = values[0];
      return users.filter((u) => u.id === userId).map((u) => ({ webauthn_creds: u.webauthn_creds }));
    }
    if (text.includes('update users') && text.includes('webauthn_creds')) {
      written.push(values);
      const remaining = values[0];
      const userId = values[1];
      for (const u of users) {
        if (u.id === userId && Array.isArray(remaining)) {
          u.webauthn_creds = remaining as StoredCred[];
        }
      }
      return [];
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
      if (text.includes('expires_at')) {
        const sessionId = values[0];
        return sessions
          .filter((s) => s.id === sessionId)
          .map((s) => ({
            id: s.id,
            user_id: s.user_id,
            revoked: s.revoked,
            expires_at: new Date(Date.now() + 60_000),
          }));
      }
      const named = values[0];
      return sessions.filter((s) => s.user_id === named && s.revoked === false).map((s) => ({ id: s.id }));
    }
    // The factor-changed notice (I-signin-sessions-08): the account's address, the change count, and its two outbox rows.
    if (text.includes('email_verified_at') && text.includes('from users')) return [];
    if (text.includes('from security_factor_events')) return [{ n: 0 }];
    if (text.includes('into security_factor_events') || text.includes('into mail_outbox')) {
      factorNotices.push(values);
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    json: (v: unknown) => v,
    begin: (_o: string, cb: (t: unknown) => unknown) => cb(fn as never),
    get sessionWrites() {
      return sessionWrites;
    },
    users,
    sessions,
    written,
  }) as unknown as Parameters<typeof unenrollPasskeyAndRevokeSessions>[0] & {
    sessionWrites: number;
    users: UserRow[];
    sessions: SessionRow[];
    written: unknown[];
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const enrolled = { credentialId: 'cred-1' };
const other = { credentialId: 'cred-2' };
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'unenroll-passkey-sessions.ts'), 'utf8');

describe('unenrollPasskeyAndRevokeSessions', () => {
  it('reuses unenrollPasskey then revokeAllSessions; never invents a session id', () => {
    expect(src).toMatch(/unenrollPasskey\(/);
    expect(src).toMatch(/revokeAllSessions\(/);
    expect(src).not.toMatch(/INSERT INTO sessions/i);
  });

  it('after unenroll of an enrolled cred, live sessions are revoked and cannot place', async () => {
    const sql = combinedStore(
      [{ id: A, webauthn_creds: [enrolled, other] }],
      [
        { id: 'live-1', user_id: A, revoked: false },
        { id: 'live-2', user_id: A, revoked: false },
        { id: 'dead', user_id: A, revoked: true },
      ],
    );
    const before = factorNotices.length;
    const out = await unenrollPasskeyAndRevokeSessions(sql, A, 'cred-1');
    expect(out).toEqual({ credentialId: 'cred-1', remaining: 1, sessionsRevoked: 2 });
    // The removal queued its factor-changed notice (I-signin-sessions-08).
    expect(factorNotices.slice(before).some((values) => values.includes('passkey_removed'))).toBe(true);
    expect(sql.sessions.map((s) => s.revoked)).toEqual([true, true, true]);

    const liveDoor = new PlaceDoor((async () => [
      { id: 'live-1', user_id: A, revoked: true, expires_at: new Date(Date.now() + 60_000) },
    ]) as never);
    await expect(liveDoor.assertSessionLive('live-1')).rejects.toMatchObject({
      code: 'auth.session_revoked',
    });
  });

  it('unknown cred refuses passkey_missing and sessions stay live', async () => {
    const sql = combinedStore([{ id: A, webauthn_creds: [enrolled] }], [{ id: 'live-1', user_id: A, revoked: false }]);
    await expect(unenrollPasskeyAndRevokeSessions(sql, A, 'cred-unknown')).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.sessions[0]?.revoked).toBe(false);
  });

  it('missing user refuses not_found and sessions stay live', async () => {
    const sql = combinedStore([], [{ id: 'live-1', user_id: A, revoked: false }]);
    await expect(unenrollPasskeyAndRevokeSessions(sql, A, 'cred-1')).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.sessions[0]?.revoked).toBe(false);
  });

  it('blank credentialId refuses credential_id_missing and sessions stay live', async () => {
    const sql = combinedStore([{ id: A, webauthn_creds: [enrolled] }], [{ id: 'live-1', user_id: A, revoked: false }]);
    await expect(unenrollPasskeyAndRevokeSessions(sql, A, '')).rejects.toMatchObject({
      code: 'auth.credential_id_missing',
    });
    await expect(unenrollPasskeyAndRevokeSessions(sql, A, '   ')).rejects.toMatchObject({
      code: 'auth.credential_id_missing',
    });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.sessions[0]?.revoked).toBe(false);
  });

  it('does not revoke a different user’s sessions', async () => {
    const sql = combinedStore(
      [{ id: A, webauthn_creds: [enrolled] }],
      [
        { id: 'live-1', user_id: A, revoked: false },
        { id: 'b-session', user_id: B, revoked: false },
      ],
    );
    const out = await unenrollPasskeyAndRevokeSessions(sql, A, 'cred-1');
    expect(out).toEqual({ credentialId: 'cred-1', remaining: 0, sessionsRevoked: 1 });
    expect(sql.sessions.find((s) => s.id === 'live-1')?.revoked).toBe(true);
    expect(sql.sessions.find((s) => s.id === 'b-session')?.revoked).toBe(false);
  });
});
