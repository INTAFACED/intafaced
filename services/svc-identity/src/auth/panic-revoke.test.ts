import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PlaceDoor } from './place-door.js';
import { panicRevoke, requirePanicUserId, revokeAllAccess } from './panic-revoke.js';

type KeyRow = { id: string; user_id: string; revoked: boolean };
type SessionRow = { id: string; user_id: string; revoked: boolean };

function panicStore(keys: KeyRow[], sessions: SessionRow[]) {
  let writes = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('update api_keys')) {
      writes += 1;
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
    if (text.includes('select') && text.includes('from sessions')) {
      const named = values[0];
      return sessions.filter((s) => s.user_id === named && s.revoked === false).map((s) => ({ id: s.id }));
    }
    if (text.includes('update sessions')) {
      writes += 1;
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
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    get writes() {
      return writes;
    },
    keys,
    sessions,
  }) as Parameters<typeof panicRevoke>[0] & {
    writes: number;
    keys: KeyRow[];
    sessions: SessionRow[];
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'panic-revoke.ts'), 'utf8');
const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');

describe('panicRevoke', () => {
  it('is revokeAllAccess — same function, not a fork of the two UPDATE paths', () => {
    expect(revokeAllAccess).toBe(panicRevoke);
    expect(src).toMatch(/revokeAllApiKeys\(/);
    expect(src).toMatch(/revokeAllSessions\(/);
    expect(src).not.toMatch(/UPDATE api_keys/);
    expect(src).not.toMatch(/UPDATE sessions/);
  });

  it('refuses a missing userId and does not write', async () => {
    const sql = panicStore([{ id: 'k', user_id: A, revoked: false }], [{ id: 's', user_id: A, revoked: false }]);
    await expect(panicRevoke(sql, A, undefined)).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(panicRevoke(sql, A, '')).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(panicRevoke(sql, A, '   ')).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    expect(() => requirePanicUserId(null)).toThrow(/userId is required/);
    expect(sql.writes).toBe(0);
    expect(sql.keys[0]?.revoked).toBe(false);
    expect(sql.sessions[0]?.revoked).toBe(false);
  });

  it('kills live keys and sessions for the named user; already-revoked stay revoked', async () => {
    const sql = panicStore(
      [
        { id: 'k-live-1', user_id: A, revoked: false },
        { id: 'k-live-2', user_id: A, revoked: false },
        { id: 'k-dead', user_id: A, revoked: true },
      ],
      [
        { id: 's-live-1', user_id: A, revoked: false },
        { id: 's-live-2', user_id: A, revoked: false },
        { id: 's-dead', user_id: A, revoked: true },
      ],
    );
    const out = await panicRevoke(sql, A, A);
    expect(out).toEqual({ userId: A, keysRevoked: 2, sessionsRevoked: 2 });
    expect(sql.keys.map((k) => k.revoked)).toEqual([true, true, true]);
    expect(sql.sessions.map((s) => s.revoked)).toEqual([true, true, true]);

    const keyDoor = new PlaceDoor((async () => [{ id: 'k-live-1', user_id: A, revoked: true }]) as never);
    await expect(keyDoor.assertApiKeyLive('k-live-1')).rejects.toMatchObject({
      code: 'auth.api_key_revoked',
    });
    const sessionDoor = new PlaceDoor((async () => [
      { id: 's-live-1', user_id: A, revoked: true, expires_at: new Date(Date.now() + 60_000) },
    ]) as never);
    await expect(sessionDoor.assertSessionLive('s-live-1')).rejects.toMatchObject({
      code: 'auth.session_revoked',
    });
  });

  it('does not revoke a different user’s keys or sessions', async () => {
    const sql = panicStore(
      [
        { id: 'a-key', user_id: A, revoked: false },
        { id: 'b-key', user_id: B, revoked: false },
      ],
      [
        { id: 'a-session', user_id: A, revoked: false },
        { id: 'b-session', user_id: B, revoked: false },
      ],
    );
    const foreign = await panicRevoke(sql, A, B);
    expect(foreign).toEqual({ userId: B, keysRevoked: 0, sessionsRevoked: 0 });
    expect(sql.writes).toBe(0);
    expect(sql.keys.find((k) => k.id === 'b-key')?.revoked).toBe(false);
    expect(sql.sessions.find((s) => s.id === 'b-session')?.revoked).toBe(false);

    const own = await panicRevoke(sql, A, A);
    expect(own).toEqual({ userId: A, keysRevoked: 1, sessionsRevoked: 1 });
    expect(sql.keys.find((k) => k.id === 'a-key')?.revoked).toBe(true);
    expect(sql.keys.find((k) => k.id === 'b-key')?.revoked).toBe(false);
    expect(sql.sessions.find((s) => s.id === 'a-session')?.revoked).toBe(true);
    expect(sql.sessions.find((s) => s.id === 'b-session')?.revoked).toBe(false);
  });
});

describe('panicRevoke is mounted (not helper-only)', () => {
  it('mergeRouters includes createPanicRevokeRouter', () => {
    expect(indexSrc).toMatch(/createPanicRevokeRouter\(sql\)/);
    expect(indexSrc).toMatch(/from ['"]\.\/panic-revoke-router\.js['"]/);
  });
});
