import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PlaceDoor } from './place-door.js';
import { listSessions } from './list-sessions.js';
import { requireRevokeSessionIds, revokeNamedSession } from './revoke-session.js';

type SessionRow = { id: string; user_id: string; revoked: boolean; created_at: Date };
type KeyRow = { id: string; user_id: string; revoked: boolean };

function sessionStore(sessions: SessionRow[], keys: KeyRow[] = []) {
  let writes = 0;
  let keyWrites = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.trim() === 'true') return [];
    if (text.includes('select') && text.includes('from sessions') && text.includes('created_at')) {
      const named = values[0];
      return sessions
        .filter((s) => s.user_id === named && s.revoked === false)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map((s) => ({
          id: s.id,
          family_id: s.id,
          created_at: s.created_at,
          last_used_at: s.created_at,
          device: null,
          user_agent: null,
          ip: null,
          country: null,
        }));
    }
    if (text.includes('insert')) {
      throw new Error(`must not invent a session: ${text}`);
    }
    if (text.includes('update api_keys')) {
      keyWrites += 1;
      throw new Error(`must not revoke api keys: ${text}`);
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
    get keyWrites() {
      return keyWrites;
    },
    sessions,
    keys,
  }) as unknown as Parameters<typeof revokeNamedSession>[0] & {
    writes: number;
    keyWrites: number;
    sessions: SessionRow[];
    keys: KeyRow[];
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SID_A1 = '11111111-1111-4111-8111-111111111111';
const SID_A2 = '22222222-2222-4222-8222-222222222222';
const SID_A_DEAD = '33333333-3333-4333-8333-333333333333';
const SID_B = '44444444-4444-4444-8444-444444444444';
const SID_MISSING = '55555555-5555-4555-8555-555555555555';
const T1 = new Date('2026-01-01T00:00:00.000Z');
const T2 = new Date('2026-02-01T00:00:00.000Z');

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'revoke-session.ts'), 'utf8');
const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');
const routerSrc = readFileSync(join(here, '../session-revoke-router.ts'), 'utf8');

