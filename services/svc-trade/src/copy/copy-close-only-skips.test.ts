/**
 * Stop with close-only, the skip log and the close of one copied position (CB-copy-09/10/11), on the copy service
 * with its in-memory store: what the copy driver copies after each control, the one skip row per leader fill and its
 * reason, and each refusal of a close by its typed code with nothing placed.
 */
import type { Principal } from '@intafaced/auth';
import { MemoryLedger, parseAmount, type Amount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { readyTestAdmission } from '../controls/test-admission.js';
import { TradeError } from '../spot/types.js';
import type { CopiedPosition } from './copied-positions.js';
import type { CopyClosePlaceInput, CopyClosePort, CopyCloseRecord } from './copy-close.js';
import { CopyService, type LeaderFill } from './copy-service.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './index.js';
import { copySkipReasonFor } from './skip-log.js';

const FOLLOWER = '00000000-0000-4000-8000-0000000000c1';
const LEADER = '00000000-0000-4000-8000-0000000000c2';
const NOW = new Date('2026-10-24T08:00:00.000Z');
const principal = {
  sub: FOLLOWER,
  userId: FOLLOWER,
  sid: '00000000-0000-4000-8000-0000000000c3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'full',
  mfa: true,
  expiresAt: new Date(NOW.getTime() + 60_000),
} as Principal;
const stranger = { ...principal, sub: LEADER, userId: LEADER } as Principal;
const fee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 1000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 0,
  decayShareBps: 1000,
};
const jur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

function fill(fillId: string, over: Partial<LeaderFill> = {}): LeaderFill {
  return {
    fillId,
    userId: LEADER,
    marketId: 'BTC/USDT',
    side: 'buy',
    qty: parseAmount('0.001'),
    notional: parseAmount('45'),
    price: parseAmount('45000'),
    ...over,
  };
}

function position(over: Partial<CopiedPosition> = {}): CopiedPosition {
  return {
    orderId: 'buy-order-1',
    leaderFillId: 'leader-fill-1',
    symbol: 'BTC/USDT',
    marketId: 'market-btc',
    baseAsset: 'BTC',
    lotSize: parseAmount('0.00001'),
    bought: parseAmount('0.0005'),
    open: parseAmount('0.0003'),
    closing: 0n,
    status: 'open',
    placedAt: NOW,
    ...over,
  };
}

class FakeClosePort implements CopyClosePort {
  readonly records = new Map<string, CopyCloseRecord>();
  readonly placed: CopyClosePlaceInput[] = [];
  readonly resumed: string[] = [];
  async find(closeKey: string) {
    return this.records.get(closeKey) ?? null;
  }
  async resume(_: Principal, record: CopyCloseRecord) {
    this.resumed.push(record.closeKey);
    return { orderId: record.followerOrderId };
  }
  async place(_: Principal, input: CopyClosePlaceInput) {
    this.placed.push(input);
    const record: CopyCloseRecord = {
      closeKey: input.closeKey,
      followId: input.followId,
      leaderFillId: input.leaderFillId,
      followerOrderId: `close-${this.placed.length}`,
      clientOrderId: input.closeKey,
      symbol: input.symbol,
      marketId: 'market-btc',
      qty: input.qty,
      price: parseAmount('44000'),
    };
    this.records.set(input.closeKey, record);
    return { orderId: record.followerOrderId };
  }
}

function setup(fills: LeaderFill[], opts: { positions?: CopiedPosition[] | null; close?: CopyClosePort | null } = {}) {
  const placed: Array<{ side: string; qty: Amount; clientOrderId: string }> = [];
  let positions: CopiedPosition[] = opts.positions === undefined ? [position()] : (opts.positions ?? []);
  const time = (fillId: string) => new Date(NOW.getTime() + (fills.findIndex((f) => f.fillId === fillId) + 1) * 1000);
  const svc = new CopyService(new MemoryLedger(), {
    accountAdmission: readyTestAdmission(),
    feeShareLaw: fee,
    jurisdictionLaw: jur,
    placeMirrorEnabled: true,
    now: () => NOW,
    inspectMarket: async () => ({ paper: false, lotSize: parseAmount('0.00001') }),
    placeFollowerOrder: async (_, input) => {
      placed.push({ side: input.side, qty: input.qty, clientOrderId: input.clientOrderId });
      return { orderId: `order-${placed.length}` };
    },
    lookupLeaderFill: async (fillId) => fills.find((f) => f.fillId === fillId) ?? null,
    listLeaderFillsSince: async (leaderId, after, limit) =>
      fills
        .filter((f) => f.userId === leaderId)
        .map((f) => ({ fillId: f.fillId, marketId: f.marketId, at: time(f.fillId) }))
        .filter((f) => f.at.getTime() > after.at.getTime() || (f.at.getTime() === after.at.getTime() && f.fillId > (after.fillId ?? '')))
        .slice(0, limit),
    ...(opts.positions === null ? {} : { copiedPositions: async () => positions }),
    ...(opts.close === null ? {} : { copyClose: opts.close ?? new FakeClosePort() }),
  });
  const follow = async () => {
    const made = await svc.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC/USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '500',
      fixedOrderSize: '20',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    await svc.grantSessionKey(principal, { followId: made.followId });
    return made.followId;
  };
  return { svc, placed, follow, setPositions: (next: CopiedPosition[]) => (positions = next) };
}

