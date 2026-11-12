/**
 * The follower's own copy rules (CB-copy-05, CB-copy-06; J-copy-bots-otc-02 #1 to #3): sizing mode and its lock, smart
 * sync's sizing, the owner's minimum investment, the most per contract and the most per owner day. Every refusal is
 * checked to write nothing; no rule posts to the ledger.
 */
import type { Principal } from '@intafaced/auth';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { CopyService } from '../controls/test-admission.js';
import type { LookupLeaderFillPort } from './copy-service.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import { copyOwnerDay, parseCopyMinInvestment, parseCopyOwnerDay, parseCopySizingMode } from './follow-rules.js';
import { copySkipReasonFor } from './skip-log.js';

const FOLLOWER = '00000000-0000-4000-8000-0000000002f1';
const LEADER = '00000000-0000-4000-8000-0000000002c1';
const SESSION = '00000000-0000-4000-8000-0000000002d1';
const START = new Date('2026-11-12T22:00:00.000Z');
const fee = { published: true as const, leaderShareBps: 1337, earningsCapPerFollower: '100', decayRoundTrips: 0, decayShareBps: 4321 };
const jur = { published: true as const, allowedRegions: ['SG'] };

function principal(): Principal {
  return {
    sub: FOLLOWER,
    userId: FOLLOWER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date(START.getTime() + 3_600_000),
  } as Principal;
}

/** Leader fills by id: `<market>:<side>:<qty>:<notional>[:<tag>]`, e.g. `BTC/USDT:buy:0.001:30`. */
const fills: LookupLeaderFillPort = async (fillId) => {
  const [market, side, qty, notional] = fillId.split(':');
  return {
    fillId,
    userId: LEADER,
    marketId: market!,
    side: side as 'buy' | 'sell',
    qty: parseAmount(qty!),
    notional: parseAmount(notional!),
  };
};

async function setup(opts: { minInvestment?: string; ownerDay?: string; leaderUsdt?: string } = {}) {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: FOLLOWER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'rules-f' }));
  if (opts.leaderUsdt) {
    await ledger.post(
      recipes.deposit({ userId: LEADER, assetId: 'USDT', amount: parseAmount(opts.leaderUsdt), rail: 'test', railRef: 'rules-l' }),
    );
  }
  const store = new MemoryCopyFollowStore();
  let now = START;
  const copy = new CopyService(ledger, {
    feeShareLaw: fee,
    jurisdictionLaw: jur,
    minTier: 'full',
    minInvestment: parseCopyMinInvestment(opts.minInvestment ?? '10'),
    ownerDay: parseCopyOwnerDay(opts.ownerDay ?? '0'),
    store,
    lookupLeaderFill: fills,
    // One copied BTC buy open, so a leader's sell has something to close.
    copiedPositions: async () => [
      {
        orderId: 'o-1',
        leaderFillId: 'BTC/USDT:buy:0.001:20',
        symbol: 'BTC/USDT',
        marketId: 'BTC/USDT',
        baseAsset: 'BTC',
        lotSize: parseAmount('0.00001'),
        bought: parseAmount('0.001'),
        open: parseAmount('0.001'),
        closing: 0n,
        status: 'open',
        placedAt: START,
      },
    ],
    now: () => now,
  });
  return { copy, store, ledger, at: (when: string) => (now = new Date(when)) };
}

const start = (over: Record<string, unknown> = {}) => ({
  leaderId: LEADER,
  region: 'SG',
  permittedMarkets: ['BTC/USDT', 'ETH/USDT'],
  maxNotionalPerOrder: '50',
  maxAggregateExposure: '300',
  fixedOrderSize: '20',
  expiresAt: '2026-12-01T00:00:00.000Z',
  clientRequestId: 'rules-start-0001',
  ...over,
});

/** A mirror request for a leader fill; the service reads market, side, qty and notional from the fill itself. */
function mirror(followId: string, fillId: string) {
  const [marketId, side, qty, notional] = fillId.split(':');
  return { followId, fillId, marketId: marketId!, side: side as 'buy' | 'sell', qty: qty!, notional: notional! };
}

async function journalOf(ledger: MemoryLedger) {
  return (await ledger.balances('user', FOLLOWER)).map((b) => `${b.accountId}:${b.amount}`);
}

