/**
 * Unit card — kyc.status / listKycRecords limit unset refuse (no invented 50, no dump)
 *
 * 1. Promise: omitted KYC status-records limit does not dump records or become a default page.
 * 2. Break: listKycRecords(userId) with no LIMIT dressed a blank page as every KYC row.
 * 3. Done bar: no listKycRecords(userId) without limit; no input?.limit / ?? / .default;
 *    unset/null/out of 1..200 throw identity.kyc_records_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: router.ts kyc.status; auth-service.ts listKycRecords
 * 6. RED: omitting limit returns every kyc_records row for the user
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDENTITY_KYC_STATUS } from '@intafaced/contracts/identity-kyc-procedures';
import {
  AuthService,
  IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET,
  KYC_RECORDS_LIST_LIMIT_MAX,
  KycRecordsListLimitUnsetError,
  publishedKycRecordsListLimit,
} from './auth-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function serviceWithUnreachableSql(): { auth: AuthService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when KYC records list limit is unset');
  }, {}) as never;
  const auth = new AuthService(sql, {} as never, {} as never, {
    secret: 'kyc-records-list-limit-test-secret-long-enough',
    issuer: 'intafaced',
    audience: 'intafaced.api',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
  });
  return { auth, sqlCalled: () => sqlCalled };
}

describe('kyc.status / listKycRecords limit unset refuse (no invented 50)', () => {
  it('router.ts requires limit 1..200 and passes input.limit', () => {
    const src = readFileSync(join(HERE, '../router.ts'), 'utf8');
    expect(src).not.toMatch(/listKycRecords\(ctx\.principal\.userId\)\)/);
    expect(src).toMatch(/listKycRecords\(ctx\.principal\.userId, input\.limit\)/);
    expect(src).toMatch(/status: mountRecord\(\s*IDENTITY_KYC_STATUS,/);
    // The record is the input schema: the limit is required, an integer in 1..200, with no default.
    for (const limit of [1, 200]) expect(IDENTITY_KYC_STATUS.input.safeParse({ limit }).success).toBe(true);
    for (const limit of [undefined, null, 0, 201, 1.5]) expect(IDENTITY_KYC_STATUS.input.safeParse({ limit }).success).toBe(false);
    expect(src).not.toMatch(/listKycRecords\([^)]*\?\? 50/);
  });

  it('auth-service.ts does not invent a page via default param', () => {
    const src = readFileSync(join(HERE, 'auth-service.ts'), 'utf8');
    expect(src).not.toMatch(/async listKycRecords\([^)]*limit = /);
    expect(src).toMatch(/publishedKycRecordsListLimit\(limit\)/);
    expect(src).toMatch(/FROM kyc_records WHERE user_id = \$\{userId\} ORDER BY created_at DESC LIMIT \$\{published\}/);
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