describe('revokeNamedSession', () => {
  it('refuses a missing userId or sessionId and does not write', async () => {
    const sql = sessionStore([{ id: SID_A1, user_id: A, revoked: false, created_at: T1 }]);
    await expect(revokeNamedSession(sql, A, undefined, SID_A1)).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(revokeNamedSession(sql, A, '', SID_A1)).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(revokeNamedSession(sql, A, '   ', SID_A1)).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(revokeNamedSession(sql, A, A, undefined)).rejects.toMatchObject({
      code: 'auth.session_id_missing',
    });
    await expect(revokeNamedSession(sql, A, A, '')).rejects.toMatchObject({
      code: 'auth.session_id_missing',
    });
    await expect(revokeNamedSession(sql, A, A, '   ')).rejects.toMatchObject({
      code: 'auth.session_id_missing',
    });
    expect(() => requireRevokeSessionIds(null, SID_A1)).toThrow(/userId is required/);
    expect(() => requireRevokeSessionIds(A, null)).toThrow(/sessionId is required/);
    expect(sql.writes).toBe(0);
    expect(sql.sessions[0]?.revoked).toBe(false);
  });

  it('revokes one live seat for the named user; sibling seats stay live', async () => {
    const sql = sessionStore(
      [
        { id: SID_A1, user_id: A, revoked: false, created_at: T1 },
        { id: SID_A2, user_id: A, revoked: false, created_at: T2 },
        { id: SID_A_DEAD, user_id: A, revoked: true, created_at: T1 },
        { id: SID_B, user_id: B, revoked: false, created_at: T2 },
      ],
      [{ id: 'k-a', user_id: A, revoked: false }],
    );
    const before = await listSessions(sql, A, 200);
    expect(before.sessions.map((s) => s.id)).toEqual([SID_A2, SID_A1]);

    const out = await revokeNamedSession(sql, A, A, SID_A1);
    expect(out).toEqual({ userId: A, sessionId: SID_A1, revoked: true });
    expect(sql.sessions.find((s) => s.id === SID_A1)?.revoked).toBe(true);
    expect(sql.sessions.find((s) => s.id === SID_A2)?.revoked).toBe(false);
    expect(sql.sessions.find((s) => s.id === SID_B)?.revoked).toBe(false);
    expect(sql.keys[0]?.revoked).toBe(false);
    expect(sql.keyWrites).toBe(0);

    const after = await listSessions(sql, A, 200);
    expect(after.sessions.map((s) => s.id)).toEqual([SID_A2]);

    const liveDoor = new PlaceDoor((async () => [
      { id: SID_A1, user_id: A, revoked: true, expires_at: new Date(Date.now() + 60_000) },
    ]) as never);
    await expect(liveDoor.assertSessionLive(SID_A1)).rejects.toMatchObject({
      code: 'auth.session_revoked',
    });
  });

  it('already-revoked stays revoked (idempotent false)', async () => {
    const sql = sessionStore([{ id: SID_A_DEAD, user_id: A, revoked: true, created_at: T1 }]);
    const out = await revokeNamedSession(sql, A, A, SID_A_DEAD);
    expect(out).toEqual({ userId: A, sessionId: SID_A_DEAD, revoked: false });
    expect(sql.sessions[0]?.revoked).toBe(true);

    const again = await revokeNamedSession(sql, A, A, SID_A_DEAD);
    expect(again.revoked).toBe(false);
    expect(sql.sessions[0]?.revoked).toBe(true);
  });

  it('missing seat is a no-op and does not invent a session', async () => {
    const sql = sessionStore([{ id: SID_A1, user_id: A, revoked: false, created_at: T1 }]);
    const out = await revokeNamedSession(sql, A, A, SID_MISSING);
    expect(out).toEqual({ userId: A, sessionId: SID_MISSING, revoked: false });
    expect(sql.sessions.map((s) => s.id)).toEqual([SID_A1]);
    expect(sql.sessions[0]?.revoked).toBe(false);
  });

  it('does not revoke a different user’s session (no existence leak)', async () => {
    const sql = sessionStore([
      { id: SID_A1, user_id: A, revoked: false, created_at: T1 },
      { id: SID_B, user_id: B, revoked: false, created_at: T2 },
    ]);
    const foreign = await revokeNamedSession(sql, A, B, SID_B);
    expect(foreign).toEqual({ userId: B, sessionId: SID_B, revoked: false });
    expect(sql.writes).toBe(0);
    expect(sql.sessions.find((s) => s.id === SID_B)?.revoked).toBe(false);

    const own = await revokeNamedSession(sql, A, A, SID_A1);
    expect(own).toEqual({ userId: A, sessionId: SID_A1, revoked: true });
    expect(sql.sessions.find((s) => s.id === SID_A1)?.revoked).toBe(true);
    expect(sql.sessions.find((s) => s.id === SID_B)?.revoked).toBe(false);
  });

  it('write door is identity:write; input is both uuids; helper UPDATE is sessions-only', () => {
    expect(src).toMatch(/UPDATE sessions/);
    expect(src).toMatch(/AND user_id = /);
    expect(src).not.toMatch(/UPDATE api_keys/);
    expect(src).not.toMatch(/INSERT /);
    expect(routerSrc).toMatch(/scopedProcedure\('identity:write'\)/);
    expect(routerSrc).toMatch(/userId: z\.string\(\)\.uuid\(\)/);
    expect(routerSrc).toMatch(/sessionId: z\.string\(\)\.uuid\(\)/);
    expect(routerSrc).toMatch(/revokeSession:/);
  });
});

describe('revokeSession is mounted (not helper-only)', () => {
  it('mergeRouters includes createSessionRevokeRouter', () => {
    expect(indexSrc).toMatch(/createSessionRevokeRouter\(sql\)/);
    expect(indexSrc).toMatch(/from ['"]\.\/session-revoke-router\.js['"]/);
  });
});
