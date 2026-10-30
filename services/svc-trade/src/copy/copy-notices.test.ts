/**
 * J-copy-bots-otc-03 #6: the follower is told when a follow skipped a leader fill or stopped copying. svc-trade
 * publishes `trade.copy.skipped` / `.stopped` on the real catalog schema, once per key, after the row it reports.
 */
import type { Principal } from '@intafaced/auth';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it, vi } from 'vitest';
import { readyTestAdmission } from '../controls/test-admission.js';
import { busCopyNotices } from './copy-notices.js';
import { CopyService, type LeaderFill } from './copy-service.js';

const FOLLOWER = '00000000-0000-4000-8000-0000000000d1';
const LEADER = '00000000-0000-4000-8000-0000000000d2';
const NOW = new Date('2026-10-30T08:00:00.000Z');
const principal = {
  sub: FOLLOWER,
  userId: FOLLOWER,
  sid: '00000000-0000-4000-8000-0000000000d3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'full',
  mfa: true,
  expiresAt: new Date(NOW.getTime() + 60_000),
} as Principal;
const stranger = { ...principal, sub: LEADER, userId: LEADER } as Principal;
const BUY = '11111111-1111-4111-8111-1111111111d1';
const BUY2 = '22222222-2222-4222-8222-2222222222d2';

const fill = (fillId: string): LeaderFill => ({
  fillId,
  userId: LEADER,
  marketId: 'BTC/USDT',
  side: 'buy',
  qty: parseAmount('0.001'),
  notional: parseAmount('45'),
  price: parseAmount('45000'),
});

function setup(fills: LeaderFill[], bus = new MemoryEventBus('svc-trade')) {
  const warn = vi.fn();
  const svc = new CopyService(new MemoryLedger(), {
    accountAdmission: readyTestAdmission(),
    feeShareLaw: { published: true, leaderShareBps: 1000, earningsCapPerFollower: '100', decayRoundTrips: 0, decayShareBps: 1000 },
    jurisdictionLaw: { published: true, allowedRegions: ['SG'] },
    placeMirrorEnabled: true,
    now: () => NOW,
    notices: busCopyNotices(bus, warn),
    inspectMarket: async () => ({ paper: false, lotSize: parseAmount('0.00001') }),
    placeFollowerOrder: async () => ({ orderId: 'order-1' }),
    lookupLeaderFill: async (fillId) => fills.find((f) => f.fillId === fillId) ?? null,
    listLeaderFillsSince: async (leaderId, after, limit) =>
      fills
        .map((f, i) => ({ fillId: f.fillId, marketId: f.marketId, at: new Date(NOW.getTime() + (i + 1) * 1000) }))
        .filter((f) => f.at.getTime() > after.at.getTime())
        .slice(0, limit),
    copiedPositions: async () => [],
  });
  const follow = async (maxNotionalPerOrder = '100') => {
    const made = await svc.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC/USDT'],
      maxNotionalPerOrder,
      maxAggregateExposure: '500',
      ...(maxNotionalPerOrder === '100' ? { fixedOrderSize: '20' } : {}),
      maxLoss: '5',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    await svc.grantSessionKey(principal, { followId: made.followId });
    return made.followId;
  };
  return { svc, bus, follow, warn };
}

describe('copy notices (J-copy-bots-otc-03 #6)', () => {
  it('a skip the follower did not choose is published once per leader fill, with its reason id and no raw code', async () => {
    const ctx = setup([fill(BUY)]);
    // The loss on this follow cannot be read, so the copy is held back by a risk control.
    const followId = await ctx.follow('10');
    await ctx.svc.runMirrorSweep();
    await ctx.svc.runMirrorSweep();
    const sent = ctx.bus.emitted('copySkipped');
    expect(sent.map((e) => e.payload)).toEqual([
      { followId, followerId: FOLLOWER, leaderId: LEADER, leaderFillId: BUY, reason: 'risk_control', skippedAt: NOW.toISOString() },
    ]);
    expect(sent[0]!.idempotencyKey).toBe(`trade.copy.skipped:${followId}:${BUY}`);
    expect((await ctx.svc.skipLog(principal, { followId })).items.map((i) => i.reason)).toEqual(['risk_control']);
  });

  it('a skip the follower chose (a stop) is logged but not published', async () => {
    const ctx = setup([fill(BUY), fill(BUY2)]);
    const followId = await ctx.follow();
    await ctx.svc.stop(principal, { followId, closeOnly: true });
    await ctx.svc.runMirrorSweep();
    expect((await ctx.svc.skipLog(principal, { followId })).items.map((i) => i.reason)).toEqual(['stopped', 'stopped']);
    expect(ctx.bus.emitted('copySkipped')).toEqual([]);
  });

  it('a stop is published after it is saved, keyed on the follow and close-only, with the follower as the reason', async () => {
    const ctx = setup([]);
    const followId = await ctx.follow();
    await ctx.svc.stop(principal, { followId, closeOnly: true });
    const sent = ctx.bus.emitted('copyStopped');
    expect(sent.map((e) => e.payload)).toEqual([
      { followId, followerId: FOLLOWER, leaderId: LEADER, reason: 'follower', closeOnly: true, stoppedAt: NOW.toISOString() },
    ]);
    expect(sent[0]!.idempotencyKey).toBe(`trade.copy.stopped:${followId}:true`);
  });

  it('a refused stop tells nobody', async () => {
    const ctx = setup([]);
    const followId = await ctx.follow();
    await expect(ctx.svc.stop(stranger, { followId })).rejects.toBeDefined();
    expect(ctx.bus.emitted('copyStopped')).toEqual([]);
  });

  it('a bus that fails is logged and never undoes or holds up the stop or the skip', async () => {
    const broken = { publish: vi.fn(async () => Promise.reject(new Error('nats down'))) } as unknown as MemoryEventBus;
    const ctx = setup([fill(BUY)], broken);
    const followId = await ctx.follow('10');
    await expect(ctx.svc.runMirrorSweep()).resolves.toMatchObject({ refused: 1 });
    const ack = await ctx.svc.stop(principal, { followId });
    expect(ack.newIntentFenced).toBe(true);
    expect((await ctx.svc.skipLog(principal, { followId })).items.map((i) => i.reason)).toEqual(['risk_control']);
    expect(ctx.warn.mock.calls.map(([msg, fields]) => [msg, fields.event])).toEqual([
      ['trade.copy.notice_unsent', 'copy.skipped'],
      ['trade.copy.notice_unsent', 'copy.stopped'],
    ]);
  });
});
