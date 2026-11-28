import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { IDENTITY_LIST_SESSIONS } from '@intafaced/contracts/identity-list-sessions-procedures';
import { createListSessionsRouter } from '../list-sessions-router.js';
import { listSessions, requireListSessionsUserId, SESSIONS_LIST_LIMIT_MAX } from './list-sessions.js';
import { panicRevoke } from './panic-revoke.js';

type SessionRow = {
  id: string;
  user_id: string;
  revoked: boolean;
  created_at: Date;
  refresh_hash: string;
};

function sessionStore(sessions: SessionRow[]) {
  let writes = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.trim() === 'true') return [];
    if (text.includes('select') && text.includes('from sessions') && text.includes('created_at')) {
      const named = values[0];
      const lastValue = values[values.length - 1];
      const limit = typeof lastValue === 'number' ? lastValue : sessions.length;
      return sessions
        .filter((s) => s.user_id === named && s.revoked === false)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .slice(0, limit)
        .map((s) => ({
          id: s.id,
          family_id: s.id,
          created_at: s.created_at,
          signed_in_at: s.created_at,
          last_used_at: s.created_at,
          device: null,
          user_agent: null,
          ip: null,
          country: null,
        }));
    }
    if (text.includes('select') && text.includes('from sessions')) {
      const named = values[0];
      return sessions.filter((s) => s.user_id === named && s.revoked === false).map((s) => ({ id: s.id }));
    }
    if (text.includes('update api_keys')) {
      writes += 1;
      return [];
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
    sessions,
  }) as Parameters<typeof listSessions>[0] & { writes: number; sessions: SessionRow[] };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SID_A1 = '11111111-1111-4111-8111-111111111111';
const SID_A2 = '22222222-2222-4222-8222-222222222222';
const SID_A_DEAD = '33333333-3333-4333-8333-333333333333';
const SID_B = '44444444-4444-4444-8444-444444444444';
const T1 = new Date('2026-01-01T00:00:00.000Z');
const T2 = new Date('2026-02-01T00:00:00.000Z');
const T3 = new Date('2026-03-01T00:00:00.000Z');

function liveRow(id: string, createdAt: Date) {
  return {
    id,
    familyId: id,
    createdAt,
    lastUsedAt: createdAt,
    device: null,
    userAgent: null,
    ip: null,
    country: null,
    isCurrent: false,
    revoked: false,
  };
}

/** A `sql` tag whose live seat row still carries its refresh hash, recording each query (lowercased) and its values. */
function secretSessionsSql() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase().replace(/\s+/g, ' ').trim();
    queries.push({ text, values });
    if (!text.includes('from sessions s')) return [];
    return [
      {
        id: SID_A1,
        family_id: SID_A1,
        created_at: T1,
        signed_in_at: T1,
        last_used_at: T1,
        device: null,
        user_agent: null,
        ip: null,
        country: null,
        refresh_hash: 'secret-refresh-hash',
      },
    ];
  };
  return { sql: fn as Parameters<typeof listSessions>[0], queries };
}

const edgeAuth = { secret: 'list-sessions-test-secret-long-enough', issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };

/** The caller's own signed-in seat. */
async function ownSeat(userId: string): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SID_A1, scopes: ['identity:read'], tier: 'none', mfa: true }, edgeAuth);
  return { principal: await verifyAccessToken(token, edgeAuth), service: null, region: 'DE', requestId: 'req-1' };
}

