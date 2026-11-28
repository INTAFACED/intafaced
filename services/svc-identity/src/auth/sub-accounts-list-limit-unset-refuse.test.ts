/**
 * Unit card — subAccounts.list limit unset refuse (no invented 50, no dump)
 *
 * 1. Promise: omitted partition list limit does not dump books or become a default page.
 * 2. Break: listSubAccounts(userId) with no LIMIT dressed a blank page as every partition.
 * 3. Done bar: subAccounts.list refuses a missing or out-of-range limit at the door and hands a given one through;
 *    the query carries that exact LIMIT; unset/null/out of 1..200 throw identity.sub_accounts_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: router.ts subAccounts.list; auth-service.ts listSubAccounts
 * 6. RED: omitting limit returns every sub_accounts row for the parent
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createIdentityRouter } from '../router.js';
import type { RankService } from '../rank/rank-service.js';
import {
  AuthService,
  IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET,
  SUB_ACCOUNTS_LIST_LIMIT_MAX,
  SubAccountsListLimitUnsetError,
  publishedSubAccountsListLimit,
} from './auth-service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authConfig = {
  secret: 'sub-accounts-list-limit-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600,
};

function serviceWithUnreachableSql(): { auth: AuthService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when sub-accounts list limit is unset');
  }, {}) as never;
  const auth = new AuthService(sql, {} as never, {} as never, authConfig);
  return { auth, sqlCalled: () => sqlCalled };
}

/** A service over a `sql` tag that records each query's text (values as `$?`) and its values. */
function serviceOverSql(rows: unknown[]): { auth: AuthService; queries: Array<{ text: string; values: unknown[] }> } {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('$?').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve(rows);
  };
  return { auth: new AuthService(sql as never, {} as never, {} as never, authConfig), queries };
}

async function signedIn(): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: SESSION, scopes: ['identity:read'], tier: 'none', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

describe('subAccounts.list / listSubAccounts limit unset refuse (no invented 50)', () => {
  it('subAccounts.list requires limit 1..200 and passes input.limit', async () => {
    const calls: unknown[][] = [];
    const auth = partial<AuthService>({
      listSubAccounts: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    });
    const api = createIdentityRouter(auth, partial<RankService>({}), { registrationOpen: true }).createCaller(await signedIn());
    await expect(api.subAccounts.list({ limit: 7 })).resolves.toEqual([]);
    await expect(api.subAccounts.list({ limit: 200 })).resolves.toEqual([]);
    expect(calls).toEqual([
      [USER, 7],
      [USER, 200],
    ]);
    for (const bad of [{}, { limit: undefined }, { limit: null }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
      const err = await api.subAccounts.list(bad as never).catch((e: unknown) => e);
      expect((err as { code?: string }).code, JSON.stringify(bad)).toBe('BAD_REQUEST');
    }
    expect(calls).toHaveLength(2);
  });

  it("listSubAccounts asks for exactly the published page of this parent's partitions, newest first", async () => {
    const { auth, queries } = serviceOverSql([]);
    await expect(auth.listSubAccounts(USER, 7)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toMatch(/FROM sub_accounts WHERE parent_user_id = \$\? ORDER BY created_at DESC LIMIT \$\?$/);
    expect(queries[0]?.values).toEqual([USER, 7]);
  });

  it('blank / non-integer / out of 1..200 throws identity.sub_accounts_list_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 201, 1.5, Number.NaN]) {
      try {
        publishedSubAccountsListLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SubAccountsListLimitUnsetError);
        expect((err as SubAccountsListLimitUnsetError).code).toBe(IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 1 and max are published windows', () => {
    expect(publishedSubAccountsListLimit(1)).toBe(1);
    expect(publishedSubAccountsListLimit(SUB_ACCOUNTS_LIST_LIMIT_MAX)).toBe(200);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { auth, sqlCalled } = serviceWithUnreachableSql();
      await expect(auth.listSubAccounts(USER, limit)).rejects.toMatchObject({
        name: 'SubAccountsListLimitUnsetError',
        code: IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
