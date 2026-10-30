/**
 * J-copy-bots-otc-03 #4: a copy close-all sells at market and can realise a loss, so identity's step-up for exactly this
 * follow and request comes before the follow is read. Without it nothing is read, closed or saved.
 */
import type { Principal } from '@intafaced/auth';
import {
  StepUpCheckError,
  createEdgeContext,
  createStepUpCheck,
  encodePrincipal,
  signPrincipalHeader,
  type StepUpCheck,
  type StepUpCheckRequest,
} from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it, vi } from 'vitest';
import { CopyService } from '../controls/test-admission.js';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import type { FlattenCopyPositionPort } from './copy-flatten.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import { GateOpenLedger, OPEN_FOLLOW_GATE } from './test/follow-gate.fixture.js';

const SECRET = 'copy-flatten-step-up-secret-32bytes';
const FOLLOWER = '11111111-1111-4111-8111-111111111111';
const LEADER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const REQUEST = 'flatten-0001';

const principal = (): Principal =>
  ({
    sub: FOLLOWER,
    userId: FOLLOWER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  }) as Principal;

function signed() {
  const raw = encodePrincipal(principal());
  return createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' })({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-copy-flatten-step-up',
  });
}

/** A step-up that records what it was asked, and refuses unless an approval id was sent. */
function recordingStepUp(refuse?: StepUpCheckError) {
  const asked: StepUpCheckRequest[] = [];
  const check: StepUpCheck = {
    async require(req) {
      asked.push(req);
      if (refuse) throw refuse;
      if (!req.approvalId) throw new StepUpCheckError('Confirm this first', 'identity.step_up_required');
      return { stepUpEventId: 'appr-1', consumedAt: null, replayed: false };
    },
  };
  return { asked, check };
}

function wired(stepUp: StepUpCheck | null) {
  const store = new MemoryCopyFollowStore();
  const flatten = vi.fn<FlattenCopyPositionPort>(async () => ({ orderIds: ['ord-close-1'] }));
  const copy = new CopyService(new GateOpenLedger(), {
    ...OPEN_FOLLOW_GATE,
    stepUp,
    store,
    feeShareLaw: { published: true, leaderShareBps: 5_000, earningsCapPerFollower: '100', decayRoundTrips: 100, decayShareBps: 1_000 },
    jurisdictionLaw: { published: true, allowedRegions: ['SG'] },
    placeMirrorEnabled: true,
    inspectMarket: async () => ({ paper: false }),
    placeFollowerOrder: async () => ({ orderId: 'ord-unused' }),
    flattenCopyPosition: flatten,
    lookupLeaderFill: async (fillId) => ({
      fillId,
      userId: LEADER,
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: parseAmount('0.01'),
      notional: parseAmount('50'),
    }),
  });
  return { copy, store, flatten };
}

async function openFollow(copy: CopyService) {
  return copy.follow(principal(), {
    leaderId: LEADER,
    region: 'SG',
    permittedMarkets: ['BTC-USDT'],
    maxNotionalPerOrder: '100',
    maxAggregateExposure: '1000',
    expiresAt: '2026-12-01T00:00:00.000Z',
  });
}

describe('copy.flatten asks identity for a step-up first (J-copy-bots-otc-03 #4)', () => {
  it('sends exactly this follow and request to identity, under copy.flatten:<followId>:<requestId>, then closes once', async () => {
    const { asked, check } = recordingStepUp();
    const { copy, flatten } = wired(check);
    const follow = await openFollow(copy);
    const acked = await copy.flatten(principal(), { followId: follow.followId, requestId: REQUEST, stepUpApprovalId: 'appr-1' });
    expect(acked.disposition).toBe('DETACH_FLATTEN');
    expect(flatten).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([
      {
        scope: 'trade.step_up.copy.flatten',
        userId: FOLLOWER,
        sessionId: SESSION,
        approvalId: 'appr-1',
        fields: { followId: follow.followId, requestId: REQUEST },
        requestId: `copy.flatten:${follow.followId}:${REQUEST}`,
      },
    ]);
  });

  it('no approval refuses identity.step_up_required, even with no request key: nothing is read, closed or saved', async () => {
    const { asked, check } = recordingStepUp();
    const { copy, store, flatten } = wired(check);
    const follow = await openFollow(copy);
    const before = await store.getFollow(follow.followId);
    const read = vi.spyOn(store, 'runFollowExclusive');
    for (const stepUpApprovalId of [undefined, null, '']) {
      await expect(copy.flatten(principal(), { followId: follow.followId, requestId: REQUEST, stepUpApprovalId })).rejects.toMatchObject({
        code: 'identity.step_up_required',
      });
    }
    // The bare call J-copy-bots-otc-03 #4 sends: the follow and nothing else.
    await expect(copy.flatten(principal(), { followId: follow.followId })).rejects.toMatchObject({ code: 'identity.step_up_required' });
    expect(asked).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(flatten).not.toHaveBeenCalled();
    expect(await store.getFollow(follow.followId)).toEqual(before);
  });

  it('identity down, or not wired at all, refuses identity.step_up_unavailable and closes nothing', async () => {
    const down = recordingStepUp(new StepUpCheckError('identity could not check it', 'identity.step_up_unavailable'));
    for (const stepUp of [down.check, null, createStepUpCheck({ service: 'svc-trade', approvals: null })]) {
      const { copy, flatten } = wired(stepUp);
      const follow = await openFollow(copy);
      await expect(
        copy.flatten(principal(), { followId: follow.followId, requestId: REQUEST, stepUpApprovalId: 'appr-1' }),
      ).rejects.toMatchObject({ code: 'identity.step_up_unavailable' });
      expect(flatten).not.toHaveBeenCalled();
    }
  });

  it('a request key that is malformed, or too long for identity, refuses typed before identity is asked', async () => {
    const { asked, check } = recordingStepUp();
    const { copy, flatten } = wired(check);
    const follow = await openFollow(copy);
    const longFollow = 'f'.repeat(64);
    for (const [followId, requestId] of <[string, string][]>[
      [follow.followId, ''],
      [follow.followId, 'short'],
      [follow.followId, 'has space in it'],
      [follow.followId, 'k'.repeat(65)],
      [longFollow, 'k'.repeat(64)],
    ]) {
      await expect(copy.flatten(principal(), { followId, requestId, stepUpApprovalId: 'appr-1' })).rejects.toMatchObject({
        code: 'trade.copy_request_key_invalid',
      });
    }
    expect(asked).toEqual([]);
    expect(flatten).not.toHaveBeenCalled();
  });

  it('over tRPC: no approval answers 403 identity.step_up_required; identity unwired 503', async () => {
    const { copy } = wired(recordingStepUp().check);
    const follow = await openFollow(copy);
    const caller = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed());
    await expect(caller.copy.flatten({ followId: follow.followId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'identity.step_up_required' },
    });
    const unwired = wired(null);
    const other = await openFollow(unwired.copy);
    const caller2 = createTradeRouter({} as TradeService, undefined, unwired.copy).createCaller(signed());
    await expect(caller2.copy.flatten({ followId: other.followId, requestId: REQUEST, stepUpApprovalId: 'appr-1' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'identity.step_up_unavailable' },
    });
  });
});
