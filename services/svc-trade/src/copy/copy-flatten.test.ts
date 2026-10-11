import { CopyService } from '../controls/test-admission.js';
/**
 * PTX-M26-R05 — explicit follower flatten.
 *
 * One door. Pause/stop/detach never call it. Missing follow refuses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import type { PlaceFollowerOrderPort } from './auto-mirror-place.js';

import { MemoryCopyFollowStore } from './follow-store.js';
import { applyCopyFlatten, flattenFollowerCopyPosition, presentCopyFlattenAck } from './copy-flatten.js';
import type { FlattenCopyPositionPort } from './copy-flatten.js';
import type { CopyFollow } from './follows.js';

const SECRET = 'copy-flatten-edge-secret-32bytes-xx';
const FOLLOWER = '11111111-1111-4111-8111-111111111111';
const LEADER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const futureExpiry = '2026-12-01T00:00:00.000Z';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function principal(userId = FOLLOWER): Principal {
  return {
    sub: userId,
    userId,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(userId = FOLLOWER) {
  const raw = encodePrincipal(principal(userId));
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: `req-copy-flatten-${userId}`,
  });
}

const publishedFee = {
  published: true as const,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};

const publishedJur = { published: true as const, allowedRegions: ['SG'] };

function wiredCopy(opts: { flatten?: FlattenCopyPositionPort; place?: PlaceFollowerOrderPort } = {}) {
  return new CopyService(new MemoryLedger(), {
    feeShareLaw: publishedFee,
    jurisdictionLaw: publishedJur,
    placeMirrorEnabled: true,
    inspectMarket: async () => ({ paper: false }),
    placeFollowerOrder: opts.place ?? (async () => ({ orderId: 'ord-unused' })),
    store: new MemoryCopyFollowStore(),
    flattenCopyPosition: opts.flatten,
    lookupLeaderFill: async (fillId) => ({
      fillId,
      userId: LEADER,
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: parseAmount('0.01'),
      notional: parseAmount('50'),
    }),
  });
}

async function openFollow(copy: CopyService) {
  return copy.follow(principal(), {
    leaderId: LEADER,
    region: 'SG',
    permittedMarkets: ['BTC-USDT'],
    maxNotionalPerOrder: '100',
    maxAggregateExposure: '1000',
    expiresAt: futureExpiry,
  });
}

const sampleFollow: CopyFollow = {
  followId: 'follow-1',
  followerId: FOLLOWER,
  leaderId: LEADER,
  envelope: {
    permittedMarkets: ['BTC-USDT'],
    maxNotionalPerOrder: parseAmount('100'),
    maxAggregateExposure: parseAmount('1000'),
    expiresAt: new Date(futureExpiry),
  },
  region: 'SG',
  createdAt: new Date('2026-08-14T00:00:00.000Z'),
  feeShareKilled: false,
};

describe('trade.copy flatten (PTX-M26-R05)', () => {
  it('flattenFollowerCopyPosition is the one door and refuses when unwired', async () => {
    await expect(flattenFollowerCopyPosition(principal(), sampleFollow, null)).rejects.toMatchObject({
      code: 'trade.copy_flatten_refused',
    });
    const closed = await flattenFollowerCopyPosition(principal(), sampleFollow, async () => ({
      orderIds: ['ord-flat-1'],
    }));
    expect(closed.orderIds).toEqual(['ord-flat-1']);
    const next = applyCopyFlatten(sampleFollow);
    expect(presentCopyFlattenAck(next, closed.orderIds)).toEqual({
      followId: 'follow-1',
      relationshipState: 'DETACHED',
      disposition: 'DETACH_FLATTEN',
      newIntentFenced: true,
      flattenChosen: true,
      flattenInvented: false,
      sessionKeyRevoked: true,
      orderIds: ['ord-flat-1'],
    });
  });

  it('missing follow id or unknown follow refuses flatten', async () => {
    const flattenCalls: string[] = [];
    const copy = wiredCopy({
      flatten: async (_p, input) => {
        flattenCalls.push(input.followId);
        return { orderIds: [] };
      },
    });
    await expect(copy.flatten(principal(), { followId: '   ' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    await expect(copy.flatten(principal(), { followId: '' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    await expect(copy.flatten(principal(), { followId: 'missing-follow' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    expect(flattenCalls).toEqual([]);
  });

  it('flatten closes the copy position; pause/stop/detach never call the door', async () => {
    const flattenCalls: string[] = [];
    const copy = wiredCopy({
      flatten: async (_p, input) => {
        flattenCalls.push(input.followId);
        return { orderIds: ['ord-flat'] };
      },
    });
    const follow = await openFollow(copy);

    await copy.pause(principal(), { followId: follow.followId });
    expect(flattenCalls).toEqual([]);
    await copy.resume(principal(), { followId: follow.followId });

    await copy.stop(principal(), { followId: follow.followId });
    expect(flattenCalls).toEqual([]);

    const other = wiredCopy({
      flatten: async (_p, input) => {
        flattenCalls.push(`detach:${input.followId}`);
        return { orderIds: [] };
      },
    });
    const kept = await openFollow(other);
    await other.detach(principal(), { followId: kept.followId });
    expect(flattenCalls).toEqual([]);

    const acked = await copy.flatten(principal(), { followId: follow.followId });
    expect(flattenCalls).toEqual([follow.followId]);
    expect(acked).toMatchObject({
      followId: follow.followId,
      relationshipState: 'DETACHED',
      disposition: 'DETACH_FLATTEN',
      newIntentFenced: true,
      flattenChosen: true,
      flattenInvented: false,
      sessionKeyRevoked: true,
      orderIds: ['ord-flat'],
    });
    await expect(
      copy.planMirrorForFollow(principal(), {
        followId: follow.followId,
        fillId: 'fill-after-flatten',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '50',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_detached' });
  });

  it('unwired flatten port refuses rather than invent a close', async () => {
    const copy = wiredCopy();
    const follow = await openFollow(copy);
    await expect(copy.flatten(principal(), { followId: follow.followId })).rejects.toMatchObject({
      code: 'trade.copy_flatten_refused',
    });
  });

  it('pause/stop/detach source never calls flattenFollowerCopyPosition', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'copy-service.ts'), 'utf8');
    const pause = src.slice(src.indexOf('async pause('), src.indexOf('async resume('));
    const stop = src.slice(src.indexOf('async stop('), src.indexOf('async detach('));
    const detach = src.slice(src.indexOf('async detach('), src.indexOf('async flatten('));
    for (const body of [pause, stop, detach]) {
      expect(body).not.toMatch(/flattenFollowerCopyPosition/);
      expect(body).not.toMatch(/flattenCopyPosition/);
      expect(body).not.toMatch(/this\.flatten\(/);
    }
    expect(src).toMatch(/async flatten\(/);
    expect(src).toMatch(/flattenFollowerCopyPosition/);
  });

  it('product mount: copy.flatten is the door; missing follow is NOT_FOUND', async () => {
    const flattenCalls: string[] = [];
    const copy = wiredCopy({
      flatten: async (_p, input) => {
        flattenCalls.push(input.followId);
        return { orderIds: ['ord-wire'] };
      },
    });
    const follower = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());
    const follow = await follower.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    await follower.copy.pause({ followId: follow.followId });
    expect(flattenCalls).toEqual([]);
    const acked = await follower.copy.flatten({ followId: follow.followId });
    expect(acked.disposition).toBe('DETACH_FLATTEN');
    expect(acked.flattenChosen).toBe(true);
    expect(acked.orderIds).toEqual(['ord-wire']);
    expect(flattenCalls).toEqual([follow.followId]);
    await expect(follower.copy.flatten({ followId: 'missing-follow' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('copy flatten drift refuses and does not invent a flatten', async () => {
    const copy = wiredCopy({
      flatten: async () => ({ orderIds: [], refuse: 'drift' }),
    });
    const follow = await openFollow(copy);
    await expect(copy.flatten(principal(), { followId: follow.followId })).rejects.toMatchObject({
      code: 'trade.copy_flatten_drift',
    });
    await copy.planMirrorForFollow(principal(), {
      followId: follow.followId,
      fillId: 'fill-after-drift-refuse',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
  });

  it('copy flatten unavailable refuses and does not invent a flatten', async () => {
    const copy = wiredCopy({
      flatten: async () => ({ orderIds: [], refuse: 'unavailable' }),
    });
    const follow = await openFollow(copy);
    await expect(copy.flatten(principal(), { followId: follow.followId })).rejects.toMatchObject({
      code: 'trade.copy_flatten_unavailable',
    });
    await copy.planMirrorForFollow(principal(), {
      followId: follow.followId,
      fillId: 'fill-after-unavailable-refuse',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
  });
});
