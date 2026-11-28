/**
 * Unit card — myAccruals / listByBeneficiary limit unset refuse (no invented 100)
 *
 * 1. Promise: omitted accruals limit does not become 100. Owner/query may pass 100.
 * 2. Break: `listByBeneficiary(..., limit = 100)` and `input?.limit` dressed a
 *    blank page as a chosen 100-row window.
 * 3. Done bar: no `limit = 100` / `input?.limit`; unset/null/out of 1..500 throw
 *    identity.accruals_limit_unset before SQL; explicit 100 is a published window.
 * 4. Class N
 * 5. Paths: router.ts affiliates.myAccruals; accrual-store.ts listByBeneficiary
 * 6. RED: omitting limit returns a 100-row accrual page
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { AuthService } from '../auth/auth-service.js';
import { contextWith } from '../boot.testkit.js';
import type { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import {
  ACCRUALS_LIMIT_MAX,
  type AccrualStore,
  AccrualsLimitUnsetError,
  IDENTITY_ACCRUALS_LIMIT_UNSET,
  MemoryAccrualStore,
  publishedAccrualsLimit,
  SqlAccrualStore,
} from './accrual-store.js';

const REF = '22222222-2222-4222-8222-222222222222';

function sqlStoreUnreachable(): { store: SqlAccrualStore; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when accruals limit is unset');
  }, {}) as never;
  return { store: new SqlAccrualStore(sql), sqlCalled: () => sqlCalled };
}

describe('myAccruals / listByBeneficiary limit unset refuse (no invented 100)', () => {
  it('affiliates.myAccruals refuses an omitted limit before the store and passes an explicit 100', async () => {
    const asked: Array<[string, number]> = [];
    const accruals = partial<AccrualStore>({
      listByBeneficiary: async (beneficiaryId: string, limit: number) => {
        asked.push([beneficiaryId, limit]);
        return [];
      },
    });
    const router = createIdentityRouter(partial<AuthService>({}), partial<RankService>({}), { accruals });
    const api = router.createCaller(await contextWith(['identity:read'], { userId: REF }));
    for (const input of [{}, { limit: undefined }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }]) {
      await expect(api.affiliates.myAccruals(input as never), JSON.stringify(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(asked).toEqual([]);
    await expect(api.affiliates.myAccruals({ limit: 100 })).resolves.toEqual({ rows: [] });
    expect(asked).toEqual([[REF, 100]]);
  });

  it('blank / non-integer / out of 1..500 throws identity.accruals_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedAccrualsLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AccrualsLimitUnsetError);
        expect((err as AccrualsLimitUnsetError).code).toBe(IDENTITY_ACCRUALS_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 100 and 1 are published windows', () => {
    expect(publishedAccrualsLimit(100)).toBe(100);
    expect(publishedAccrualsLimit(1)).toBe(1);
    expect(publishedAccrualsLimit(ACCRUALS_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { store, sqlCalled } = sqlStoreUnreachable();
      await expect(store.listByBeneficiary(REF, limit)).rejects.toMatchObject({
        name: 'AccrualsLimitUnsetError',
        code: IDENTITY_ACCRUALS_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });

  it('memory store omit refuses; explicit 100 pages without inventing a default', async () => {
    const store = new MemoryAccrualStore();
    await expect(store.listByBeneficiary(REF, undefined as unknown as number)).rejects.toMatchObject({
      name: 'AccrualsLimitUnsetError',
      code: IDENTITY_ACCRUALS_LIMIT_UNSET,
    });
    await expect(store.listByBeneficiary(REF, 100)).resolves.toEqual([]);
  });
});