const BUY = '11111111-1111-4111-8111-1111111111c1';
const SELL = '22222222-2222-4222-8222-2222222222c2';
const SELL2 = '33333333-3333-4333-8333-3333333333c3';

describe('stop with close-only (CB-copy-09)', () => {
  it('fences new opens, keeps the grant, and still copies the leader close, capped at what is copied and open', async () => {
    const ctx = setup([fill(BUY), fill(SELL, { side: 'sell' })]);
    const followId = await ctx.follow();

    const ack = await ctx.svc.stop(principal, { followId, closeOnly: true });
    expect(ack).toMatchObject({
      relationshipState: 'CLOSE_ONLY',
      disposition: 'STOP_CLOSE_ONLY',
      newIntentFenced: true,
      sessionKeyRevoked: false,
    });

    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 1, refused: 1, failed: 0 });
    // The buy is not copied. The sell is, at 0.0003 (what is open), not the 0.00044 the fixed size would sell.
    expect(ctx.placed).toEqual([{ side: 'sell', qty: parseAmount('0.0003'), clientOrderId: expect.any(String) }]);
    const skips = await ctx.svc.skipLog(principal, { followId });
    expect(skips.items).toEqual([{ leaderFillId: BUY, reason: 'stopped', at: expect.any(String) }]);
  });

  it('copies a leader close in full when less than is open is sold', async () => {
    const ctx = setup([fill(SELL, { side: 'sell' })], { positions: [position({ open: parseAmount('0.001') })] });
    const followId = await ctx.follow();
    await ctx.svc.stop(principal, { followId, closeOnly: true });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 1, refused: 0, failed: 0 });
    expect(ctx.placed.map((p) => [p.side, p.qty])).toEqual([['sell', parseAmount('0.00044')]]);
  });

  it('skips a leader close with nothing copied open, by its reason, and never sells', async () => {
    const ctx = setup([fill(SELL, { side: 'sell' })], { positions: [position({ open: 0n, status: 'closed' })] });
    const followId = await ctx.follow();
    await ctx.svc.stop(principal, { followId, closeOnly: true });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 1, failed: 0 });
    expect(ctx.placed).toEqual([]);
    expect((await ctx.svc.skipLog(principal, { followId })).items.map((i) => i.reason)).toEqual(['position_closed']);
  });

  it('refuses a close-only sell when its copied positions cannot be read, and copies nothing', async () => {
    const ctx = setup([fill(SELL, { side: 'sell' })], { positions: null });
    const followId = await ctx.follow();
    await ctx.svc.stop(principal, { followId, closeOnly: true });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 1, failed: 0 });
    expect(ctx.placed).toEqual([]);
  });

  it('a plain stop still revokes the grant: the leader close is not copied either', async () => {
    const ctx = setup([fill(SELL, { side: 'sell' })]);
    const followId = await ctx.follow();
    const ack = await ctx.svc.stop(principal, { followId });
    expect(ack).toMatchObject({ relationshipState: 'STOPPING', disposition: 'STOP_NEW', sessionKeyRevoked: true });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect(ctx.placed).toEqual([]);
  });

  it('refuses close-only from a plain stop by its typed code, and the follow stays stopped', async () => {
    const ctx = setup([]);
    const followId = await ctx.follow();
    await ctx.svc.stop(principal, { followId });
    await expect(ctx.svc.stop(principal, { followId, closeOnly: true })).rejects.toMatchObject({ code: 'trade.copy_state_invalid' });
    const [mine] = await ctx.svc.listMyFollows(principal, 10);
    expect(mine).toMatchObject({ followId, relationshipState: 'STOPPING' });
  });
});