describe('sizing mode (CB-copy-05)', () => {
  it('offers fixed amount and smart sync, and refuses multiplier as an owner decision before anything is written', async () => {
    expect(parseCopySizingMode(undefined)).toBe('fixed_amount');
    expect(parseCopySizingMode('smart_sync')).toBe('smart_sync');
    const ctx = await setup({ leaderUsdt: '3000' });
    await expect(ctx.copy.startFollow(principal(), start({ sizingMode: 'multiplier' }))).rejects.toMatchObject({
      code: 'trade.copy_mode_owner_decision',
    });
    expect(await ctx.store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  });

  it('smart sync keeps both readings and sizes a copy by the follower total over the leader balance, rounded to the lot', async () => {
    const ctx = await setup({ leaderUsdt: '3000' });
    const follow = await ctx.copy.startFollow(principal(), start({ sizingMode: 'smart_sync', fixedOrderSize: undefined }));
    expect(follow).toMatchObject({ sizingMode: 'smart_sync', smartSync: { followerTotal: '300' }, fixedOrderSize: null });
    // The leader's balance reading sizes the copy but is never shown to the follower.
    expect(JSON.stringify(follow)).not.toContain('leaderEquity');
    expect((await ctx.store.getFollow(follow.followId))?.envelope.smartSync).toEqual({
      followerTotal: parseAmount('300'),
      leaderEquity: parseAmount('3000'),
    });
    // The leader buys 0.01 BTC for 300 USDT: a tenth of that is 0.001 BTC for 30 USDT.
    const plan = await ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:buy:0.01:300'));
    expect(plan).toMatchObject({ qty: '0.001', notional: '30' });
  });

  it('smart sync refuses a leader with no balance to scale by, and refuses a fixed amount alongside it', async () => {
    const ctx = await setup();
    await expect(ctx.copy.startFollow(principal(), start({ sizingMode: 'smart_sync', fixedOrderSize: undefined }))).rejects.toMatchObject({
      code: 'trade.copy_smart_sync_unavailable',
    });
    const funded = await setup({ leaderUsdt: '100' });
    await expect(funded.copy.startFollow(principal(), start({ sizingMode: 'smart_sync' }))).rejects.toMatchObject({
      code: 'trade.copy_envelope_invalid',
    });
  });

  it('locks the mode on an active follow; a new follow after leaving may use another', async () => {
    const ctx = await setup({ leaderUsdt: '3000' });
    const follow = await ctx.copy.startFollow(principal(), start());
    await expect(ctx.copy.amendFollow(principal(), { followId: follow.followId, sizingMode: 'smart_sync' })).rejects.toMatchObject({
      code: 'trade.copy_mode_locked',
    });
    expect((await ctx.store.getFollow(follow.followId))?.envelope.sizingMode).toBe('fixed_amount');
    // Sending the same mode is no change and is accepted.
    await expect(ctx.copy.amendFollow(principal(), { followId: follow.followId, sizingMode: 'fixed_amount' })).resolves.toMatchObject({
      sizingMode: 'fixed_amount',
    });
    await ctx.copy.unfollow(principal(), { followId: follow.followId });
    const again = await ctx.copy.startFollow(
      principal(),
      start({ sizingMode: 'smart_sync', fixedOrderSize: undefined, clientRequestId: 'rules-start-0002' }),
    );
    expect(again.sizingMode).toBe('smart_sync');
  });
});

describe('minimum investment (CB-copy-06)', () => {
  it('a blank owner minimum refuses every follow, and a total below it refuses, writing and posting nothing', async () => {
    const blank = await setup({ minInvestment: '' });
    const before = await journalOf(blank.ledger);
    await expect(blank.copy.startFollow(principal(), start())).rejects.toMatchObject({ code: 'trade.copy_min_not_set' });
    expect(await blank.store.listFollowsByFollower(FOLLOWER)).toEqual([]);
    expect(await journalOf(blank.ledger)).toEqual(before);
    expect(blank.copy.deskStatus().minInvestment).toBeNull();

    const ctx = await setup({ minInvestment: '100' });
    expect(ctx.copy.deskStatus().minInvestment).toBe('100');
    await expect(ctx.copy.startFollow(principal(), start({ maxAggregateExposure: '99' }))).rejects.toMatchObject({
      code: 'trade.copy_below_min_investment',
    });
    expect(await ctx.store.listFollowsByFollower(FOLLOWER)).toEqual([]);
  });

  it('a spot follow has no leverage to limit: one sent is refused', async () => {
    const ctx = await setup();
    await expect(ctx.copy.follow(principal(), { ...start(), maxLeverage: '5' })).rejects.toMatchObject({
      code: 'trade.copy_leverage_unsupported',
    });
  });
});

describe('most per contract and most per day (CB-copy-06)', () => {
  it('refuses the copy that would pass the per-contract cap with its code, while another contract still copies', async () => {
    const ctx = await setup();
    const follow = await ctx.copy.startFollow(principal(), start());
    await ctx.copy.amendFollow(principal(), { followId: follow.followId, maxPerMarket: '25' });
    await ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:buy:0.001:20'));
    const refused = ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:buy:0.002:40'));
    await expect(refused).rejects.toMatchObject({ code: 'trade.copy_market_cap_reached' });
    expect(copySkipReasonFor(await refused.catch((e: unknown) => e))).toBe('per_contract_cap');
    await expect(ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'ETH/USDT:buy:0.01:20'))).resolves.toMatchObject({
      marketId: 'ETH/USDT',
      notional: '20',
    });
    // The refused copy claimed nothing.
    expect(await ctx.store.getMirroredFill(follow.followId, 'BTC/USDT:buy:0.002:40')).toBeNull();
    expect(await ctx.store.sumCopiedBuys(follow.followId, { marketId: 'BTC/USDT' })).toBe(parseAmount('20'));
  });

  it('a leader close is never held back by the caps: they limit new copies only', async () => {
    const ctx = await setup();
    const follow = await ctx.copy.startFollow(principal(), start());
    await ctx.copy.amendFollow(principal(), { followId: follow.followId, maxPerMarket: '20', maxPerDay: '20' });
    await ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:buy:0.001:20'));
    await expect(ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:buy:0.001:20:b'))).rejects.toMatchObject({
      code: 'trade.copy_market_cap_reached',
    });
    await expect(ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:sell:0.001:20'))).resolves.toMatchObject({
      side: 'sell',
      notional: '20',
    });
  });

  it('refuses past the daily cap and resumes at the next owner day', async () => {
    // Owner day at UTC+8: it starts at 16:00 UTC.
    const ctx = await setup({ ownerDay: '480' });
    const follow = await ctx.copy.startFollow(principal(), start());
    await ctx.copy.amendFollow(principal(), { followId: follow.followId, maxPerDay: '40' });
    await ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:buy:0.001:20'));
    await ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'ETH/USDT:buy:0.01:20'));
    ctx.at('2026-11-13T15:59:59.000Z');
    await expect(ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:buy:0.001:20:c'))).rejects.toMatchObject({
      code: 'trade.copy_daily_cap_reached',
    });
    ctx.at('2026-11-13T16:00:00.000Z');
    await expect(ctx.copy.planMirrorForFollow(principal(), mirror(follow.followId, 'BTC/USDT:buy:0.001:20:d'))).resolves.toMatchObject({
      notional: '20',
    });
  });

  it('a daily cap with no owner day refuses before it is saved; a blank cap clears', async () => {
    const ctx = await setup({ ownerDay: '' });
    const follow = await ctx.copy.startFollow(principal(), start());
    await expect(ctx.copy.amendFollow(principal(), { followId: follow.followId, maxPerDay: '40' })).rejects.toMatchObject({
      code: 'trade.copy_day_not_set',
    });
    expect((await ctx.store.getFollow(follow.followId))?.envelope.maxPerDay).toBeUndefined();
    await ctx.copy.amendFollow(principal(), { followId: follow.followId, maxPerMarket: '25' });
    await expect(ctx.copy.amendFollow(principal(), { followId: follow.followId, maxPerMarket: '' })).resolves.toMatchObject({
      maxPerMarket: null,
    });
  });

  it('counts the owner day from local midnight at the offset', () => {
    const day = copyOwnerDay(parseCopyOwnerDay('480'), new Date('2026-11-13T03:00:00.000Z'));
    expect(day.start.toISOString()).toBe('2026-11-12T16:00:00.000Z');
    expect(day.next.toISOString()).toBe('2026-11-13T16:00:00.000Z');
    const west = copyOwnerDay(parseCopyOwnerDay('-300'), new Date('2026-11-13T03:00:00.000Z'));
    expect(west.start.toISOString()).toBe('2026-11-12T05:00:00.000Z');
    expect(() => copyOwnerDay(parseCopyOwnerDay(''), new Date())).toThrow(expect.objectContaining({ code: 'trade.copy_day_not_set' }));
  });
});
