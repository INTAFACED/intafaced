/**
 * Unit card — affiliates.freezes / FreezeService.list limit unset refuse (no invented 100)
 *
 * 1. Promise: omitted freezes limit does not dump the ledger or become 100. Owner/query may pass 100.
 * 2. Break: `list()` with no window dressed a blank page as the whole freeze roster.
 * 3. Done bar: no `list()` without limit; no `input?.limit`; unset/null/out of
 *    1..500 throw identity.affiliate_freezes_limit_unset before SQL; explicit 100 is a published window.
 * 4. Class N
 * 5. Paths: router.ts affiliates.freezes; freeze-service.ts list
 * 6. RED: omitting limit returns the whole affiliate_freezes table
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { AuthService } from '../auth/auth-service.js';
import { contextWith } from '../boot.testkit.js';
import type { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import {
  AFFILIATE_FREEZES_LIMIT_MAX,
  AffiliateFreezesLimitUnsetError,
  FreezeService,
  IDENTITY_AFFILIATE_FREEZES_LIMIT_UNSET,
  publishedAffiliateFreezesLimit,
} from './freeze-service.js';

const OPERATOR = '33333333-3333-4333-8333-333333333333';

function serviceWithUnreachableSql(): { service: FreezeService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when affiliate freezes limit is unset');
  }, {}) as never;
  return { service: new FreezeService(sql), sqlCalled: () => sqlCalled };
}

describe('affiliates.freezes / FreezeService.list limit unset refuse (no invented 100)', () => {
  it('affiliates.freezes refuses an omitted limit before the store and passes an explicit 100', async () => {
    const asked: unknown[][] = [];
    const freeze = partial<FreezeService>({
      list: async (...args: unknown[]) => {
        asked.push(args);
        return [];
      },
    });
    const router = createIdentityRouter(partial<AuthService>({}), partial<RankService>({}), { freeze });
    const customer = router.createCaller(await contextWith(['identity:read', 'identity:write']));
    await expect(customer.affiliates.freezes({ limit: 100 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const api = router.createCaller(await contextWith(['admin:read'], { userId: OPERATOR }));
    for (const input of [undefined, {}, { limit: 0 }, { limit: 501 }, { limit: 1.5 }]) {
      await expect(api.affiliates.freezes(input as never), JSON.stringify(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(asked).toEqual([]);
    await expect(api.affiliates.freezes({ limit: 100 })).resolves.toEqual([]);
    expect(asked).toEqual([[100]]);
  });

  it('an explicit limit reaches the query as its LIMIT', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    }) as never;
    await expect(new FreezeService(sql).list(100)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toMatch(/FROM affiliate_freezes[\s\S]*LIMIT \?\s*$/);
    expect(queries[0]!.values).toEqual([100]);
  });

  it('blank / non-integer / out of 1..500 throws identity.affiliate_freezes_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedAffiliateFreezesLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AffiliateFreezesLimitUnsetError);
        expect((err as AffiliateFreezesLimitUnsetError).code).toBe(IDENTITY_AFFILIATE_FREEZES_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 100 and 1 are published windows', () => {
    expect(publishedAffiliateFreezesLimit(100)).toBe(100);
    expect(publishedAffiliateFreezesLimit(1)).toBe(1);
    expect(publishedAffiliateFreezesLimit(AFFILIATE_FREEZES_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { service, sqlCalled } = serviceWithUnreachableSql();
      await expect(service.list(limit)).rejects.toMatchObject({
        name: 'AffiliateFreezesLimitUnsetError',
        code: IDENTITY_AFFILIATE_FREEZES_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
