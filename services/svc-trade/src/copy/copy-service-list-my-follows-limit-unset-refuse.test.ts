import { CopyService } from '../controls/test-admission.js';
/**
 * Unit card — CopyService.listMyFollows limit unset refuse (no invented 50)
 *
 * 1. Promise: omitted listMyFollows limit does not dump the caller's follows.
 *    Owner/query may pass 50.
 * 2. Break: `async listMyFollows(principal)` listed every follow for the user
 *    with no page size (leftover after markets list #4140).
 * 3. Done bar: no default 50/100 / no clamp; unset/null/out of 1..500 throw
 *    typed `trade.list_my_follows_limit_unset` before the store; explicit 50
 *    is a published window.
 * 4. Class N
 * 5. Paths: copy-service.ts CopyService.listMyFollows
 * 6. RED: omitting limit returns every follow for the caller
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '@intafaced/ledger-client';
import {
  LIST_MY_FOLLOWS_LIMIT_MAX,
  ListMyFollowsLimitUnsetError,
  publishedListMyFollowsLimit,
  TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET,
} from './copy-service.js';
import { MemoryCopyFollowStore } from './follow-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const principal = { userId: '00000000-0000-4000-8000-000000000001' } as import('@intafaced/auth').Principal;

describe('CopyService.listMyFollows limit unset refuse (no invented 50)', () => {
  it('copy-service.ts does not invent 50/100 via default or clamp', () => {
    const src = readFileSync(join(HERE, 'copy-service.ts'), 'utf8');
    expect(src).toMatch(/async listMyFollows\(principal: Principal, limit\?: number\)/);
    expect(src).toMatch(/publishedListMyFollowsLimit\(limit\)/);
    expect(src).not.toMatch(/async listMyFollows[\s\S]{0,400}Math\.min\(Math\.max\(/);
    expect(src).not.toMatch(/listMyFollows[\s\S]{0,200}\?\? 50/);
  });

  it('blank / non-integer / out of 1..500 throws trade.list_my_follows_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 501, 1.5, Number.NaN]) {
      try {
        publishedListMyFollowsLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ListMyFollowsLimitUnsetError);
        expect((err as ListMyFollowsLimitUnsetError).code).toBe(TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 50 and 1 are published windows', () => {
    expect(publishedListMyFollowsLimit(50)).toBe(50);
    expect(publishedListMyFollowsLimit(1)).toBe(1);
    expect(publishedListMyFollowsLimit(LIST_MY_FOLLOWS_LIMIT_MAX)).toBe(500);
  });

  it('omitted / undefined / null listMyFollows limit refuses before the store', async () => {
    class SpyStore extends MemoryCopyFollowStore {
      listed = false;
      override async listFollowsByFollower(followerId: string, limit?: number) {
        this.listed = true;
        return super.listFollowsByFollower(followerId, limit);
      }
    }
    for (const limit of [undefined, null] as unknown as number[]) {
      const store = new SpyStore();
      const svc = new CopyService(new MemoryLedger(), { store });
      await expect(svc.listMyFollows(principal, limit)).rejects.toMatchObject({
        name: 'ListMyFollowsLimitUnsetError',
        code: TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET,
      });
      expect(store.listed).toBe(false);
    }
  });
});