describe('listSessions', () => {
  it('refuses a missing userId and does not write', async () => {
    const sql = sessionStore([
      { id: SID_A1, user_id: A, revoked: false, created_at: T1, refresh_hash: 'secret-a' },
      { id: SID_B, user_id: B, revoked: false, created_at: T2, refresh_hash: 'secret-b' },
    ]);
    await expect(listSessions(sql, undefined, SESSIONS_LIST_LIMIT_MAX)).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(listSessions(sql, '', SESSIONS_LIST_LIMIT_MAX)).rejects.toMatchObject({ code: 'auth.user_id_missing' });
    await expect(listSessions(sql, '   ', SESSIONS_LIST_LIMIT_MAX)).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    expect(() => requireListSessionsUserId(null)).toThrow(/userId is required/);
    expect(sql.writes).toBe(0);
  });

  it('lists live session ids/createdAt/revoked=false for that user only', async () => {
    const sql = sessionStore([
      { id: SID_A1, user_id: A, revoked: false, created_at: T1, refresh_hash: 'secret-a1' },
      { id: SID_A2, user_id: A, revoked: false, created_at: T2, refresh_hash: 'secret-a2' },
      { id: SID_A_DEAD, user_id: A, revoked: true, created_at: T3, refresh_hash: 'secret-dead' },
      { id: SID_B, user_id: B, revoked: false, created_at: T3, refresh_hash: 'secret-b' },
    ]);
    const out = await listSessions(sql, A, SESSIONS_LIST_LIMIT_MAX);
    expect(out.userId).toBe(A);
    expect(out.sessions).toEqual([liveRow(SID_A2, T2), liveRow(SID_A1, T1)]);
    expect(out.sessions.every((s) => s.revoked === false)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/secret/);
    expect(JSON.stringify(out)).not.toMatch(/refresh/);
  });

  it('does not return a different user’s sessions', async () => {
    const sql = sessionStore([
      { id: SID_A1, user_id: A, revoked: false, created_at: T1, refresh_hash: 'secret-a' },
      { id: SID_B, user_id: B, revoked: false, created_at: T2, refresh_hash: 'secret-b' },
    ]);
    const out = await listSessions(sql, A, SESSIONS_LIST_LIMIT_MAX);
    expect(out.sessions.map((s) => s.id)).toEqual([SID_A1]);
    expect(out.sessions.some((s) => s.id === SID_B)).toBe(false);
  });

  it('is empty after panic for that user; the other user stays live', async () => {
    const sql = sessionStore([
      { id: SID_A1, user_id: A, revoked: false, created_at: T1, refresh_hash: 'secret-a' },
      { id: SID_B, user_id: B, revoked: false, created_at: T2, refresh_hash: 'secret-b' },
    ]);
    const before = await listSessions(sql, A, SESSIONS_LIST_LIMIT_MAX);
    expect(before.sessions).toHaveLength(1);
    await panicRevoke(sql, A, A);
    const after = await listSessions(sql, A, SESSIONS_LIST_LIMIT_MAX);
    expect(after.sessions).toEqual([]);
    const other = await listSessions(sql, B, SESSIONS_LIST_LIMIT_MAX);
    expect(other.sessions).toEqual([liveRow(SID_B, T2)]);
  });

  it('never selects refresh_hash or other secrets', async () => {
    // The query it sends: the named columns, never refresh_hash or *, one row past the limit.
    const { sql, queries } = secretSessionsSql();
    await listSessions(sql, A, 3);
    const query = queries.find((q) => q.text.includes('from sessions s'));
    expect(query?.text).toMatch(/^select id, family_id, created_at, signed_in_at, last_used_at, device, user_agent, ip, country /);
    expect(query?.text).not.toMatch(/refresh_hash/);
    expect(query?.text).not.toMatch(/select \*/);
    expect(query?.text).toMatch(/limit \?$/);
    expect(query?.values[query.values.length - 1]).toBe(4);
    // The door the record mounts: a row that still carried a refresh hash never puts it on the wire.
    const door = createListSessionsRouter(sql).createCaller(await ownSeat(A));
    const answer = await door.listSessions({ userId: A, limit: 3 });
    expect(answer.sessions.map((s) => s.id)).toEqual([SID_A1]);
    expect(JSON.stringify(answer)).not.toMatch(/secret|refresh/);
    expect(queries.filter((q) => q.text.includes('from sessions s')).map((q) => q.values[q.values.length - 1])).toEqual([4, 4]);
    expect(IDENTITY_LIST_SESSIONS.access).toEqual({ caller: 'scope', scope: 'identity:read' });
    expect(IDENTITY_LIST_SESSIONS.input.safeParse({ userId: 'not-a-uuid', limit: 1 }).success).toBe(false);
    expect(IDENTITY_LIST_SESSIONS.input.safeParse({ userId: '11111111-1111-4111-8111-111111111111', limit: 1 }).success).toBe(true);
    expect(IDENTITY_LIST_SESSIONS.input.safeParse({ userId: '11111111-1111-4111-8111-111111111111', limit: 201 }).success).toBe(false);
    // No secret on the wire: each session the answer carries names none of the refresh or token fields.
    for (const field of Object.keys(IDENTITY_LIST_SESSIONS.output.shape.sessions.element.shape)) {
      expect(field).not.toMatch(/refresh|hash|token|secret/i);
    }
    // The door is the record mounted: what the record's input refuses, the door refuses before any query.
    const before = queries.length;
    for (const bad of [
      { userId: 'not-a-uuid', limit: 1 },
      { userId: A, limit: 201 },
    ]) {
      const err = await door.listSessions(bad).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('BAD_REQUEST');
    }
    expect(queries).toHaveLength(before);
  });
});
