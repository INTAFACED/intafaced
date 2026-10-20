/**
 * Unit card — listSessions limit unset refuse (no invented page, no dump)
 *
 * 1. Promise: omitted live-seats limit does not dump seats or become a default page.
 * 2. Break: listSessions(sql, userId) with no limit dressed a blank page as every live seat.
 * 3. Done bar: no listSessions(sql, userId) without limit; no input?.limit / ?? / .default;
 *    unset/null/out of 1..200 throw identity.sessions_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: list-sessions-router.ts listSessions; list-sessions.ts listSessions
 * 6. RED: omitting limit returns every live seat for the user
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_SESSIONS_LIST_LIMIT_UNSET,
  SESSIONS_LIST_LIMIT_MAX,
  SessionsListLimitUnsetError,
  listSessions,
  publishedSessionsListLimit,
} from './list-sessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function unreachableSql(): { sql: Parameters<typeof listSessions>[0]; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when sessions list limit is unset');
  }, {}) as never;
  return { sql, sqlCalled: () => sqlCalled };
}

describe('listSessions limit unset refuse (no invented page)', () => {
  it('list-sessions-router.ts requires limit 1..200 and passes input.limit', () => {
    const src = readFileSync(join(HERE, '../list-sessions-router.ts'), 'utf8');
    expect(src).not.toMatch(/listSessions\(sql, input\.userId\)\s*;/);
    expect(src).toMatch(/listSessions\(sql, input\.userId, input\.limit,/);
    expect(src).not.toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)\.optional\(\)/);
    expect(src).not.toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)\.default\(/);
    expect(src).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
    expect(src).not.toMatch(/\?\? 50|\?\? 100|limit = 50|limit = 100/);
  });

  it('list-sessions.ts does not invent a page via default param', () => {
    const src = readFileSync(join(HERE, 'list-sessions.ts'), 'utf8');
    expect(src).not.toMatch(/limit = 50|limit = 100/);
    expect(src).toMatch(/publishedSessionsListLimit\(limit\)/);
    expect(src).toMatch(/LIMIT \$\{published \+ 1\}/);
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
