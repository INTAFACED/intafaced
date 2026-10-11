import { CopyService } from './controls/test-admission.js';
/**
 * Unit card — tRPC copy.listMyFollows optional limit → named refuse (no invented 50)
 *
 * 1. Promise: listMyFollows without limit does not dump the caller's follows.
 *    Owner may pass 50.
 * 2. Break: scopedProcedure with no input called CopyService.listMyFollows unbounded.
 * 3. Done bar: optional tRPC limit; omit/undefined hits trade.list_my_follows_limit_unset;
 *    explicit 50 reaches CopyService.listMyFollows.
 * 4. Class N
 * 5. Paths: router.ts copy.listMyFollows
 * 6. RED: omitting limit returns every follow for the caller
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTradeRouter } from './router.js';
import { TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET } from './copy/copy-service.js';
import type { TradeService } from './spot/trade-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'a-trade-list-my-follows-limit-test-edge-secret';
const FOLLOWER = '00000000-0000-4000-8000-000000000001';
const SESSION = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function signed() {
  const p = {
    sub: FOLLOWER,
    userId: FOLLOWER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-list-my-follows',
  });
}

describe('tRPC copy.listMyFollows limit unset refuse (no invented 50)', () => {
  it('router.ts does not invent 50 when listMyFollows omits limit', () => {
    const src = readFileSync(join(HERE, 'router.ts'), 'utf8');
    const start = src.indexOf('listMyFollows: scopedProcedure');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('closeFollowsInClosedRegions:', start));
    expect(fn).toContain('limit: z.number().optional()');
    expect(fn).toContain('publishedListMyFollowsLimit(input?.limit)');
    expect(fn).not.toMatch(/\?\? 50/);
    expect(fn).not.toMatch(/\?\? 100/);
  });

  it('omit / undefined limit is named refuse; owner-explicit 50 reaches CopyService', async () => {
    const seen: Array<number | undefined> = [];
    const copy = {
      listMyFollows: async (_principal: Principal, limit?: number) => {
        seen.push(limit);
        return [];
      },
    } as unknown as CopyService;
    const caller = createTradeRouter({} as unknown as TradeService, undefined, copy).createCaller(signed());

    await expect(caller.copy.listMyFollows()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining(TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET),
    });
    await expect(caller.copy.listMyFollows({})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining(TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET),
    });
    expect(seen).toEqual([]);

    await expect(caller.copy.listMyFollows({ limit: 50 })).resolves.toEqual([]);
    expect(seen).toEqual([50]);
  });
});
