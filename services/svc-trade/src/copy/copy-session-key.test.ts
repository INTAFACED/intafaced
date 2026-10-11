/**
 * Fail-first — durable auto-mirror session-key.
 *
 * grantSessionKey (raw once, hash at rest) → planMirror → place succeeds.
 * killSessionKey revokes; subsequent place refuses. Amounts stay strings.
 * Envelope expiresAt is not this key.
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
import { copyLimitPriceFromPlan } from './index.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import { hashCopySessionKey } from './session-key.js';

const SECRET = 'copy-session-key-done-bar-secret-32bytes';
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
    id: 'req-copy-session-key',
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

describe('trade.copy durable auto-mirror session-key', () => {
  it('grantSessionKey returns key id; store keeps only the hash; list never returns raw', async () => {
    const store = new MemoryCopyFollowStore();
    const copy = wiredCopy(async () => ({ orderId: 'unused' }), store);
    const caller = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());

    const follow = await caller.copy.follow({
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '1000',
      expiresAt: futureExpiry,
    });
    expect(follow.sessionKeyGranted).toBe(false);

    const granted = await caller.copy.grantSessionKey({ followId: follow.followId });
    expect(typeof granted.sessionKeyId).toBe('string');
    expect(typeof granted.sessionKey).toBe('string');
    expect(granted.sessionKey!.startsWith('cpy_')).toBe(true);
    expect(granted.sessionKeyGranted).toBe(true);
    expect(granted.sessionKeyRevoked).toBe(false);
    expect(granted.sessionKeyPrefix).toBe(granted.sessionKey!.slice(0, 12));
    expect(granted.sessionKeyId).toBe(granted.sessionKeyPrefix);
    expect(granted.expiresAt).toBe(futureExpiry);

    const stored = await store.getFollow(follow.followId);
    expect(stored?.sessionKeyHash).toBe(hashCopySessionKey(granted.sessionKey!));
    expect(stored?.sessionKeyHash).not.toBe(granted.sessionKey);
    expect(`${stored?.sessionKeyHash}${stored?.sessionKeyPrefix}`).not.toContain(granted.sessionKey);

    const listed = await caller.copy.listMyFollows({ limit: 50 });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(granted.sessionKey);
    expect(listed[0]?.sessionKeyPrefix).toBe(granted.sessionKeyPrefix);
    expect(listed[0]?.sessionKeyGranted).toBe(true);
    expect(listed[0]?.sessionKeyId).toBe(granted.sessionKeyId);
  });

  it('grant + planMirror + place succeeds with string amounts; kill then place refuses', async () => {
    const placed: { qty: bigint; price: bigint }[] = [];
    const copy = wiredCopy(async (_p, input) => {
      placed.push({ qty: input.qty, price: input.price });
      return { orderId: 'ord-session-1' };
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

    await expect(
      caller.copy.placeMirror({
        followId: follow.followId,
        fillId: 'leader-fill-session-1',
        leaderPaper: false,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const granted = await caller.copy.grantSessionKey({ followId: follow.followId });
    expect(typeof granted.sessionKeyId).toBe('string');

    const plan = await caller.copy.planMirror({
      followId: follow.followId,
      fillId: 'leader-fill-session-1',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });
    expect(plan.qty).toBe(formatAmount(parseAmount('0.01')));
    expect(plan.notional).toBe(formatAmount(parseAmount('50')));
    expect(typeof plan.qty).toBe('string');
    expect(typeof plan.notional).toBe('string');

    const result = await caller.copy.placeMirror({
      followId: follow.followId,
      fillId: 'leader-fill-session-1',
      leaderPaper: false,
    });
    expect(result.orderId).toBe('ord-session-1');
    expect(typeof result.qty).toBe('string');
    expect(typeof result.price).toBe('string');
    expect(result.qty).toBe(formatAmount(parseAmount('0.01')));
    expect(result.price).toBe(formatAmount(copyLimitPriceFromPlan(parseAmount('0.01'), parseAmount('50'))));
    expect(placed).toHaveLength(1);

    const killed = await caller.copy.killSessionKey({ followId: follow.followId });
    expect(killed.followId).toBe(follow.followId);
    expect(killed.sessionKeyRevoked).toBe(true);
    expect(killed.sessionKeyGranted).toBe(false);
    expect(killed.feeShareKilled).toBe(false);

    const still = await caller.copy.listMyFollows({ limit: 50 });
    expect(still).toHaveLength(1);
    expect(still[0]?.followId).toBe(follow.followId);
    expect(still[0]?.sessionKeyRevoked).toBe(true);

    await expect(
      caller.copy.placeMirror({
        followId: follow.followId,
        fillId: 'leader-fill-session-1',
        leaderPaper: false,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(placed).toHaveLength(1);
  });

  it('killSessionKey does not unfollow; missing key names trade.copy_session_key_missing', async () => {
    const copy = wiredCopy(async () => ({ orderId: 'should-not-run' }));
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
      fillId: 'leader-fill-missing',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '50',
    });

    await expect(
      copy.placeMirrorForFollow(principal(), {
        followId: follow.followId,
        fillId: 'leader-fill-missing',
        leaderPaper: false,
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_session_key_missing' });

    await copy.grantSessionKey(principal(), { followId: follow.followId });
    await copy.killSessionKey(principal(), { followId: follow.followId });
    const still = await caller.copy.listMyFollows({ limit: 50 });
    expect(still).toHaveLength(1);
    expect(still[0]?.followId).toBe(follow.followId);

    await expect(
      copy.placeMirrorForFollow(principal(), {
        followId: follow.followId,
        fillId: 'leader-fill-missing',
        leaderPaper: false,
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_session_key_revoked' });
  });
});
