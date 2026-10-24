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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AFFILIATE_MEMBERS_LIMIT_MAX,
  AffiliateMembersLimitUnsetError,
  IDENTITY_AFFILIATE_MEMBERS_LIMIT_UNSET,
  publishedAffiliateMembersLimit,
  ReferralService,
} from './referral-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function serviceWithUnreachableSql(): { service: ReferralService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when affiliate members limit is unset');
  }, {}) as never;
  return { service: new ReferralService(sql), sqlCalled: () => sqlCalled };
}

describe('affiliates.members / listMembers limit unset refuse (no invented 100)', () => {
  it('router.ts does not invent 100 via optional input or input?.limit', () => {
    const src = readFileSync(join(HERE, '../router.ts'), 'utf8');
    expect(src).not.toMatch(/listMembers\(frozen, rootId\)(?!\s*,)/);
    expect(src).toMatch(/listMembers\(frozen, rootId, input\.limit\)/);
    expect(src).not.toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.optional\(\)/);
    expect(src).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)/);
    expect(src).not.toMatch(/z\.object\(\{ rootId: z\.string\(\)\.guid\(\)\.optional\(\) \}\)\.optional\(\)/);
  });

  it('referral-service.ts does not invent 100 via default param', () => {
    const src = readFileSync(join(HERE, 'referral-service.ts'), 'utf8');
    expect(src).not.toMatch(/async listMembers\([^)]*limit = 100/);
    expect(src).toMatch(/publishedAffiliateMembersLimit\(limit\)/);
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
