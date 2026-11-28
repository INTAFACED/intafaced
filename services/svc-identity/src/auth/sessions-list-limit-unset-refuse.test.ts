/**
 * Unit card — listSessions limit unset refuse (no invented page, no dump)
 *
 * 1. Promise: omitted live-seats limit does not dump seats or become a default page.
 * 2. Break: listSessions(sql, userId) with no limit dressed a blank page as every live seat.
 * 3. Done bar: listSessions refuses a missing limit at the door; a given one is the page (one more row is asked
 *    for, to know there is a next page); unset/null/out of 1..200 throw identity.sessions_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: list-sessions-router.ts listSessions; list-sessions.ts listSessions
 * 6. RED: omitting limit returns every live seat for the user
 */
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { IDENTITY_LIST_SESSIONS } from '@intafaced/contracts/identity-list-sessions-procedures';
import { createListSessionsRouter } from '../list-sessions-router.js';
import {
  IDENTITY_SESSIONS_LIST_LIMIT_UNSET,
  SESSIONS_LIST_LIMIT_MAX,
  SessionsListLimitUnsetError,
  listSessions,
  publishedSessionsListLimit,
} from './list-sessions.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authConfig = {
  secret: 'sessions-list-limit-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function unreachableSql(): { sql: Parameters<typeof listSessions>[0]; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when sessions list limit is unset');
  }, {}) as never;
  return { sql, sqlCalled: () => sqlCalled };
}

/** Live seat rows, newest first, as the sessions query answers them. */
function seats(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(Date.UTC(2026, 10, 20, 12, 0, 0) - i * 60_000);
    const id = `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`;
    return {
      id,
      family_id: id,
      created_at: at,
      signed_in_at: at,
      last_used_at: at,
      device: null,
      user_agent: null,
      ip: null,
      country: null,
    };
  });
}

/** A `sql` tag that answers the sessions query with `rows` and records the LIMIT it was given. */
function seatsSql(rows: unknown[]): { sql: Parameters<typeof listSessions>[0]; limits: unknown[] } {
  const limits: unknown[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join('').includes('FROM sessions')) {
      expect(strings[strings.length - 2]).toMatch(/LIMIT\s*$/);
      limits.push(values[values.length - 1]);
      return Promise.resolve(rows);
    }
    return Promise.resolve([]);
  };
  return { sql: sql as never, limits };
}

async function own(): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: SESSION, scopes: ['identity:read'], tier: 'none', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

describe('listSessions limit unset refuse (no invented page)', () => {
  it('the listSessions door requires limit 1..200 and pages by the given limit', async () => {
    const { sql, limits } = seatsSql(seats(4));
    const api = createListSessionsRouter(sql as never).createCaller(await own());
    const page = await api.listSessions({ userId: USER, limit: 3 });
    expect(limits).toEqual([4]);
    expect(page.sessions).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    for (const bad of [{}, { limit: undefined }, { limit: null }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
      const err = await api.listSessions({ userId: USER, ...bad } as never).catch((e: unknown) => e);
      expect((err as { code?: string }).code, JSON.stringify(bad)).toBe('BAD_REQUEST');
    }
    expect(limits).toEqual([4]);
    // The record is the input schema: the limit is required, an integer in 1..200, with no default.
    for (const limit of [1, 200])
      expect(IDENTITY_LIST_SESSIONS.input.safeParse({ userId: '11111111-1111-4111-8111-111111111111', limit }).success).toBe(true);
    for (const limit of [undefined, null, 0, 201, 1.5])
      expect(IDENTITY_LIST_SESSIONS.input.safeParse({ userId: '11111111-1111-4111-8111-111111111111', limit }).success).toBe(false);
  });

  it('listSessions asks for one row past the published limit and returns no more than the limit', async () => {
    for (const limit of [1, 5, SESSIONS_LIST_LIMIT_MAX]) {
      const { sql, limits } = seatsSql(seats(limit + 1));
      const out = await listSessions(sql, USER, limit);
      expect(limits).toEqual([limit + 1]);
      expect(out.sessions).toHaveLength(limit);
      expect(out.nextCursor).not.toBeNull();
    }
    const { sql } = seatsSql(seats(2));
    const last = await listSessions(sql, USER, 2);
    expect(last.sessions).toHaveLength(2);
    expect(last.nextCursor).toBeNull();
  });

  it('blank / non-integer / out of 1..200 throws identity.sessions_list_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 201, 1.5, Number.NaN]) {
      try {
        publishedSessionsListLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SessionsListLimitUnsetError);
        expect((err as SessionsListLimitUnsetError).code).toBe(IDENTITY_SESSIONS_LIST_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 1 and max are published windows', () => {
    expect(publishedSessionsListLimit(1)).toBe(1);
    expect(publishedSessionsListLimit(SESSIONS_LIST_LIMIT_MAX)).toBe(200);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { sql, sqlCalled } = unreachableSql();
      await expect(listSessions(sql, USER, limit)).rejects.toMatchObject({
        name: 'SessionsListLimitUnsetError',
        code: IDENTITY_SESSIONS_LIST_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
