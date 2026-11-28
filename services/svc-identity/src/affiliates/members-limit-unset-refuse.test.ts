/**
 * Unit card — affiliates.members / listMembers limit unset refuse (no invented 100)
 *
 * 1. Promise: omitted members limit does not dump the tree or become 100. Owner/query may pass 100.
 * 2. Break: `listMembers(frozen, rootId)` with optional input dressed a blank page as the whole roster.
 * 3. Done bar: no `listMembers(frozen, rootId)` without limit; no `input?.limit`; unset/null/out of
 *    1..500 throw identity.affiliate_members_limit_unset before SQL; explicit 100 is a published window.
 * 4. Class N
 * 5. Paths: router.ts affiliates.members; referral-service.ts listMembers
 * 6. RED: omitting limit returns the whole referral tree
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { AuthService } from '../auth/auth-service.js';
import { contextWith } from '../boot.testkit.js';
import type { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import {
  AFFILIATE_MEMBERS_LIMIT_MAX,
  AffiliateMembersLimitUnsetError,
  IDENTITY_AFFILIATE_MEMBERS_LIMIT_UNSET,
  publishedAffiliateMembersLimit,
  ReferralService,
} from './referral-service.js';

const OPERATOR = '33333333-3333-4333-8333-333333333333';
const ROOT = '44444444-4444-4444-8444-444444444445';

function serviceWithUnreachableSql(): { service: ReferralService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when affiliate members limit is unset');
  }, {}) as never;
  return { service: new ReferralService(sql), sqlCalled: () => sqlCalled };
}

describe('affiliates.members / listMembers limit unset refuse (no invented 100)', () => {
  it('affiliates.members refuses an omitted limit before the store and passes an explicit 100', async () => {
    const asked: unknown[][] = [];
    const referral = partial<ReferralService>({
      listMembers: async (...args: unknown[]) => {
        asked.push(args.slice(1));
        return { members: [], board: { total: 0, frozenInList: 0, maxDepthInList: 0, rootId: (args[1] as string | null) ?? null } };
      },
    });
    const router = createIdentityRouter(partial<AuthService>({}), partial<RankService>({}), { referral });
    const api = router.createCaller(await contextWith(['admin:read'], { userId: OPERATOR }));
    // No input at all, a root with no limit, and limits outside 1..500: refused before the tree is read.
    for (const input of [undefined, {}, { rootId: ROOT }, { limit: 0 }, { limit: 501 }, { rootId: ROOT, limit: 1.5 }]) {
      await expect(api.affiliates.members(input as never), JSON.stringify(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(asked).toEqual([]);
    await expect(api.affiliates.members({ limit: 100 })).resolves.toMatchObject({ members: [], total: 0, rootId: null });
    await expect(api.affiliates.members({ rootId: ROOT, limit: 100 })).resolves.toMatchObject({ rootId: ROOT });
    expect(asked).toEqual([
      [null, 100],
      [ROOT, 100],
    ]);
  });

  it('blank / non-integer / out of 1..500 throws identity.affiliate_members_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedAffiliateMembersLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AffiliateMembersLimitUnsetError);
        expect((err as AffiliateMembersLimitUnsetError).code).toBe(IDENTITY_AFFILIATE_MEMBERS_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 100 and 1 are published windows', () => {
    expect(publishedAffiliateMembersLimit(100)).toBe(100);
    expect(publishedAffiliateMembersLimit(1)).toBe(1);
    expect(publishedAffiliateMembersLimit(AFFILIATE_MEMBERS_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { service, sqlCalled } = serviceWithUnreachableSql();
      await expect(service.listMembers(undefined, null, limit)).rejects.toMatchObject({
        name: 'AffiliateMembersLimitUnsetError',
        code: IDENTITY_AFFILIATE_MEMBERS_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
