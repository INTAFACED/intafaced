/**
 * The lead's own desk (J-copy-bots-otc-05 #1 #6 #7): removing copiers under the daily limit and never with open copied
 * positions, each removal under its own key; the level from the owner's thresholds and no profit-share ratio; stopping
 * leading refused while a spot position is open, then review pending until a founder decides.
 */
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import type { CopiedPosition } from './copied-positions.js';
import { followRelationshipState } from './copy-lifecycle.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import type { CopyFollow } from './follows.js';
import {
  LeadOwnDesk,
  MemoryLeadOwnStore,
  leadRemovalKey,
  parseLeadLevels,
  parseLeadRemovalDailyLimit,
  type LeadLevels,
} from './lead-own-desk.js';
import type { LeaderTrade } from './leader-profile.js';

const LEAD = '22222222-2222-4222-8222-222222222222';
const OTHER_LEAD = '44444444-4444-4444-8444-444444444444';

const who = (userId: string, scopes: string[] = ['trade:read', 'trade:write']): Principal =>
  ({ sub: userId, userId, sid: 's', scopes, tier: 'full', mfa: false, expiresAt: new Date(Date.now() + 60_000) }) as Principal;
const founder = who('99999999-9999-4999-8999-999999999999', ['admin:read', 'admin:write']);

function follow(n: number, leaderId = LEAD, reserve = '100'): CopyFollow {
  return {
    followId: `follow-${n}`,
    followerId: `follower-${n}`,
    leaderId,
    region: 'DE',
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, n)),
    feeShareKilled: false,
    envelope: {
      permittedMarkets: ['BTC/USDT'],
      maxNotionalPerOrder: parseAmount('50'),
      maxAggregateExposure: parseAmount('200'),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
    reserve: { asset: 'USDT', amount: parseAmount(reserve), heldAt: new Date('2026-11-01T00:00:00Z'), releasedAt: null },
  };
}

const position = (status: CopiedPosition['status']): CopiedPosition => ({
  orderId: 'o1',
  leaderFillId: 'f1',
  symbol: 'BTC/USDT',
  marketId: 'BTC-USDT',
  baseAsset: 'BTC',
  lotSize: parseAmount('0.0001'),
  bought: parseAmount('0.001'),
  open: status === 'closed' ? 0n : parseAmount('0.001'),
  closing: 0n,
  status,
  placedAt: new Date(),
});

const trade = (state: 'open' | 'closed'): LeaderTrade => ({
  tradeId: 't1',
  symbol: 'BTC/USDT',
  state,
  openedAt: null,
  closedAt: null,
  entryPrice: null,
  qty: '0.001',
  margin: null,
  takeProfit: null,
  stopLoss: null,
  closePrice: null,
  closedQty: state === 'closed' ? '0.001' : '0',
  roiPercent: null,
});

const LEVELS: LeadLevels = parseLeadLevels(
  JSON.stringify({
    asset: 'USDT',
    levels: [
      { name: 'TEST Cadet', minCopiedFunds: '0' },
      { name: 'TEST Silver', minCopiedFunds: '500' },
    ],
  }),
)!;

async function setup(opts: { limit?: number | null; levels?: LeadLevels | null; follows?: CopyFollow[]; listed?: boolean } = {}) {
  const follows = new MemoryCopyFollowStore();
  for (const f of opts.follows ?? []) await follows.saveFollow(f);
  const open = new Set<string>();
  const leaderTrades: LeaderTrade[] = [];
  const stateWrites: unknown[] = [];
  let state: 'listed' | 'delisted' = 'listed';
  let now = new Date('2026-11-12T10:00:00Z');
  const store = new MemoryLeadOwnStore(async (leaderId) =>
    (await follows.listFollows()).filter((f) => f.leaderId === leaderId).map((f) => f.followId),
  );
  const desk = new LeadOwnDesk({
    store,
    follows,
    directory: {
      listingIdentity: async (userId: string) =>
        opts.listed === false || userId !== LEAD
          ? null
          : { leaderRef: 'lead-ref', state, marketMode: 'spot' as const, displayName: 'TEST Lead' },
      setLeaderState: async (_p: Principal, input: { state: string; clientRequestId: string }) => {
        stateWrites.push(input);
        state = input.state as 'delisted';
        return {} as never;
      },
    },
    copiedPositions: async ({ followId }) => (open.has(followId) ? [position('open')] : [position('closed')]),
    leaderTrades: async () => leaderTrades,
    now: () => now,
    removalDailyLimit: opts.limit === undefined ? 10 : opts.limit,
    levels: opts.levels === undefined ? LEVELS : opts.levels,
  });
  return {
    desk,
    store,
    follows,
    open,
    leaderTrades,
    stateWrites,
    setNow: (at: Date) => (now = at),
    state: () => state,
  };
}

