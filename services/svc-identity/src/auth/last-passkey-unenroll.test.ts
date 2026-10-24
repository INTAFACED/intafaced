import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PlaceDoor } from './place-door.js';
import { unenrollLastRemainingPasskey } from './last-passkey-unenroll.js';

type StoredCred = { credentialId?: unknown; lastVerifiedAt?: unknown };
type UserRow = { id: string; webauthn_creds: StoredCred[] };
type SessionRow = { id: string; user_id: string; revoked: boolean };
type KeyRow = { id: string; user_id: string; revoked: boolean };

function combinedStore(users: UserRow[], sessions: SessionRow[], keys: KeyRow[]) {
  let sessionWrites = 0;
  let keyWrites = 0;
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
    if (text.includes('select') && text.includes('from api_keys')) {
      const keyId = values[0];
      return keys
        .filter((k) => k.id === keyId)
        .map((k) => ({
          id: k.id,
          user_id: k.user_id,
          revoked: k.revoked,
          expires_at: null,
          domain_whitelist: [],
          ip_allowlist: [],
          account_id: null,
          product_scopes: [],
        }));
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    json: (v: unknown) => v,
    begin: (_o: string, cb: (t: unknown) => unknown) => cb(fn as never),
    get sessionWrites() {
      return sessionWrites;
    },
    get keyWrites() {
      return keyWrites;
    },
    users,
    sessions,
    keys,
  }) as unknown as Parameters<typeof unenrollLastRemainingPasskey>[0] & {
    sessionWrites: number;
    keyWrites: number;
    users: UserRow[];
    sessions: SessionRow[];
    keys: KeyRow[];
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const enrolled = { credentialId: 'cred-1' };
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'last-passkey-unenroll.ts'), 'utf8');

function liveSeats() {
  return [
    { id: 'live-1', user_id: A, revoked: false },
    { id: 'live-2', user_id: A, revoked: false },
    { id: 'dead', user_id: A, revoked: true },
  ];
}

describe('unenrollLastRemainingPasskey — last remaining passkey unenrolled', () => {
  it('reuses unenrollOneOfTwo; no invented challenge, session, or key ids', () => {
    expect(src).toMatch(/unenrollOneOfTwo/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT INTO sessions/i);
    expect(src).not.toMatch(/INSERT INTO api_keys/i);
  });

  it('last remaining cred revokes sessions and keys so PlaceDoor refuses', async () => {
    const sql = combinedStore([{ id: A, webauthn_creds: [enrolled] }], liveSeats(), liveSeats());
    const out = await unenrollLastRemainingPasskey(sql, A, 'cred-1');
    expect(out).toEqual({ credentialId: 'cred-1', remaining: 0, sessionsRevoked: 2, keysRevoked: 2 });
    expect(sql.users[0]?.webauthn_creds).toEqual([]);
    expect(sql.sessions.map((s) => s.revoked)).toEqual([true, true, true]);
    expect(sql.keys.map((k) => k.revoked)).toEqual([true, true, true]);

    const door = new PlaceDoor(sql);
    await expect(door.assertSessionLive('live-1')).rejects.toMatchObject({ code: 'auth.session_revoked' });
    await expect(door.assertApiKeyLive('live-1')).rejects.toMatchObject({ code: 'auth.api_key_revoked' });
  });

  it('unknown cred refuses passkey_missing and does not write sessions or keys', async () => {
    const sql = combinedStore(
      [{ id: A, webauthn_creds: [enrolled] }],
      [{ id: 'live-1', user_id: A, revoked: false }],
      [{ id: 'live-1', user_id: A, revoked: false }],
    );
    await expect(unenrollLastRemainingPasskey(sql, A, 'cred-unknown')).rejects.toMatchObject({ code: 'auth.passkey_missing' });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.keyWrites).toBe(0);
    expect(sql.sessions[0]?.revoked).toBe(false);
    expect(sql.keys[0]?.revoked).toBe(false);
  });

  it('missing user refuses not_found and does not write sessions or keys', async () => {
    const sql = combinedStore([], [{ id: 'live-1', user_id: A, revoked: false }], [{ id: 'live-1', user_id: A, revoked: false }]);
    await expect(unenrollLastRemainingPasskey(sql, A, 'cred-1')).rejects.toMatchObject({ code: 'auth.not_found' });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.keyWrites).toBe(0);
    expect(sql.sessions[0]?.revoked).toBe(false);
    expect(sql.keys[0]?.revoked).toBe(false);
  });

  it('blank credentialId refuses credential_id_missing and does not write sessions or keys', async () => {
    const sql = combinedStore(
      [{ id: A, webauthn_creds: [enrolled] }],
      [{ id: 'live-1', user_id: A, revoked: false }],
      [{ id: 'live-1', user_id: A, revoked: false }],
    );
    await expect(unenrollLastRemainingPasskey(sql, A, '')).rejects.toMatchObject({ code: 'auth.credential_id_missing' });
    await expect(unenrollLastRemainingPasskey(sql, A, '   ')).rejects.toMatchObject({ code: 'auth.credential_id_missing' });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.keyWrites).toBe(0);
    expect(sql.keys[0]?.revoked).toBe(false);
  });
});
