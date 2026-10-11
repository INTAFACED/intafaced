import { CopyService } from '../controls/test-admission.js';
/**
 * trade.copy product mount — tRPC surface (wave 10 L02 Done bar).
 *
 * Promise: follow / kill / unfollow reachable; blank §8 rates refuse-closed.
 * Context is built the same way index.ts builds it (edge-signed principal),
 * not a hand-written literal.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import { type LookupFollowerFillFeePort, type LookupLeaderFillPort } from './copy-service.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';
import { MemoryCopyFollowStore } from './follow-store.js';

const SECRET = 'a-trade-copy-mount-test-edge-secret-long';
const FOLLOWER = '00000000-0000-4000-8000-000000000001';
const LEADER = '00000000-0000-4000-8000-000000000002';
const SESSION = '22222222-2222-4222-8222-222222222222';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};

const publishedJur: CopyJurisdictionLaw = {
  published: true,
  allowedRegions: ['SG'],
};

const futureExpiry = '2026-12-01T00:00:00.000Z';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: FOLLOWER,
    userId: FOLLOWER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-copy-signed',
  });
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'SG' }, id: 'req-copy-anon' });

function stubTrade() {
  return {} as unknown as TradeService;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class BlockingLedger extends MemoryLedger {
  readonly entered = deferred();
  readonly release = deferred();
  private armed = false;

  arm() {
    this.armed = true;
  }

  override async post(plan: Parameters<MemoryLedger['post']>[0]) {
    if (this.armed) {
      this.armed = false;
      this.entered.resolve();
      await this.release.promise;
    }
    return super.post(plan);
  }
}

class BlockingMirrorStore extends MemoryCopyFollowStore {
  readonly entered = deferred();
  readonly release = deferred();

  override async claimMirrorFill(input: Parameters<MemoryCopyFollowStore['claimMirrorFill']>[0]) {
    this.entered.resolve();
    await this.release.promise;
    return super.claimMirrorFill(input);
  }
}

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
  return async (fillId) => {
    const large = fillId.includes('unfollow') || fillId === 'leader-fill-1';
    return {
      fillId,
      userId: LEADER,
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: parseAmount(large ? '0.1' : '0.001'),
      notional: parseAmount(large ? '100' : '10'),
    };
  };
}

function makeCopy(opts?: {
  fee?: CopyFeeShareLaw;
  jur?: CopyJurisdictionLaw;
  ledger?: MemoryLedger;
  store?: MemoryCopyFollowStore;
  lookupFollowerFillFee?: LookupFollowerFillFeePort;
  lookupLeaderFill?: LookupLeaderFillPort;
}) {
  return new CopyService(opts?.ledger ?? new MemoryLedger(), {
    feeShareLaw: opts?.fee ?? { published: false },
    jurisdictionLaw: opts?.jur ?? { published: false },
    ...(opts?.store ? { store: opts.store } : {}),
    ...(opts?.lookupFollowerFillFee ? { lookupFollowerFillFee: opts.lookupFollowerFillFee } : {}),
    lookupLeaderFill: opts?.lookupLeaderFill ?? anyLeaderFill(),
  });
}

describe('trade.copy product mount', () => {
  it('deskStatus is refuse-closed when §8 laws are blank', async () => {
    const router = createTradeRouter(stubTrade(), undefined, makeCopy());
    const status = await router.createCaller(signed()).copy.deskStatus();
    expect(status.feeSharePublished).toBe(false);
    expect(status.leaderShareBps).toBeNull();
    expect(status.jurisdictionPublished).toBe(false);
    expect(status.residual).toContain('DIRECTION §8');
    expect(status.residual).toContain('D26-P0-02');
    expect(status.residual).toContain('D26-P0-15');
    expect(status.sovereign.shape).toBe('sovereign');
    expect(status.sovereign.custody).toBe(false);
    expect(status.sovereign.pnlFeeForbidden).toBe(true);
    expect(status.sovereign.rankingForbidden).toBe(true);
    expect(status.sovereign.killUnfollowReal).toBe(true);
    expect(status.residuals.rates).toContain('D26-P0-02');
    expect(status.residuals.jurisdiction).toContain('D26-P0-15');
    expect(status.autoMirrorPlace.published).toBe(false);
    expect(status.autoMirrorPlace.socket).toContain('socket.copy-auto-mirror-place');
  });

  it('deskStatus publishes the owner-configured leader share as a wire string', async () => {
    const router = createTradeRouter(stubTrade(), undefined, makeCopy({ fee: publishedFee, jur: publishedJur }));
    const status = await router.createCaller(signed()).copy.deskStatus();
    expect(status.feeSharePublished).toBe(true);
    expect(status.leaderShareBps).toBe('5000');
    expect(typeof status.leaderShareBps).toBe('string');
  });

  it('follow refuses blank jurisdiction — never invents allowlist', async () => {
    const router = createTradeRouter(stubTrade(), undefined, makeCopy({ fee: publishedFee, jur: { published: false } }));
    await expect(
      router.createCaller(signed()).copy.follow({
        leaderId: LEADER,
        region: 'SG',
        permittedMarkets: ['BTC-USDT'],
        maxNotionalPerOrder: '100',
        maxAggregateExposure: '1000',
        expiresAt: futureExpiry,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('follow → killFeeShare → unfollow stays reachable while fee rates are blank', async () => {
    const router = createTradeRouter(stubTrade(), undefined, makeCopy({ fee: { published: false }, jur: publishedJur }));
    const caller = router.createCaller(signed());

    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    expect(follow.followId).toBeTruthy();
    expect(follow.feeShareKilled).toBe(false);
    expect(follow.leaderId).toBe(LEADER);

    const killed = await caller.copy.killFeeShare({ followId: follow.followId });
    expect(killed.feeShareKilled).toBe(true);

    const revoked = await caller.copy.unfollow({ followId: follow.followId });
    expect(revoked).toEqual({ followId: follow.followId, revoked: true });

    await expect(caller.copy.unfollow({ followId: follow.followId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('killFeeShare waits for an in-flight public settlement, then blocks every later fill', async () => {
    const ledger = new BlockingLedger();
    await ledger.post(
      recipes.deposit({
        userId: FOLLOWER,
        assetId: 'USDT',
        amount: parseAmount('100'),
        rail: 'test',
        railRef: 'copy-kill-public',
      }),
    );
    await ledger.post(
      recipes.feeCharge({
        mode: 'asset',
        chargeId: 'copy-kill-public-fee',
        userId: FOLLOWER,
        module: 'trade',
        assetId: 'USDT',
        amount: parseAmount('10'),
      }),
    );
    const copy = makeCopy({
      fee: publishedFee,
      jur: publishedJur,
      ledger,
      lookupFollowerFillFee: lookupFillFee('1'),
    });
    const caller = createTradeRouter(stubTrade(), undefined, copy).createCaller(signed());
    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: futureExpiry,
    });
    await caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'fill-before-kill',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.001',
      notional: '10',
    });
    await caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'fill-after-kill',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.001',
      notional: '10',
    });

    ledger.arm();
    const settling = caller.copy.settleFeeShare({
      followId: follow.followId,
      fillId: 'fill-before-kill',
      assetId: 'USDT',
      followerFillNotional: '1000',
      protocolFeeBps: 10,
    });
    await ledger.entered.promise;

    let killAcknowledged = false;
    const killing = caller.copy.killFeeShare({ followId: follow.followId }).then((result) => {
      killAcknowledged = true;
      return result;
    });
    await nextTurn();
    expect(killAcknowledged).toBe(false);

    ledger.release.resolve();
    await settling;
    expect((await killing).feeShareKilled).toBe(true);
    const balanceAfterKill = (await ledger.balance(userAvailable(LEADER, 'USDT'))).amount;

    await expect(
      caller.copy.settleFeeShare({
        followId: follow.followId,
        fillId: 'fill-after-kill',
        assetId: 'USDT',
        followerFillNotional: '1000',
        protocolFeeBps: 10,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await ledger.balance(userAvailable(LEADER, 'USDT'))).amount).toBe(balanceAfterKill);
  });

  it('unfollow waits for an in-flight public mirror, then rejects every later mirror', async () => {
    const store = new BlockingMirrorStore();
    const copy = makeCopy({ fee: { published: false }, jur: publishedJur, store });
    const caller = createTradeRouter(stubTrade(), undefined, copy).createCaller(signed());
    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: futureExpiry,
    });

    const mirroring = caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'fill-before-unfollow',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.1',
      notional: '100',
    });
    await store.entered.promise;

    let unfollowAcknowledged = false;
    const unfollowing = caller.copy.unfollow({ followId: follow.followId }).then((result) => {
      unfollowAcknowledged = true;
      return result;
    });
    await nextTurn();
    expect(unfollowAcknowledged).toBe(false);

    store.release.resolve();
    await mirroring;
    expect(await unfollowing).toEqual({ followId: follow.followId, revoked: true });
    expect(await caller.copy.listMyFollows({ limit: 50 })).toEqual([]);
    await expect(
      caller.copy.planMirror({
        followId: follow.followId,
        fillId: 'fill-after-unfollow',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.1',
        notional: '100',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('settleFeeShare refuses blank §8 rates — never invents leader_share_bps', async () => {
    // Jurisdiction published so follow could exist; fee-share still blank.
    const copy = makeCopy({ fee: { published: false }, jur: publishedJur });
    const follow = await copy.follow(principal(), {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });

    const router = createTradeRouter(stubTrade(), undefined, copy);
    await expect(
      router.createCaller(signed()).copy.settleFeeShare({
        followId: follow.followId,
        fillId: 'fill-blank-rate',
        assetId: 'USDT',
        followerFillNotional: '1000',
        protocolFeeBps: 10,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses anonymous callers on copy.follow', async () => {
    const router = createTradeRouter(stubTrade(), undefined, makeCopy({ fee: publishedFee, jur: publishedJur }));
    await expect(
      router.createCaller(anonymous()).copy.follow({
        leaderId: LEADER,
        region: 'SG',
        permittedMarkets: ['BTC-USDT'],
        maxNotionalPerOrder: '100',
        maxAggregateExposure: '1000',
        expiresAt: futureExpiry,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('listMyFollows returns only the caller’s follows', async () => {
    const router = createTradeRouter(stubTrade(), undefined, makeCopy({ fee: publishedFee, jur: publishedJur }));
    const caller = router.createCaller(signed());
    expect(await caller.copy.listMyFollows({ limit: 50 })).toEqual([]);

    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    const listed = await caller.copy.listMyFollows({ limit: 50 });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.followId).toBe(follow.followId);
    expect(listed[0]?.currentExposure).toBe('0');
    expect(listed[0]?.remainingExposure).toBe('1000');
  });

  it('planMirror plans within envelope and redelivers the same fillId', async () => {
    const router = createTradeRouter(stubTrade(), undefined, makeCopy({ fee: publishedFee, jur: publishedJur }));
    const caller = router.createCaller(signed());
    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: futureExpiry,
    });

    const plan = await caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'leader-fill-1',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.1',
      notional: '100',
    });
    expect(plan.reason).toBe('within_envelope');
    expect(plan.fillId).toBe('leader-fill-1');

    const again = await caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'leader-fill-1',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.1',
      notional: '100',
    });
    expect(again.fillId).toBe(plan.fillId);
    expect(again.nextExposure).toBe(plan.nextExposure);

    const desk = await caller.copy.listMyFollows({ limit: 50 });
    expect(desk).toHaveLength(1);
    expect(desk[0]?.currentExposure).toBe('100');
    expect(desk[0]?.remainingExposure).toBe('9900');
  });
});
