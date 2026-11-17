import { describe, expect, it } from 'vitest';
import { PlaceDoor } from './place-door.js';
import { requireSessionUserId, revokeAllSessions } from './revoke-all-sessions.js';

type SessionRow = { id: string; user_id: string; revoked: boolean };

function sessionStore(sessions: SessionRow[]) {
  let writes = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
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
    sessions,
  }) as Parameters<typeof revokeAllSessions>[0] & { writes: number; sessions: SessionRow[] };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('revokeAllSessions', () => {
  it('refuses a missing userId and does not write', async () => {
    const sql = sessionStore([{ id: 's', user_id: A, revoked: false }]);
    await expect(revokeAllSessions(sql, A, undefined)).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(revokeAllSessions(sql, A, '')).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    await expect(revokeAllSessions(sql, A, '   ')).rejects.toMatchObject({
      code: 'auth.user_id_missing',
    });
    expect(() => requireSessionUserId(null)).toThrow(/userId is required/);
    expect(sql.writes).toBe(0);
    expect(sql.sessions[0]?.revoked).toBe(false);
  });

  it('revokes every live session for the named user; already-revoked stay revoked', async () => {
    const sql = sessionStore([
      { id: 'live-1', user_id: A, revoked: false },
      { id: 'live-2', user_id: A, revoked: false },
      { id: 'dead', user_id: A, revoked: true },
    ]);
    const out = await revokeAllSessions(sql, A, A);
    expect(out).toEqual({ userId: A, revoked: 2 });
    expect(sql.sessions.map((s) => s.revoked)).toEqual([true, true, true]);

    const liveDoor = new PlaceDoor((async () => [
      { id: 'live-1', user_id: A, revoked: true, expires_at: new Date(Date.now() + 60_000) },
    ]) as never);
    await expect(liveDoor.assertSessionLive('live-1')).rejects.toMatchObject({
      code: 'auth.session_revoked',
    });
  });

  it('does not revoke a different user’s sessions', async () => {
    const sql = sessionStore([
      { id: 'a-session', user_id: A, revoked: false },
      { id: 'b-session', user_id: B, revoked: false },
    ]);
    const foreign = await revokeAllSessions(sql, A, B);
    expect(foreign).toEqual({ userId: B, revoked: 0 });
    expect(sql.writes).toBe(0);
    expect(sql.sessions.find((s) => s.id === 'b-session')?.revoked).toBe(false);

    const own = await revokeAllSessions(sql, A, A);
    expect(own).toEqual({ userId: A, revoked: 1 });
    expect(sql.sessions.find((s) => s.id === 'a-session')?.revoked).toBe(true);
    expect(sql.sessions.find((s) => s.id === 'b-session')?.revoked).toBe(false);
  });
});
