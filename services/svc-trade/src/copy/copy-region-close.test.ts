import { CopyService } from '../controls/test-admission.js';
/**
 * R-copy: follow closed in every closed region; leader money ≠ follower money.
 */
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount, recipes, formatAmount, userAvailable } from '@intafaced/ledger-client';
import { type LookupFollowerFillFeePort, type LookupLeaderFillPort } from './copy-service.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import { copyRegionClosed } from './follows.js';
import { COPY_JURISDICTION_RESIDUAL } from './errors.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';

const FOLLOWER = '00000000-0000-4000-8000-000000000001';
const LEADER = '00000000-0000-4000-8000-000000000002';
const principal = { userId: FOLLOWER } as import('@intafaced/auth').Principal;
const leaderPrincipal = { userId: LEADER } as import('@intafaced/auth').Principal;

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};

const sgOnly: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };
const none: CopyJurisdictionLaw = { published: true, allowedRegions: [] };
const futureExpiry = '2026-12-01T00:00:00.000Z';

function lookupFillFee(feeAmount: string): LookupFollowerFillFeePort {
  return async (fillId) => ({
    fillId,
    userId: FOLLOWER,
    feeAsset: 'USDT',
    feeAmount: parseAmount(feeAmount),
    createdAt: new Date(Date.now() + 60_000),
  });
}

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

describe('copyRegionClosed', () => {
  it('unpublished law closes every region', () => {
    const err = copyRegionClosed({ published: false }, 'SG');
    expect(err?.code).toBe('trade.copy_jurisdiction_blank');
    expect(err?.residual).toBe(COPY_JURISDICTION_RESIDUAL);
  });

  it('published empty allowlist closes every region', () => {
    expect(copyRegionClosed(none, 'SG')?.code).toBe('trade.copy_jurisdiction_blocked');
  });

  it('off-allowlist is closed; listed region is open', () => {
    expect(copyRegionClosed(sgOnly, 'US')?.code).toBe('trade.copy_jurisdiction_blocked');
    expect(copyRegionClosed(sgOnly, 'SG')).toBeNull();
  });
});

describe('CopyService close follows in closed regions', () => {
  it('planMirror cannot keep a follow open after the region is closed', async () => {
    const store = new MemoryCopyFollowStore();
    const open = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: sgOnly,
      store,
    });
    const follow = await open.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    const closed = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: none,
      store,
    });
    await expect(
      closed.planMirrorForFollow(principal, {
        followId: follow.followId,
        fillId: 'fill-closed-region',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '50',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_jurisdiction_blocked' });
    const listed = await closed.listMyFollows(principal, 50);
    expect(listed[0]?.relationshipState).toBe('DETACHED');
    expect(listed[0]?.newIntentFenced).toBe(true);
  });

  it('unpublished law closeFollowsInClosedRegions detaches all regions and never flattens', async () => {
    const store = new MemoryCopyFollowStore();
    let flattenCalls = 0;
    const open = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: sgOnly,
      store,
      flattenCopyPosition: async () => {
        flattenCalls += 1;
        return { orderIds: ['invented'] };
      },
    });
    await open.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    const unpublished = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: { published: false },
      store,
      flattenCopyPosition: async () => {
        flattenCalls += 1;
        return { orderIds: ['invented'] };
      },
    });
    const result = await unpublished.closeFollowsInClosedRegions();
    expect(result).toEqual({ scanned: 1, closed: 1, alreadyClosed: 0, stillOpen: 0, flattenInvented: false });
    expect(flattenCalls).toBe(0);
    expect((await unpublished.listMyFollows(principal, 50))[0]?.relationshipState).toBe('DETACHED');
    const again = await unpublished.closeFollowsInClosedRegions();
    expect(again.alreadyClosed).toBe(1);
    expect(again.closed).toBe(0);
  });

  it('sweep leaves an allowlisted follow open', async () => {
    const store = new MemoryCopyFollowStore();
    const svc = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: sgOnly,
      store,
    });
    await svc.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    const result = await svc.closeFollowsInClosedRegions();
    expect(result).toEqual({ scanned: 1, closed: 0, alreadyClosed: 0, stillOpen: 1, flattenInvented: false });
    expect((await svc.listMyFollows(principal, 50))[0]?.relationshipState).toBe('ACTIVE');
  });

  it('settleFeeShare after region close refuses and does not pay the leader', async () => {
    const store = new MemoryCopyFollowStore();
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: FOLLOWER,
        assetId: 'USDT',
        amount: parseAmount('100'),
        rail: 'test',
        railRef: 'copy-region-close',
      }),
    );
    await ledger.post(
      recipes.feeCharge({
        mode: 'asset',
        chargeId: 'copy-region-close-fee',
        userId: FOLLOWER,
        module: 'trade',
        assetId: 'USDT',
        amount: parseAmount('10'),
      }),
    );
    const open = new CopyService(ledger, {
      feeShareLaw: publishedFee,
      jurisdictionLaw: sgOnly,
      store,
      lookupFollowerFillFee: lookupFillFee('1'),
      lookupLeaderFill: anyLeaderFill(),
    });
    const follow = await open.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: futureExpiry,
    });
    await open.planMirrorForFollow(principal, {
      followId: follow.followId,
      fillId: 'fill-region-close-settle',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.001',
      notional: '10',
    });
    const closed = new CopyService(ledger, {
      feeShareLaw: publishedFee,
      jurisdictionLaw: none,
      store,
      lookupFollowerFillFee: lookupFillFee('1'),
      lookupLeaderFill: anyLeaderFill(),
    });
    await expect(
      closed.settleFeeShare(principal, {
        followId: follow.followId,
        fillId: 'fill-region-close-settle',
        assetId: 'USDT',
        followerFillNotional: '1000',
        protocolFeeBps: 10,
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_jurisdiction_blocked' });
    expect((await ledger.balance(userAvailable(LEADER, 'USDT'))).amount).toBe(0n);
    expect(formatAmount((await ledger.balance(userAvailable(FOLLOWER, 'USDT'))).amount)).toBe('90');
  });

  it('placeMirror spends the follower book — leader cannot place, paper cannot go live', async () => {
    let placedAs: string | undefined;
    const store = new MemoryCopyFollowStore();
    const svc = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: sgOnly,
      store,
      placeMirrorEnabled: true,
      inspectMarket: async () => ({ paper: false }),
      placeFollowerOrder: async (p) => {
        placedAs = p.userId;
        return { orderId: 'ord-follower' };
      },
      lookupLeaderFill: anyLeaderFill(),
    });
    const follow = await svc.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    await svc.planMirrorForFollow(principal, {
      followId: follow.followId,
      fillId: 'fill-books',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
    await expect(
      svc.placeMirrorForFollow(leaderPrincipal, { followId: follow.followId, fillId: 'fill-books', leaderPaper: false }),
    ).rejects.toMatchObject({ code: 'trade.copy_not_following' });
    expect(placedAs).toBeUndefined();
    await svc.grantSessionKey(principal, { followId: follow.followId });
    const placed = await svc.placeMirrorForFollow(principal, {
      followId: follow.followId,
      fillId: 'fill-books',
      leaderPaper: false,
    });
    expect(placed.orderId).toBe('ord-follower');
    expect(placedAs).toBe(FOLLOWER);
    await expect(
      svc.placeMirrorForFollow(principal, { followId: follow.followId, fillId: 'fill-books', leaderPaper: true }),
    ).rejects.toMatchObject({ code: 'trade.copy_paper_live_forbidden' });
  });
});
