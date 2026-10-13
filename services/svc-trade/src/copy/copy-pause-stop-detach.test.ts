import { CopyService } from '../controls/test-admission.js';
/**
 * PTX-M26-R05 — follower pause / stop / detach.
 *
 * Pause stops new mirrors immediately. None of these doors invent a flatten.
 * Missing follow id refuses. Leader cannot force-resume.
 */
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import type { LookupLeaderFillPort } from './copy-service.js';
import { describe, expect, it } from 'vitest';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import type { PlaceFollowerOrderPort } from './auto-mirror-place.js';

import { MemoryCopyFollowStore } from './follow-store.js';

const SECRET = 'copy-pause-stop-detach-edge-secret-32b';
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
    id: `req-copy-control-${userId}`,
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

function anyLeaderFill(): LookupLeaderFillPort {
  return async (fillId) => ({
    fillId,
    userId: LEADER,
    marketId: 'BTC-USDT',
    side: 'buy',
    qty: parseAmount('0.01'),
    notional: parseAmount('50'),
  });
}

function wiredCopy(placeFollowerOrder: PlaceFollowerOrderPort, store = new MemoryCopyFollowStore()) {
  return new CopyService(new MemoryLedger(), {
    feeShareLaw: publishedFee,
    jurisdictionLaw: publishedJur,
    placeMirrorEnabled: true,
    inspectMarket: async () => ({ paper: false }),
    placeFollowerOrder,
    store,
    lookupLeaderFill: anyLeaderFill(),
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

describe('trade.copy pause/stop/detach (PTX-M26-R05)', () => {
  it('pause fences a later planMirror immediately and does not flatten', async () => {
    const places: string[] = [];
    const copy = wiredCopy(async (_principal, input) => {
      places.push(input.clientOrderId);
      return { orderId: 'ord-should-not-place' };
    });
    const follow = await openFollow(copy);
    const paused = await copy.pause(principal(), { followId: follow.followId });
    expect(paused).toMatchObject({
      followId: follow.followId,
      relationshipState: 'PAUSED',
      disposition: 'PAUSE_NEW',
      newIntentFenced: true,
      flattenInvented: false,
    });
    await expect(
      copy.planMirrorForFollow(principal(), {
        followId: follow.followId,
        fillId: 'fill-after-pause',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '50',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_paused' });
    expect(places).toEqual([]);
    const listed = await copy.listMyFollows(principal(), 50);
    expect(listed[0]?.relationshipState).toBe('PAUSED');
    expect(listed[0]?.newIntentFenced).toBe(true);
  });

  it('resume after pause allows a new mirror; leader cannot force-resume', async () => {
    const copy = wiredCopy(async () => ({ orderId: 'unused' }));
    const follow = await openFollow(copy);
    await copy.pause(principal(), { followId: follow.followId });
    await expect(copy.resume(principal(LEADER), { followId: follow.followId })).rejects.toMatchObject({
      code: 'trade.copy_leader_resume_forbidden',
    });
    const resumed = await copy.resume(principal(), { followId: follow.followId });
    expect(resumed.relationshipState).toBe('ACTIVE');
    expect(resumed.newIntentFenced).toBe(false);
    expect(resumed.flattenInvented).toBe(false);
    const plan = await copy.planMirrorForFollow(principal(), {
      followId: follow.followId,
      fillId: 'fill-after-resume',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
    expect(plan.fillId).toBe('fill-after-resume');
  });

  it('stop revokes the session grant, fences place, and does not flatten', async () => {
    let places = 0;
    const copy = wiredCopy(async () => {
      places += 1;
      return { orderId: 'ord-live' };
    });
    const follow = await openFollow(copy);
    await copy.grantSessionKey(principal(), { followId: follow.followId });
    await copy.planMirrorForFollow(principal(), {
      followId: follow.followId,
      fillId: 'fill-before-stop',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
    const stopped = await copy.stop(principal(), { followId: follow.followId });
    expect(stopped).toMatchObject({
      relationshipState: 'STOPPING',
      disposition: 'STOP_NEW',
      newIntentFenced: true,
      flattenInvented: false,
      sessionKeyRevoked: true,
    });
    await expect(
      copy.placeMirrorForFollow(principal(), { followId: follow.followId, fillId: 'fill-before-stop', leaderPaper: false }),
    ).rejects.toMatchObject({ code: 'trade.copy_stopped' });
    await expect(
      copy.planMirrorForFollow(principal(), {
        followId: follow.followId,
        fillId: 'fill-after-stop',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '50',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_stopped' });
    expect(places).toBe(0);
    await expect(copy.resume(principal(), { followId: follow.followId })).rejects.toMatchObject({
      code: 'trade.copy_state_invalid',
    });
  });

  it('detach leaves the follow (no flatten) and refuses later mirrors', async () => {
    const copy = wiredCopy(async () => ({ orderId: 'unused' }));
    const follow = await openFollow(copy);
    const detached = await copy.detach(principal(), { followId: follow.followId });
    expect(detached).toMatchObject({
      relationshipState: 'DETACHED',
      disposition: 'DETACH_KEEP',
      newIntentFenced: true,
      flattenInvented: false,
      sessionKeyRevoked: true,
    });
    expect(await copy.listMyFollows(principal(), 50)).toHaveLength(1);
    await expect(
      copy.planMirrorForFollow(principal(), {
        followId: follow.followId,
        fillId: 'fill-after-detach',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '50',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_detached' });
  });

  it('missing follow id refuses pause/stop/detach/resume', async () => {
    const copy = wiredCopy(async () => ({ orderId: 'unused' }));
    await expect(copy.pause(principal(), { followId: '   ' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    await expect(copy.stop(principal(), { followId: '' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    await expect(copy.detach(principal(), { followId: '' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    await expect(copy.resume(principal(), { followId: '' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    await expect(copy.pause(principal(), { followId: 'missing-follow' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
  });

  it('product mount: pause then planMirror is PRECONDITION_FAILED; leader resume is FORBIDDEN', async () => {
    const copy = wiredCopy(async () => ({ orderId: 'unused' }));
    const follower = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());
    const follow = await follower.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    const paused = await follower.copy.pause({ followId: follow.followId });
    expect(paused.flattenInvented).toBe(false);
    await expect(
      follower.copy.planMirror({
        followId: follow.followId,
        fillId: 'fill-wire-pause',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '50',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const leader = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed(LEADER));
    await expect(leader.copy.resume({ followId: follow.followId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