describe('owner values', () => {
  it('reads a blank removal limit as unset and refuses anything but a whole number', () => {
    expect(parseLeadRemovalDailyLimit('')).toBeNull();
    expect(parseLeadRemovalDailyLimit(' 10 ')).toBe(10);
    for (const bad of ['0', '-1', '1.5', 'ten', '10001']) expect(() => parseLeadRemovalDailyLimit(bad)).toThrow();
  });
  it('reads blank levels as unset and refuses thresholds that do not rise or are not decimal strings', () => {
    expect(parseLeadLevels('')).toBeNull();
    expect(() =>
      parseLeadLevels('{"asset":"USDT","levels":[{"name":"A","minCopiedFunds":"5"},{"name":"B","minCopiedFunds":"5"}]}'),
    ).toThrow();
    expect(() => parseLeadLevels('{"asset":"USDT","levels":[{"name":"A","minCopiedFunds":5}]}')).toThrow();
    expect(() => parseLeadLevels('{"asset":"USDT","levels":[]}')).toThrow();
  });
});

describe('removing copiers (#1)', () => {
  it('refuses a copier with an open copied position and changes nothing', async () => {
    const t = await setup({ follows: [follow(1)] });
    t.open.add('follow-1');
    await expect(t.desk.removeFollower(who(LEAD), { followId: 'follow-1' })).rejects.toMatchObject({
      code: 'trade.copy_open_positions_block_removal',
    });
    expect(followRelationshipState((await t.follows.getFollow('follow-1'))!)).toBe('ACTIVE');
    expect(t.store.removals.size).toBe(0);
  });

  it('removes once they have closed: the follow is detached, its reserve released, one row under its key', async () => {
    const t = await setup({ follows: [follow(1)] });
    const out = await t.desk.removeFollower(who(LEAD), { followId: 'follow-1' });
    expect(out).toMatchObject({ outcome: 'removed', key: 'copy.lead.remove:follow-1' });
    const after = (await t.follows.getFollow('follow-1'))!;
    expect(followRelationshipState(after)).toBe('DETACHED');
    expect(after.reserve?.releasedAt).not.toBeNull();
    expect(await t.desk.removeFollower(who(LEAD), { followId: 'follow-1' })).toMatchObject({ outcome: 'already_removed' });
    expect(t.store.removals.size).toBe(1);
  });

  it('refuses the eleventh removal of the day with a limit of 10, and opens again the next UTC day', async () => {
    const t = await setup({ follows: Array.from({ length: 12 }, (_, i) => follow(i + 1)) });
    for (let i = 1; i <= 10; i += 1) await t.desk.removeFollower(who(LEAD), { followId: `follow-${i}` });
    await expect(t.desk.removeFollower(who(LEAD), { followId: 'follow-11' })).rejects.toMatchObject({
      code: 'trade.copy_removal_limit_reached',
    });
    expect(followRelationshipState((await t.follows.getFollow('follow-11'))!)).toBe('ACTIVE');
    t.setNow(new Date('2026-11-13T00:00:01Z'));
    expect(await t.desk.removeFollower(who(LEAD), { followId: 'follow-11' })).toMatchObject({ outcome: 'removed' });
  });

  it('refuses every removal while the owner limit is blank', async () => {
    const t = await setup({ limit: null, follows: [follow(1)] });
    await expect(t.desk.removeFollower(who(LEAD), { followId: 'follow-1' })).rejects.toMatchObject({
      code: 'trade.copy_removal_limit_unset',
    });
    await expect(t.desk.removeFollowers(who(LEAD), { followIds: ['follow-1'] })).rejects.toMatchObject({
      code: 'trade.copy_removal_limit_unset',
    });
  });

  it('gives each id of a bulk removal its own key, and a retry skips the ids already removed', async () => {
    const t = await setup({ limit: 3, follows: [1, 2, 3, 4, 5].map((n) => follow(n)) });
    t.open.add('follow-2');
    const ids = ['follow-1', 'follow-2', 'follow-3', 'follow-4', 'follow-5'];
    const first = await t.desk.removeFollowers(who(LEAD), { followIds: ids });
    expect(first.results.map((r) => [r.followId, r.key, r.outcome])).toEqual([
      ['follow-1', leadRemovalKey('follow-1'), 'removed'],
      ['follow-2', leadRemovalKey('follow-2'), 'refused'],
      ['follow-3', leadRemovalKey('follow-3'), 'removed'],
      ['follow-4', leadRemovalKey('follow-4'), 'removed'],
      ['follow-5', leadRemovalKey('follow-5'), 'refused'],
    ]);
    expect(first.results[1]).toMatchObject({ code: 'trade.copy_open_positions_block_removal' });
    expect(first.results[4]).toMatchObject({ code: 'trade.copy_removal_limit_reached' });
    const again = await t.desk.removeFollowers(who(LEAD), { followIds: ids });
    expect(again.results.map((r) => r.outcome)).toEqual(['already_removed', 'refused', 'already_removed', 'already_removed', 'refused']);
    expect(t.store.removals.size).toBe(3);
  });

  it('finishes a removal whose follow write never landed, by the same key', async () => {
    const t = await setup({ follows: [follow(1)] });
    // A crash after the removal row and before the follow write.
    await t.store.insertRemovalUnderLimit(
      { key: leadRemovalKey('follow-1'), leaderId: LEAD, followId: 'follow-1', followerId: 'follower-1', reason: null, at: new Date() },
      10,
      new Date(0),
    );
    expect(await t.desk.removeFollower(who(LEAD), { followId: 'follow-1' })).toMatchObject({ outcome: 'already_removed' });
    expect(followRelationshipState((await t.follows.getFollow('follow-1'))!)).toBe('DETACHED');
  });

  it("never removes or reads another lead's copier, and a caller who leads nothing is refused", async () => {
    const t = await setup({ follows: [follow(1, OTHER_LEAD)] });
    await expect(t.desk.removeFollower(who(LEAD), { followId: 'follow-1' })).rejects.toMatchObject({ code: 'trade.copy_not_following' });
    expect((await t.desk.followers(who(LEAD))).followers).toEqual([]);
    await expect(t.desk.followers(who(OTHER_LEAD))).rejects.toMatchObject({ code: 'trade.copy_lead_not_leading' });
  });

  it('lists copiers with what each set aside and their open copied positions', async () => {
    const t = await setup({ follows: [follow(1), follow(2)] });
    t.open.add('follow-2');
    const { followers, removalDailyLimit } = await t.desk.followers(who(LEAD));
    expect(removalDailyLimit).toBe(10);
    expect(followers.map((f) => [f.followId, f.investment, f.asset, f.openPositions])).toEqual(
      expect.arrayContaining([
        ['follow-1', '100', 'USDT', 0],
        ['follow-2', '100', 'USDT', 1],
      ]),
    );
  });
});

