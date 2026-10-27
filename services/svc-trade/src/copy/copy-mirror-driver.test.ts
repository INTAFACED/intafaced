/**
 * The copy driver (CB-copy-10, J-copy-bots-otc-01 #8): each new live fill of a leader becomes one copied order for
 * every active follow whose follower granted automatic copying, placed as that follower through the same plan and
 * place doors a manual copy uses. Nothing is copied without the grant, after a stop or a revoke, outside the
 * follow's markets, or twice.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyTestAdmission } from '../controls/test-admission.js';
import { CopyService, type LeaderFill } from './copy-service.js';
import { SqlCopyFollowStore } from './follow-store.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './index.js';
import { dropFollowSessionKey } from './session-key.js';

const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const FOLLOWER = '00000000-0000-4000-8000-0000000000a1';
const LEADER = '00000000-0000-4000-8000-0000000000a2';
const NOW = new Date('2026-10-24T08:00:00.000Z');
const principal = {
  sub: FOLLOWER,
  userId: FOLLOWER,
  sid: '00000000-0000-4000-8000-0000000000a3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'full',
  mfa: true,
  expiresAt: new Date(NOW.getTime() + 60_000),
} as Principal;
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

/** Each fill is made a second after the one before it, all after the follow starts copying. */
const fillTime = (fills: LeaderFill[], fillId: string) =>
  new Date(NOW.getTime() + (fills.findIndex((f) => f.fillId === fillId) + 1) * 1000);

