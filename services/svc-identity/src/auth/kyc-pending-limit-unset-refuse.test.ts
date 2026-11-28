/**
 * Unit card — KYC pending + waitlist list limit unset refuse (no invented 50)
 *
 * 1. Promise: omitted list/KYC limit does not become 50. Owner/query may pass 50.
 * 2. Break: `listPendingKyc(input?.limit ?? 50)` and waitlist `limit .default(50)`
 *    dressed a blank page as a chosen window.
 * 3. Done bar: kyc.pending and waitlist.list refuse a missing limit at the door and hand a given one through;
 *    unset/null/out of 1..200 throw identity.kyc_pending_limit_unset before SQL; explicit 50 is
 *    a published window and is the LIMIT the query carries.
 * 4. Class N
 * 5. Paths: router.ts kyc.pending + waitlist.list; auth-service.ts listPendingKyc
 * 6. RED: omitting limit returns a 50-row queue / page
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createIdentityRouter } from '../router.js';
import type { RankService } from '../rank/rank-service.js';
import type { WaitlistService } from '../waitlist/waitlist-service.js';
import {
  IDENTITY_KYC_PENDING_LIMIT_UNSET,
  KYC_PENDING_LIMIT_MAX,
  KycPendingLimitUnsetError,
  publishedKycPendingLimit,
  AuthService,
} from './auth-service.js';

const OPERATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authConfig = {
  secret: 'kyc-pending-limit-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600,
};

function serviceWithUnreachableSql(): { auth: AuthService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when KYC pending limit is unset');
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

async function operator(scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId: OPERATOR, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

const BAD_LIMITS = [{}, { limit: undefined }, { limit: null }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }];
const codeOf = (err: unknown) => (err as { code?: string }).code;

describe('KYC pending + waitlist list limit unset refuse (no invented 50)', () => {
  it('kyc.pending and waitlist.list refuse a missing limit and hand a given one through, never 50 of their own', async () => {
    const pending: unknown[] = [];
    const listed: unknown[] = [];
    const auth = partial<AuthService>({
      listPendingKyc: async (limit: number) => {
        pending.push(limit);
        return [];
      },
    });
    const waitlist = partial<WaitlistService>({
      list: async (input) => {
        listed.push(input);
        return { total: 0, entries: [] };
      },
    });
    const router = createIdentityRouter(auth, partial<RankService>({}), { registrationOpen: true, waitlist });
    const compliance = router.createCaller(await operator(['admin:compliance']));
    const admin = router.createCaller(await operator(['admin:read']));

    await expect(compliance.kyc.pending({ limit: 7 })).resolves.toEqual([]);
    await expect(compliance.kyc.pending({ limit: 50 })).resolves.toEqual([]);
    await expect(admin.waitlist.list({ limit: 7 })).resolves.toEqual({ total: 0, entries: [] });
    expect(pending).toEqual([7, 50]);
    expect(listed).toEqual([{ limit: 7, offset: 0 }]);

    for (const bad of BAD_LIMITS) {
      expect(codeOf(await compliance.kyc.pending(bad as never).catch((e: unknown) => e)), JSON.stringify(bad)).toBe('BAD_REQUEST');
      expect(codeOf(await admin.waitlist.list(bad as never).catch((e: unknown) => e)), JSON.stringify(bad)).toBe('BAD_REQUEST');
    }
    expect(pending).toEqual([7, 50]);
    expect(listed).toHaveLength(1);
  });

  it('listPendingKyc asks for exactly the given page of pending records, oldest first', async () => {
    for (const limit of [1, 50, KYC_PENDING_LIMIT_MAX]) {
      const { auth, queries } = serviceOverSql([]);
      await expect(auth.listPendingKyc(limit)).resolves.toEqual([]);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.text).toMatch(/FROM kyc_records WHERE status = 'pending' ORDER BY created_at ASC LIMIT \$\?$/);
      expect(queries[0]?.values).toEqual([limit]);
    }
  });

  it('blank / non-integer / out of 1..200 throws identity.kyc_pending_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 201, 1.5, Number.NaN]) {
      try {
        publishedKycPendingLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(KycPendingLimitUnsetError);
        expect((err as KycPendingLimitUnsetError).code).toBe(IDENTITY_KYC_PENDING_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 50 and 1 are published windows', () => {
    expect(publishedKycPendingLimit(50)).toBe(50);
    expect(publishedKycPendingLimit(1)).toBe(1);
    expect(publishedKycPendingLimit(KYC_PENDING_LIMIT_MAX)).toBe(200);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { auth, sqlCalled } = serviceWithUnreachableSql();
      await expect(auth.listPendingKyc(limit)).rejects.toMatchObject({
        name: 'KycPendingLimitUnsetError',
        code: IDENTITY_KYC_PENDING_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