describe('the level (#6)', () => {
  it('reads the level and its threshold from copied funds, and the next level', async () => {
    const t = await setup({ follows: [follow(1, LEAD, '300'), follow(2, LEAD, '300')] });
    expect(await t.desk.level(who(LEAD))).toEqual({
      asset: 'USDT',
      copiedFunds: '600',
      level: { name: 'TEST Silver', threshold: '500' },
      next: null,
      levelsSet: true,
      maxRatio: null,
    });
  });
  it('reads Not set when the owner set no levels; a blank threshold never counts as zero', async () => {
    const t = await setup({ levels: null, follows: [follow(1)] });
    expect(await t.desk.level(who(LEAD))).toMatchObject({ level: null, next: null, levelsSet: false, maxRatio: null });
  });
  it('refuses any attempt to set a profit-share ratio', async () => {
    const t = await setup();
    await expect(t.desk.setProfitShareRatio(who(LEAD))).rejects.toMatchObject({ code: 'trade.copy_pnl_fee_forbidden' });
  });
});

describe('stopping leading (#7)', () => {
  it('refuses while a spot position is open and leaves the listing unchanged', async () => {
    const t = await setup();
    t.leaderTrades.push(trade('open'));
    await expect(t.desk.stopLeading(who(LEAD), { clientRequestId: 'stop-request-1' })).rejects.toMatchObject({
      code: 'trade.copy_lead_positions_open',
    });
    expect((await t.desk.listing(who(LEAD))).stop).toBeNull();
    expect(t.state()).toBe('listed');
  });

  it('once closed: review pending, the same request again is the same row, and a founder approval delists', async () => {
    const t = await setup();
    t.leaderTrades.push(trade('closed'));
    const stop = await t.desk.stopLeading(who(LEAD), { clientRequestId: 'stop-request-1' });
    expect(stop).toMatchObject({ state: 'review_pending', key: 'copy.lead.stop:lead-ref:stop-request-1' });
    expect((await t.desk.stopLeading(who(LEAD), { clientRequestId: 'stop-request-1' })).stopId).toBe(stop.stopId);
    expect(t.state()).toBe('listed');
    await expect(t.desk.decideStop(who(LEAD), { stopId: stop.stopId, decision: 'approve', reason: 'TEST ok' })).rejects.toThrow();
    const decided = await t.desk.decideStop(founder, { stopId: stop.stopId, decision: 'approve', reason: 'TEST closed out' });
    expect(decided.state).toBe('approved');
    expect(t.state()).toBe('delisted');
    expect(t.stateWrites).toEqual([
      expect.objectContaining({ state: 'delisted', clientRequestId: `copy.lead.stop:${stop.stopId}:approve` }),
    ]);
    // Deciding the same again answers the same decision and writes nothing more.
    await t.desk.decideStop(founder, { stopId: stop.stopId, decision: 'approve', reason: 'TEST closed out' });
    expect(t.stateWrites).toHaveLength(1);
  });

  it('a rejected review fails the stop and the listing stays listed', async () => {
    const t = await setup();
    const stop = await t.desk.stopLeading(who(LEAD), { clientRequestId: 'stop-request-2' });
    const decided = await t.desk.decideStop(founder, { stopId: stop.stopId, decision: 'reject', reason: 'TEST not yet' });
    expect(decided.state).toBe('failed');
    expect(t.state()).toBe('listed');
    expect(t.stateWrites).toEqual([]);
  });
});