function setup(
  fills: LeaderFill[],
  opts: {
    placeMirrorEnabled?: boolean;
    place?: (userId: string) => void;
    readResultFigure?: () => Promise<{ figure: bigint | null; missing: string | null }>;
  } = {},
) {
  const placed: Array<{ userId: string; qty: bigint; price: bigint; clientOrderId: string }> = [];
  let clock = NOW;
  const svc = new CopyService(new MemoryLedger(), {
    accountAdmission: readyTestAdmission(),
    feeShareLaw: fee,
    jurisdictionLaw: jur,
    placeMirrorEnabled: opts.placeMirrorEnabled ?? true,
    now: () => clock,
    inspectMarket: async () => ({ paper: false, lotSize: parseAmount('0.00001') }),
    ...(opts.readResultFigure ? { readResultFigure: opts.readResultFigure } : {}),
    placeFollowerOrder: async (p, input) => {
      opts.place?.(p.userId);
      placed.push({ userId: p.userId, qty: input.qty, price: input.price, clientOrderId: input.clientOrderId });
      return { orderId: `order-${placed.length}` };
    },
    lookupLeaderFill: async (fillId) => fills.find((f) => f.fillId === fillId) ?? null,
    listLeaderFillsSince: async (leaderId, after, limit) =>
      fills
        .filter((f) => f.userId === leaderId)
        .map((f) => ({ fillId: f.fillId, marketId: f.marketId, at: fillTime(fills, f.fillId) }))
        .filter((f) => f.at.getTime() > after.at.getTime() || (f.at.getTime() === after.at.getTime() && f.fillId > (after.fillId ?? '')))
        .slice(0, limit),
  });
  const follow = async (who: Principal = principal, extra: { maxLoss?: string } = {}) => {
    return svc.follow(who, {
      ...extra,
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC/USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '500',
      fixedOrderSize: '20',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
  };
  return {
    svc,
    placed,
    follow,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    at: (when: Date) => (clock = when),
  };
}

describe('the copy driver', () => {
  it('copies a new leader fill once, as the follower, at the fixed amount on the lot step', async () => {
    const ctx = setup([fill('11111111-1111-4111-8111-111111111111')]);
    const follow = await ctx.follow();
    await ctx.svc.grantSessionKey(principal, { followId: follow.followId });

    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 1, refused: 0, failed: 0 });
    expect(ctx.placed).toHaveLength(1);
    expect(ctx.placed[0]).toMatchObject({ userId: FOLLOWER, qty: parseAmount('0.00044'), price: parseAmount('45000') });

    // The next sweep sees the copy already placed and places nothing.
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect(ctx.placed).toHaveLength(1);
  });

  it('copies nothing until the follower grants automatic copying, and nothing after they revoke it', async () => {
    const ctx = setup([fill('22222222-2222-4222-8222-222222222222')]);
    const follow = await ctx.follow();
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });

    await ctx.svc.grantSessionKey(principal, { followId: follow.followId });
    await ctx.svc.killSessionKey(principal, { followId: follow.followId });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect(ctx.placed).toEqual([]);
  });

  it('copies nothing for a paused follow, a market outside the follow, or while copy placing is off', async () => {
    const paused = setup([fill('33333333-3333-4333-8333-333333333333')]);
    const p = await paused.follow();
    await paused.svc.grantSessionKey(principal, { followId: p.followId });
    await paused.svc.pause(principal, { followId: p.followId });
    expect(await paused.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });

    const elsewhere = setup([fill('44444444-4444-4444-8444-444444444444', { marketId: 'ETH/USDT' })]);
    const e = await elsewhere.follow();
    await elsewhere.svc.grantSessionKey(principal, { followId: e.followId });
    expect(await elsewhere.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });

    const off = setup([fill('55555555-5555-4555-8555-555555555555')], { placeMirrorEnabled: false });
    const o = await off.follow();
    await off.svc.grantSessionKey(principal, { followId: o.followId });
    expect(await off.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });

    expect([...paused.placed, ...elsewhere.placed, ...off.placed]).toEqual([]);
  });

  it('counts a refused copy and carries on with the next fill', async () => {
    // At 3,000,000 a unit, 20 USDT buys less than one 0.00001 lot, so that copy is refused; the next fill is copied.
    const ctx = setup([
      fill('66666666-6666-4666-8666-666666666666', {
        qty: parseAmount('0.00001'),
        notional: parseAmount('30'),
        price: parseAmount('3000000'),
      }),
      fill('77777777-7777-4777-8777-777777777777'),
    ]);
    const follow = await ctx.follow();
    await ctx.svc.grantSessionKey(principal, { followId: follow.followId });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 1, refused: 1, failed: 0 });
    expect(ctx.placed).toHaveLength(1);
  });

  it('moves past every fill it dealt with, so a leader with many fills is copied to the newest, each fill once', async () => {
    const ids = ['a1', 'a2', 'a3'].map((n, i) => `aaaaaaa${i}-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`);
    const ctx = setup(ids.map((id) => fill(id)));
    const follow = await ctx.follow();
    await ctx.svc.grantSessionKey(principal, { followId: follow.followId });
    expect(await ctx.svc.runMirrorSweep({ fillsPerFollow: 2 })).toEqual({ placed: 2, refused: 0, failed: 0 });
    expect(await ctx.svc.runMirrorSweep({ fillsPerFollow: 2 })).toEqual({ placed: 1, refused: 0, failed: 0 });
    expect(await ctx.svc.runMirrorSweep({ fillsPerFollow: 2 })).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect(ctx.placed.map((p) => p.clientOrderId)).toHaveLength(3);
  });

  it('tries a refused fill once: the next sweep does not refuse it again', async () => {
    const ctx = setup([
      fill('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
        qty: parseAmount('0.00001'),
        notional: parseAmount('30'),
        price: parseAmount('3000000'),
      }),
    ]);
    const follow = await ctx.follow();
    await ctx.svc.grantSessionKey(principal, { followId: follow.followId });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 1, failed: 0 });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
  });

  it('copies none of the fills the leader made while copying was off, once it is turned back on', async () => {
    const fills = [fill('cccccccc-cccc-4ccc-8ccc-cccccccccccc')];
    const ctx = setup(fills);
    const follow = await ctx.follow();
    await ctx.svc.grantSessionKey(principal, { followId: follow.followId });
    await ctx.svc.killSessionKey(principal, { followId: follow.followId });
    // The leader trades (at NOW + 1s) while copying is off; copying is turned on again after that.
    ctx.at(new Date(NOW.getTime() + 5_000));
    await ctx.svc.grantSessionKey(principal, { followId: follow.followId });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect(ctx.placed).toEqual([]);
  });

  it('keeps copying for other follows when one fails, and tries the failed fill again next sweep', async () => {
    const other = { ...principal, sub: LEADER.replace('a2', 'b1'), userId: LEADER.replace('a2', 'b1') } as Principal;
    let broken = true;
    const ctx = setup([fill('dddddddd-dddd-4ddd-8ddd-dddddddddddd')], {
      place: (userId) => {
        if (broken && userId === FOLLOWER) throw new Error('connection reset');
      },
    });
    const mine = await ctx.follow();
    const theirs = await ctx.follow(other);
    await ctx.svc.grantSessionKey(principal, { followId: mine.followId });
    await ctx.svc.grantSessionKey(other, { followId: theirs.followId });
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 1, refused: 0, failed: 1 });
    expect(ctx.placed.map((p) => p.userId)).toEqual([other.userId]);
    broken = false;
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 1, refused: 0, failed: 0 });
    expect(ctx.placed.map((p) => p.userId)).toEqual([other.userId, FOLLOWER]);
  });

  it('copies for a follow with a loss limit while its result reads, and refuses while it cannot', async () => {
    const ok = setup([fill('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')], {
      readResultFigure: async () => ({ figure: parseAmount('-1'), missing: null }),
    });
    const f = await ok.follow(principal, { maxLoss: '50' });
    await ok.svc.grantSessionKey(principal, { followId: f.followId });
    expect(await ok.svc.runMirrorSweep()).toEqual({ placed: 1, refused: 0, failed: 0 });

    const unread = setup([fill('ffffffff-ffff-4fff-8fff-ffffffffffff')], {
      readResultFigure: async () => ({ figure: null, missing: 'mark' }),
    });
    const g = await unread.follow(principal, { maxLoss: '50' });
    await unread.svc.grantSessionKey(principal, { followId: g.followId });
    expect(await unread.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 1, failed: 0 });
  });

  it('stops placing as the follower once the envelope has expired', async () => {
    const ctx = setup([fill('88888888-8888-4888-8888-888888888888')]);
    const follow = await ctx.follow();
    await ctx.svc.grantSessionKey(principal, { followId: follow.followId });
    ctx.advance(60 * 24 * 60 * 60 * 1000);
    expect(await ctx.svc.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    expect(ctx.placed).toEqual([]);
  });
});