describe('the skip log (CB-copy-11)', () => {
  it('writes one paused row per leader fill made while paused, and a second sweep writes none', async () => {
    const ctx = setup([fill(BUY), fill(SELL2)]);
    const followId = await ctx.follow();
    await ctx.svc.pause(principal, { followId });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    const items = (await ctx.svc.skipLog(principal, { followId })).items;
    expect(items.map((i) => [i.leaderFillId, i.reason]).sort()).toEqual([
      [BUY, 'paused'],
      [SELL2, 'paused'],
    ]);
    // Resuming never copies a fill made while paused.
    await ctx.svc.resume(principal, { followId });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect(ctx.placed).toEqual([]);
  });

  it('logs the fills made while paused when the follow leaves the pause before a sweep', async () => {
    const resumed = setup([fill(BUY)]);
    const a = await resumed.follow();
    await resumed.svc.pause(principal, { followId: a });
    await resumed.svc.resume(principal, { followId: a });
    expect(await resumed.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect((await resumed.svc.skipLog(principal, { followId: a })).items.map((i) => i.reason)).toEqual(['paused']);

    const stopped = setup([fill(BUY)]);
    const b = await stopped.follow();
    await stopped.svc.pause(principal, { followId: b });
    await stopped.svc.stop(principal, { followId: b, closeOnly: true });
    expect((await stopped.svc.skipLog(principal, { followId: b })).items.map((i) => i.reason)).toEqual(['paused']);
  });

  it('names the reason of a refused copy, never the raw code', async () => {
    // At 3,000,000 a unit, 20 USDT buys less than one lot: the copy is refused.
    const ctx = setup([fill(BUY, { qty: parseAmount('0.00001'), notional: parseAmount('30'), price: parseAmount('3000000') })]);
    const followId = await ctx.follow();
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 1, failed: 0 });
    const [row] = (await ctx.svc.skipLog(principal, { followId })).items;
    expect(row?.leaderFillId).toBe(BUY);
    expect(row?.reason).not.toMatch(/^trade\./);
  });

  it('maps each documented refusal to its reason id', () => {
    expect(copySkipReasonFor(new TradeError('x', 'trade.copy_slippage_exceeded' as never))).toBe('copy_slippage_exceeded');
    expect(copySkipReasonFor(new Error('x'))).toBe('refused');
  });

  it('shows the log only to the follower', async () => {
    const ctx = setup([]);
    const followId = await ctx.follow();
    await expect(ctx.svc.skipLog(stranger, { followId })).rejects.toMatchObject({ code: 'trade.copy_not_following' });
  });
});

describe('closing one copied position (CB-copy-10)', () => {
  it('closes what is open, once per key: asking again returns the same order and places nothing new', async () => {
    const port = new FakeClosePort();
    const ctx = setup([], { close: port });
    const followId = await ctx.follow();

    const first = await ctx.svc.closePosition(principal, { followId, positionId: 'buy-order-1' });
    expect(first).toMatchObject({ orderId: 'close-1', qty: '0.0003', duplicate: false });
    expect(port.placed).toEqual([
      expect.objectContaining({ closeKey: `copy.close:${followId}:leader-fill-1`, qty: parseAmount('0.0003') }),
    ]);

    ctx.setPositions([position({ open: 0n, status: 'closing' })]);
    const again = await ctx.svc.closePosition(principal, { followId, positionId: 'buy-order-1' });
    expect(again).toMatchObject({ orderId: 'close-1', duplicate: true });
    expect(port.placed).toHaveLength(1);
    expect(port.resumed).toEqual([`copy.close:${followId}:leader-fill-1`]);
  });

  it('closes part by its own key, and refuses more than is open by its typed code with nothing placed', async () => {
    const port = new FakeClosePort();
    const ctx = setup([], { close: port });
    const followId = await ctx.follow();

    await expect(ctx.svc.closePosition(principal, { followId, positionId: 'buy-order-1', qty: '1' })).rejects.toMatchObject({
      code: 'trade.copy_close_qty_exceeds',
    });
    expect(port.placed).toEqual([]);

    const part = await ctx.svc.closePosition(principal, { followId, positionId: 'buy-order-1', qty: '0.0001' });
    expect(part).toMatchObject({ qty: '0.0001', duplicate: false });
    expect(port.placed.map((p) => p.closeKey)).toEqual([`copy.close:${followId}:leader-fill-1:0.0001`]);
  });

  it('refuses each bad close by its typed code and places nothing', async () => {
    const port = new FakeClosePort();
    const ctx = setup([], { close: port });
    const followId = await ctx.follow();

    await expect(ctx.svc.closePosition(principal, { followId, positionId: 'no-such-order' })).rejects.toMatchObject({
      code: 'trade.copy_position_not_found',
    });
    for (const qty of ['abc', '0', '-1']) {
      await expect(ctx.svc.closePosition(principal, { followId, positionId: 'buy-order-1', qty })).rejects.toMatchObject({
        code: 'trade.copy_close_qty_invalid',
      });
    }
    ctx.setPositions([position({ open: 0n, status: 'closed' })]);
    await expect(ctx.svc.closePosition(principal, { followId, positionId: 'buy-order-1' })).rejects.toMatchObject({
      code: 'trade.copy_position_closed',
    });
    await expect(ctx.svc.closePosition(stranger, { followId, positionId: 'buy-order-1' })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    expect(port.placed).toEqual([]);
  });

  it('refuses when the close port is not wired', async () => {
    const ctx = setup([], { close: null });
    const followId = await ctx.follow();
    await expect(ctx.svc.closePosition(principal, { followId, positionId: 'buy-order-1' })).rejects.toMatchObject({
      code: 'trade.copy_close_unavailable',
    });
  });
});
