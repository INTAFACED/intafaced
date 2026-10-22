import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { mintApiKeyAfterPasskey, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { PlaceDoor } from './place-door.js';
import { rotateApiKeyAfterPasskey } from './rotate-api-key-passkey.js';
import { unenrollOneOfTwo } from './unenroll-one-of-two.js';
import { beginVerifyPasskey, type VerifyPasskeyCeremony } from './verify-passkey.js';
import type { ChallengeStorePort } from './webauthn.js';

type StoredCred = { credentialId?: unknown; lastVerifiedAt?: unknown };
type UserRow = { id: string; webauthn_creds: StoredCred[] };
type SessionRow = { id: string; user_id: string; revoked: boolean };
type KeyRow = { id: string; user_id: string; revoked: boolean };

function combinedStore(users: UserRow[], sessions: SessionRow[], keys: KeyRow[]) {
  let sessionWrites = 0;
  let keyWrites = 0;
  const written: unknown[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
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
      if (text.includes('name') && text.includes('scopes')) {
        const keyId = values[0];
        const userId = values[1];
        return keys
          .filter((k) => k.id === keyId && k.user_id === userId && k.revoked === false)
          .map((k) => ({
            id: k.id,
            name: 'desk',
            scopes: ['identity:read'],
            domain_whitelist: [],
            expires_at: null,
            mode: 'live',
            ip_allowlist: [],
            account_id: null,
          }));
      }
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
    get sessionWrites() {
      return sessionWrites;
    },
    get keyWrites() {
      return keyWrites;
    },
    users,
    sessions,
    keys,
    written,
  }) as unknown as Parameters<typeof unenrollOneOfTwo>[0] & {
    sessionWrites: number;
    keyWrites: number;
    users: UserRow[];
    sessions: SessionRow[];
    keys: KeyRow[];
    written: unknown[];
  };
}

function memChallenges(): ChallengeStorePort {
  const entries = new Map<string, { challenge: string; userId: string; kind: string }>();
  return {
    async put(kind, challenge, userId) {
      entries.set(challenge, { challenge, userId: userId ?? '', kind });
    },
    async take(challenge, kind) {
      const e = entries.get(challenge);
      entries.delete(challenge);
      if (!e || e.kind !== kind) return null;
      return {
        challenge: e.challenge,
        userId: e.userId,
        kind: e.kind as 'authentication',
        expiresAt: Date.now() + 60_000,
      };
    },
  };
}

function makeMinter() {
  const created: unknown[] = [];
  const revoked: string[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey(input) {
      created.push(input);
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: input.mode ?? 'live' };
    },
    async revokeApiKey(_userId, keyId) {
      revoked.push(keyId);
      return true;
    },
  };
  return { minter, created, revoked };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const enrolled = { credentialId: 'cred-1' };
const other = { credentialId: 'cred-2', lastVerifiedAt: '2026-08-25T00:00:00.000Z' };
const mintInput = {
  userId: A,
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'] as const,
};
const rotateInput = { userId: A, keyId: 'live-1', grantorScopes: ['identity:read'] as const };
const rp = { rpId: 'intafaced.com', rpName: 'INTAFACED', origin: 'https://app.intafaced.com' };
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'unenroll-one-of-two.ts'), 'utf8');

function liveSeats() {
  return [
    { id: 'live-1', user_id: A, revoked: false },
    { id: 'live-2', user_id: A, revoked: false },
    { id: 'dead', user_id: A, revoked: true },
  ];
}