describe('the automatic-copying grant on Postgres', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. The copy driver grant test does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'trade', url: url.toString(), migrations });
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('keeps the session key hash and the place grant across a restart, and a revoke too', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    const svc = new CopyService(new MemoryLedger(), {
      accountAdmission: readyTestAdmission(),
      feeShareLaw: fee,
      jurisdictionLaw: jur,
      store,
      now: () => NOW,
    });
    const follow = await svc.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC/USDT'],
      maxNotionalPerOrder: '100',
      maxAggregateExposure: '500',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const granted = await svc.grantSessionKey(principal, { followId: follow.followId });
    dropFollowSessionKey(follow.followId); // what a restart does to the in-process copy

    const [row] = await db!.sql<Array<{ session_key_hash: string; place_grant: { sid: string; scopes: string[] } }>>`
      SELECT session_key_hash, place_grant FROM copy_follows WHERE follow_id = ${follow.followId}
    `;
    expect(row?.session_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.session_key_hash).not.toContain(granted.sessionKey);
    expect(row?.place_grant).toMatchObject({ sid: principal.sid, scopes: ['trade:read', 'trade:write'] });

    const restarted = await new SqlCopyFollowStore(db!.sql).getFollow(follow.followId);
    expect(restarted).toMatchObject({ sessionKeyRevoked: false, placeGrant: { sid: principal.sid, tier: 'full', mfa: true } });

    expect(restarted?.copyCursor).toEqual({ at: NOW, fillId: null });

    // The cursor only moves forward, and saving the follow leaves it where the driver put it.
    const later = { at: new Date(NOW.getTime() + 1000), fillId: '11111111-1111-4111-8111-111111111111' };
    await store.setCopyCursor(follow.followId, later, 'forward');
    await store.setCopyCursor(follow.followId, { at: NOW, fillId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, 'forward');
    await store.saveFollow(restarted!);
    expect((await store.getFollow(follow.followId))?.copyCursor).toEqual(later);
    expect((await store.listCopyingFollows(NOW)).map((f) => f.followId)).toEqual([follow.followId]);

    await svc.killSessionKey(principal, { followId: follow.followId });
    dropFollowSessionKey(follow.followId);
    const killed = await new SqlCopyFollowStore(db!.sql).getFollow(follow.followId);
    expect(killed?.sessionKeyRevoked).toBe(true);
    expect(killed?.placeGrant).toBeUndefined();
    expect(await store.listCopyingFollows(NOW)).toEqual([]);
  });
});
