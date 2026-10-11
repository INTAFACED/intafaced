/**
 * Done-bar — trade.copy auto-mirror place (follower placeOrder wire).
 *
 * Breaks caught:
 *   · flag off still refuse-closed (never silent success);
 *   · blank §8 copy env refuses (never invents leader_share_bps);
 *   · wired port places once at plan qty/price — never a fabricated mid;
 *   · redelivery of the same fillId does not place a second order;
 *   · placeMirror without a prior plan is not a fake success.
 */
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { LookupLeaderFillPort } from './copy-service.js';
import { describe, expect, it } from 'vitest';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import type { PlaceFollowerOrderPort } from './auto-mirror-place.js';
import { CopyService } from '../controls/test-admission.js';
import { COPY_AUTO_MIRROR_PLACE_SOCKET, COPY_PLACE_DISABLED_RESIDUAL, copyLimitPriceFromPlan, copyMirrorClientOrderId } from './index.js';

const SECRET = 'copy-auto-mirror-place-done-bar-secret-32b';
const FOLLOWER = '11111111-1111-4111-8111-111111111111';
const LEADER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const futureExpiry = '2026-12-01T00:00:00.000Z';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function principal(): Principal {
  return {
    sub: FOLLOWER,
    userId: FOLLOWER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed() {
  const raw = encodePrincipal(principal());
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-copy-auto-mirror',
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

function wiredCopy(placeFollowerOrder: PlaceFollowerOrderPort) {
  return new CopyService(new MemoryLedger(), {
    feeShareLaw: publishedFee,
    jurisdictionLaw: publishedJur,
    placeMirrorEnabled: true,
    inspectMarket: async () => ({ paper: false }),
    placeFollowerOrder,
    lookupLeaderFill: anyLeaderFill(),
  });
}

describe('trade.copy placeMirror Done-bar', () => {
  it('flag off: deskStatus publishes refuse-closed (never silent on)', async () => {
    const status = await createTradeRouter(
      {} as TradeService,
      undefined,
      new CopyService(new MemoryLedger(), {
        feeShareLaw: publishedFee,
        jurisdictionLaw: publishedJur,
      }),
    )
      .createCaller(signed())
      .copy.deskStatus();
    expect(status.autoMirrorPlace.published).toBe(false);
    expect(status.autoMirrorPlace.socket).toBe(COPY_AUTO_MIRROR_PLACE_SOCKET);
    expect(status.residuals.autoMirrorPlace).toBe(COPY_PLACE_DISABLED_RESIDUAL);
  });

  it('flag off: planMirror is real; placeMirror refuses and never invents a fill', async () => {
    const caller = createTradeRouter(
      {} as TradeService,
      undefined,
      new CopyService(new MemoryLedger(), {
        feeShareLaw: publishedFee,
        jurisdictionLaw: publishedJur,
        lookupLeaderFill: anyLeaderFill(),
      }),
    ).createCaller(signed());

    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });

    const plan = await caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'leader-fill-1',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
    expect(plan.fillId).toBe('leader-fill-1');

    await expect(
      caller.copy.placeMirror({
        followId: follow.followId,
        fillId: plan.fillId,
        leaderPaper: false,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    await expect(
      caller.copy.placeMirror({
        followId: follow.followId,
        fillId: 'never-planned',
        leaderPaper: false,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('blank copy fee-share env refuses place — never invents leader_share_bps', async () => {
    let places = 0;
    const copy = new CopyService(new MemoryLedger(), {
      feeShareLaw: { published: false },
      jurisdictionLaw: publishedJur,
      placeMirrorEnabled: true,
      placeFollowerOrder: async () => {
        places += 1;
        return { orderId: 'ord-nope' };
      },
      lookupLeaderFill: anyLeaderFill(),
    });
    const caller = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());
    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    await caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'leader-blank',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
    await expect(caller.copy.placeMirror({ followId: follow.followId, fillId: 'leader-blank', leaderPaper: false })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(places).toBe(0);
  });

  it('wired: placeMirror calls follower placeOrder once with plan qty/price', async () => {
    const placed: { clientOrderId: string; qty: bigint; side: string; price: bigint }[] = [];
    const copy = wiredCopy(async (_p, input) => {
      placed.push({ clientOrderId: input.clientOrderId, qty: input.qty, side: input.side, price: input.price });
      return { orderId: 'ord-follower-1' };
    });
    const caller = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());

    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    await caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'leader-fill-2',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
    await caller.copy.grantSessionKey({ followId: follow.followId });

    const status = await caller.copy.deskStatus();
    expect(status.autoMirrorPlace.published).toBe(true);
    expect(status.residuals.autoMirrorPlace).toBeNull();

    const result = await caller.copy.placeMirror({
      followId: follow.followId,
      fillId: 'leader-fill-2',
      leaderPaper: false,
    });
    expect(result.orderId).toBe('ord-follower-1');
    expect(result.qty).toBe(formatAmount(parseAmount('0.01')));
    expect(result.price).toBe(formatAmount(copyLimitPriceFromPlan(parseAmount('0.01'), parseAmount('50'))));
    expect(placed).toHaveLength(1);
    expect(placed[0]!.qty).toBe(parseAmount('0.01'));
    expect(placed[0]!.price).toBe(parseAmount('5000'));
    expect(placed[0]!.clientOrderId).toBe(copyMirrorClientOrderId(follow.followId, 'leader-fill-2'));

    const again = await caller.copy.placeMirror({
      followId: follow.followId,
      fillId: 'leader-fill-2',
      leaderPaper: false,
    });
    expect(again.orderId).toBe('ord-follower-1');
    expect(again.duplicate).toBe(true);
    expect(placed).toHaveLength(1);
  });

  it('clientOrderId stays ≤64 when follow+fill would overflow the placeOrder retry key', async () => {
    const longFill = 'f'.repeat(120);
    const followId = FOLLOWER;
    const id = copyMirrorClientOrderId(followId, longFill);
    expect(id.length).toBe(64);
    expect(copyMirrorClientOrderId(followId, longFill)).toBe(id);

    const placed: string[] = [];
    const copy = wiredCopy(async (_p, input) => {
      placed.push(input.clientOrderId);
      expect(input.clientOrderId.length).toBeLessThanOrEqual(64);
      return { orderId: 'ord-long-fill' };
    });
    const caller = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());
    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    await caller.copy.planMirror({
      followId: follow.followId,
      fillId: longFill,
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
    await caller.copy.grantSessionKey({ followId: follow.followId });
    const result = await caller.copy.placeMirror({
      followId: follow.followId,
      fillId: longFill,
      leaderPaper: false,
    });
    expect(result.orderId).toBe('ord-long-fill');
    expect(placed[0]!.length).toBeLessThanOrEqual(64);
    expect(placed[0]).toBe(copyMirrorClientOrderId(follow.followId, longFill));
  });
});
