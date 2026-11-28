/**
 * Unit card — kyc.status / listKycRecords limit unset refuse (no invented 50, no dump)
 *
 * 1. Promise: omitted KYC status-records limit does not dump records or become a default page.
 * 2. Break: listKycRecords(userId) with no LIMIT dressed a blank page as every KYC row.
 * 3. Done bar: kyc.status refuses a missing or out-of-range limit at the door and hands a given one through;
 *    the query carries that exact LIMIT; unset/null/out of 1..200 throw identity.kyc_records_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: router.ts kyc.status; auth-service.ts listKycRecords
 * 6. RED: omitting limit returns every kyc_records row for the user
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { IDENTITY_KYC_STATUS } from '@intafaced/contracts/identity-kyc-procedures';
import { createIdentityRouter } from '../router.js';
import type { RankService } from '../rank/rank-service.js';
import {
  AuthService,
  IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET,
  KYC_RECORDS_LIST_LIMIT_MAX,
  KycRecordsListLimitUnsetError,
  publishedKycRecordsListLimit,
} from './auth-service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authConfig = {
  secret: 'kyc-records-list-limit-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600,
};

function serviceWithUnreachableSql(): { auth: AuthService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when KYC records list limit is unset');
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

describe('kyc.status / listKycRecords limit unset refuse (no invented 50)', () => {
  it('kyc.status requires limit 1..200 and passes input.limit', async () => {
    const calls: unknown[][] = [];
    const auth = partial<AuthService>({
      kycTradingOnly: async () => false,
      kycTier: async () => 'none' as const,
      listKycRecords: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    });
    const api = createIdentityRouter(auth, partial<RankService>({}), { registrationOpen: true }).createCaller(await signedIn());
    await expect(api.kyc.status({ limit: 7 })).resolves.toMatchObject({ records: [] });
    expect(calls).toEqual([[USER, 7]]);
    for (const bad of [{}, { limit: undefined }, { limit: null }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
      const err = await api.kyc.status(bad as never).catch((e: unknown) => e);
      expect((err as { code?: string }).code, JSON.stringify(bad)).toBe('BAD_REQUEST');
    }
    expect(calls).toHaveLength(1);
    // The record is the input schema: the limit is required, an integer in 1..200, with no default.
    for (const limit of [1, 200]) expect(IDENTITY_KYC_STATUS.input.safeParse({ limit }).success).toBe(true);
    for (const limit of [undefined, null, 0, 201, 1.5]) expect(IDENTITY_KYC_STATUS.input.safeParse({ limit }).success).toBe(false);
  });

  it("listKycRecords asks for exactly the published page of this user's records, newest first", async () => {
    const { auth, queries } = serviceOverSql([]);
    await expect(auth.listKycRecords(USER, 7)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toMatch(/FROM kyc_records WHERE user_id = \$\? ORDER BY created_at DESC LIMIT \$\?$/);
    expect(queries[0]?.values).toEqual([USER, 7]);
  });

  it('blank / non-integer / out of 1..200 throws identity.kyc_records_list_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 201, 1.5, Number.NaN]) {
      try {
        publishedKycRecordsListLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(KycRecordsListLimitUnsetError);
        expect((err as KycRecordsListLimitUnsetError).code).toBe(IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 1 and max are published windows', () => {
    expect(publishedKycRecordsListLimit(1)).toBe(1);
    expect(publishedKycRecordsListLimit(KYC_RECORDS_LIST_LIMIT_MAX)).toBe(200);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { auth, sqlCalled } = serviceWithUnreachableSql();
      await expect(auth.listKycRecords(USER, limit)).rejects.toMatchObject({
        name: 'KycRecordsListLimitUnsetError',
        code: IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
