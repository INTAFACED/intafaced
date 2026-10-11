import { CopyService } from '../controls/test-admission.js';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { type LookupLeaderFillPort } from './copy-service.js';
import { bindCopyFollowerLimits } from './follower-limits.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';

const FOLLOWER = '00000000-0000-4000-8000-000000000001';
const LEADER = '00000000-0000-4000-8000-000000000002';
const principal = { userId: FOLLOWER } as import('@intafaced/auth').Principal;

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};

const publishedJur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

const futureExpiry = '2026-12-01T00:00:00.000Z';

function followerCaps() {
  return {
    maxAllocation: '1000',
    permittedInstruments: ['BTC-USDT', 'ETH-USDT'],
    maxLoss: '50',
  };
}

describe('bindCopyFollowerLimits', () => {
  it('refuses missing follower allocation rather than inheriting the leader', () => {
    try {
      bindCopyFollowerLimits({
        follower: { permittedInstruments: ['BTC-USDT'], maxLoss: '10' },
        leader: { maxAllocation: '9999' },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'trade.copy_limit_missing' });
      expect((err as Error).message).toMatch(/allocation/i);
    }
  });

  it('refuses missing follower instruments rather than inheriting the leader', () => {
    try {
      bindCopyFollowerLimits({
        follower: { maxAllocation: '100', maxLoss: '10', permittedInstruments: [] },
        leader: { permittedInstruments: ['BTC-USDT'] },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'trade.copy_limit_missing' });
      expect((err as Error).message).toMatch(/instrument/i);
    }
  });

  it('refuses missing follower loss when the leader supplies a loss cap', () => {
    try {
      bindCopyFollowerLimits({
        follower: { maxAllocation: '100', permittedInstruments: ['BTC-USDT'] },
        leader: { maxLoss: '999' },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'trade.copy_limit_missing' });
      expect((err as Error).message).toMatch(/loss/i);
    }
  });

  it('leader wider allocation / loss never raises follower caps', () => {
    const bound = bindCopyFollowerLimits({
      follower: followerCaps(),
      leader: { maxAllocation: '5000', maxLoss: '500', permittedInstruments: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'] },
    });
    expect(bound.maxAllocation).toBe(parseAmount('1000'));
    expect(bound.maxLoss).toBe(parseAmount('50'));
    expect(bound.permittedInstruments).toEqual(['BTC-USDT', 'ETH-USDT']);
  });

  it('leader tighter allocation / loss clamps down; extra leader instruments are dropped', () => {
    const bound = bindCopyFollowerLimits({
      follower: followerCaps(),
      leader: { maxAllocation: '200', maxLoss: '10', permittedInstruments: ['ETH-USDT', 'SOL-USDT'] },
    });
    expect(bound.maxAllocation).toBe(parseAmount('200'));
    expect(bound.maxLoss).toBe(parseAmount('10'));
    expect(bound.permittedInstruments).toEqual(['ETH-USDT']);
  });

  it('leader instrument universe that shares nothing with the follower refuses', () => {
    expect(() =>
      bindCopyFollowerLimits({
        follower: followerCaps(),
        leader: { permittedInstruments: ['SOL-USDT'] },
      }),
    ).toThrow(expect.objectContaining({ code: 'trade.copy_market_not_permitted' }));
  });
});

describe('CopyService follower limits the leader cannot widen', () => {
  function svc() {
    const lookupLeaderFill: LookupLeaderFillPort = async (fillId) => {
      if (fillId === 'fill-leader-tight') {
        return { fillId, userId: LEADER, marketId: 'BTC-USDT', side: 'buy', qty: parseAmount('0.01'), notional: parseAmount('80') };
      }
      if (fillId === 'fill-leader-sol') {
        return { fillId, userId: LEADER, marketId: 'ETH-USDT', side: 'buy', qty: parseAmount('1'), notional: parseAmount('10') };
      }
      return { fillId, userId: LEADER, marketId: 'BTC-USDT', side: 'buy', qty: parseAmount('0.001'), notional: parseAmount('10') };
    };
    return new CopyService(new MemoryLedger(), { feeShareLaw: publishedFee, jurisdictionLaw: publishedJur, lookupLeaderFill });
  }

  const baseFollow = {
    leaderId: LEADER,
    region: 'SG',
    permittedMarkets: ['BTC-USDT', 'ETH-USDT'],
    maxNotionalPerOrder: '100',
    maxAggregateExposure: '1000',
    maxLoss: '50',
    expiresAt: futureExpiry,
  };

  it('stores follower caps when the leader recommends wider allocation, instruments, and loss', async () => {
    const follow = await svc().follow(principal, {
      ...baseFollow,
      leaderSettings: {
        maxAllocation: '9999',
        permittedInstruments: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
        maxLoss: '999',
      },
    });
    expect(follow.maxAggregateExposure).toBe('1000');
    expect(follow.permittedMarkets).toEqual(['BTC-USDT', 'ETH-USDT']);
    expect(follow.maxLoss).toBe('50');
  });

  it('follow refuses when leader supplies maxLoss and the follower omitted it', async () => {
    await expect(
      svc().follow(principal, {
        leaderId: LEADER,
        region: 'SG',
        permittedMarkets: ['BTC-USDT'],
        maxNotionalPerOrder: '100',
        maxAggregateExposure: '1000',
        expiresAt: futureExpiry,
        leaderSettings: { maxLoss: '10' },
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_limit_missing' });
  });

  it('planMirror uses the tighter of follower vs leader allocation', async () => {
    const copy = svc();
    const follow = await copy.follow(principal, baseFollow);
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: follow.followId,
        fillId: 'fill-leader-tight',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '80',
        sessionLoss: '0',
        leaderSettings: { maxAllocation: '50' },
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_cap_exceeded' });
  });

  it('planMirror refuses a market the leader recommends that the follower did not permit', async () => {
    const copy = svc();
    const follow = await copy.follow(principal, baseFollow);
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: follow.followId,
        fillId: 'fill-leader-sol',
        marketId: 'ETH-USDT',
        side: 'buy',
        qty: '1',
        notional: '10',
        sessionLoss: '0',
        leaderSettings: { permittedInstruments: ['BTC-USDT'] },
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_market_not_permitted' });
  });

  it('planMirror refuses when session loss is at the follower loss cap; leader cannot raise it', async () => {
    const copy = svc();
    const follow = await copy.follow(principal, baseFollow);
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: follow.followId,
        fillId: 'fill-loss-cap',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.001',
        notional: '10',
        sessionLoss: '50',
        leaderSettings: { maxLoss: '500' },
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_cap_exceeded' });
  });

  it('planMirror refuses when a loss cap is set but sessionLoss is missing', async () => {
    const copy = svc();
    const follow = await copy.follow(principal, baseFollow);
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: follow.followId,
        fillId: 'fill-loss-missing',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.001',
        notional: '10',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_limit_missing' });
  });

  it('planMirror within follower caps still plans when leader settings are tighter-but-ok', async () => {
    const copy = svc();
    const follow = await copy.follow(principal, baseFollow);
    const plan = await copy.planMirrorForFollow(principal, {
      followId: follow.followId,
      fillId: 'fill-ok',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.001',
      notional: '10',
      sessionLoss: '1',
      leaderSettings: { maxAllocation: '500', permittedInstruments: ['BTC-USDT'], maxLoss: '40' },
    });
    expect(plan.reason).toBe('within_envelope');
    expect(plan.notional).toBe('10');
  });
});