describe('unenrollOneOfTwo', () => {
  it('reuses unenrollPasskey and, on last cred, revokeAllSessions then revokeAllApiKeys; never the always-revoke helper', () => {
    expect(src).toMatch(/unenrollPasskey\(/);
    expect(src).toMatch(/revokeAllSessions\(/);
    expect(src).toMatch(/revokeAllApiKeys\(/);
    expect(src).not.toMatch(/unenrollPasskeyAndRevokeKeys/);
    expect(src).not.toMatch(/INSERT INTO sessions/i);
    expect(src).not.toMatch(/INSERT INTO api_keys/i);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
  });

  it('unenrolls the first of two without dropping the second or revoking its seats and keys', async () => {
    const sql = combinedStore([{ id: A, webauthn_creds: [enrolled, other] }], liveSeats(), liveSeats());
    const out = await unenrollOneOfTwo(sql, A, 'cred-1');
    expect(out).toEqual({ credentialId: 'cred-1', remaining: 1, sessionsRevoked: 0, keysRevoked: 0 });
    expect(sql.users[0]?.webauthn_creds.map((c) => c.credentialId)).toEqual(['cred-2']);
    expect(sql.sessionWrites).toBe(0);
    expect(sql.keyWrites).toBe(0);
    expect(sql.sessions.map((s) => s.revoked)).toEqual([false, false, true]);
    expect(sql.keys.map((k) => k.revoked)).toEqual([false, false, true]);

    const door = new PlaceDoor(sql);
    await expect(door.assertSessionLive('live-1')).resolves.toEqual({ id: 'live-1', userId: A });
    await expect(door.assertApiKeyLive('live-1')).resolves.toEqual({ id: 'live-1', userId: A });

    expect(() => requireVerifiedPasskey(sql.users[0]?.webauthn_creds)).not.toThrow();

    const { minter, created, revoked } = makeMinter();
    await expect(mintApiKeyAfterPasskey(minter, sql, mintInput)).resolves.toMatchObject({ id: 'k1' });
    await expect(rotateApiKeyAfterPasskey(minter, sql, rotateInput)).resolves.toMatchObject({ id: 'k1', revokedKeyId: 'live-1' });
    expect(created).toHaveLength(2);
    expect(revoked).toEqual(['live-1']);

    const generateCalls: unknown[] = [];
    const ceremony: VerifyPasskeyCeremony = {
      generate: async (opts) => {
        if ('challenge' in opts && (opts as { challenge?: unknown }).challenge) {
          throw new Error('ceremony.generate must not invent a challenge');
        }
        generateCalls.push(opts);
        return {
          challenge: 'lib-auth-challenge',
          timeout: 60_000,
          rpId: 'intafaced.com',
          allowCredentials: opts.allowCredentials,
          userVerification: 'required',
        } as Awaited<ReturnType<VerifyPasskeyCeremony['generate']>>;
      },
      verify: async () => {
        throw new Error('ceremony.verify must not be called');
      },
    };
    const started = await beginVerifyPasskey(sql, A, rp, memChallenges(), ceremony);
    expect(started.challenge).toBe('lib-auth-challenge');
    expect(generateCalls[0]).toMatchObject({ allowCredentials: [{ id: 'cred-2' }] });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.keyWrites).toBe(0);
  });

  it('last remaining cred still revokes sessions and keys so PlaceDoor refuses', async () => {
    const sql = combinedStore([{ id: A, webauthn_creds: [enrolled] }], liveSeats(), liveSeats());
    const out = await unenrollOneOfTwo(sql, A, 'cred-1');
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
    await expect(unenrollOneOfTwo(sql, A, 'cred-unknown')).rejects.toMatchObject({ code: 'auth.passkey_missing' });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.keyWrites).toBe(0);
    expect(sql.sessions[0]?.revoked).toBe(false);
    expect(sql.keys[0]?.revoked).toBe(false);
  });

  it('missing user refuses not_found and does not write sessions or keys', async () => {
    const sql = combinedStore([], [{ id: 'live-1', user_id: A, revoked: false }], [{ id: 'live-1', user_id: A, revoked: false }]);
    await expect(unenrollOneOfTwo(sql, A, 'cred-1')).rejects.toMatchObject({ code: 'auth.not_found' });
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
    await expect(unenrollOneOfTwo(sql, A, '')).rejects.toMatchObject({ code: 'auth.credential_id_missing' });
    await expect(unenrollOneOfTwo(sql, A, '   ')).rejects.toMatchObject({ code: 'auth.credential_id_missing' });
    expect(sql.sessionWrites).toBe(0);
    expect(sql.keyWrites).toBe(0);
    expect(sql.keys[0]?.revoked).toBe(false);
  });
});
