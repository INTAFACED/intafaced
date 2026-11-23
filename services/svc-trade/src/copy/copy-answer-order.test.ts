/**
 * The copy doors' answer schemas (lead-answers.ts, follow-answers.ts) send each answer byte for byte as its handler built
 * it. A zod object writes its keys in the schema's order, not the answer's, so a schema whose
 * order differs at any depth changes the JSON on the wire even when it names the same keys. Each answer here is built by
 * the real service, desk or presenter the router calls, and its JSON before and after the schema must be equal.
 */
import type { Principal } from '@intafaced/auth';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { partial } from '@intafaced/service-kit/testing';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { readyTestAdmission } from '../controls/test-admission.js';
import { principalFor } from '../spot/testing.js';
import type { CopiedPosition } from './copied-positions.js';
import type { CopyClosePlaceInput, CopyClosePort, CopyCloseRecord } from './copy-close.js';
import { CopyService, type LeaderFill, type VenueFollowsPort } from './copy-service.js';
import {
  copyCheckVenueFollowAnswer,
  copyCloseCopiedPositionAnswer,
  copyCopiedPositionsAnswer,
  copyFollowAnswer,
  copyGrantSessionKeyAnswer,
  copyLeaderProfileAnswer,
  copyLeaderTradesAnswer,
  copyListLeadersAnswer,
  copyListMyFollowsAnswer,
  copySkipLogAnswer,
} from './follow-answers.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './index.js';
import {
  applyToLeadAnswer,
  leadCopiersAnswer,
  leadEarningsAnswer,
  leadEligibilityAnswer,
  leadLevelAnswer,
  leadMissionsAnswer,
  leadTradesAnswer,
  myLeadAnswer,
  myLeadApplicationAnswer,
  platformPausesAnswer,
} from './lead-answers.js';
import { LeadDesk, type LeadDeskDeps, type LeadVenueRead } from './lead-applications.js';
import { leadFollowing } from './lead-conditions.js';
import { memoryLeaderDirectory } from './leader-directory.js';
import { pageLeaderTrades, pairLeaderTrades, parseCopyMetricDefinitionsJson, type LeaderOrderFills } from './leader-profile.js';
import { PlatformPauseDesk, type PlatformPauseDeps } from './platform-pauses.js';
import { MemoryCopyFollowStore } from './follow-store.js';

const FOLLOWER = '00000000-0000-4000-8000-0000000000e1';
const LEADER = '00000000-0000-4000-8000-0000000000e2';
const OPERATOR = '00000000-0000-4000-8000-0000000000e3';
const NOW = new Date('2026-10-24T08:00:00.000Z');
const follower = {
  sub: FOLLOWER,
  userId: FOLLOWER,
  sid: '00000000-0000-4000-8000-0000000000e4',
  scopes: ['trade:read', 'trade:write'],
  tier: 'full',
  mfa: true,
  expiresAt: new Date(NOW.getTime() + 60_000),
} as Principal;
const leader = { ...follower, sub: LEADER, userId: LEADER } as Principal;
const fee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 1337,
  earningsCapPerFollower: '100',
  decayRoundTrips: 0,
  decayShareBps: 4321,
};
const jur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

/** The answer as the router sends it, and as the handler built it, must be the same bytes. */
function keepsOrder(schema: z.ZodType, answer: unknown) {
  expect(JSON.stringify(schema.parse(answer))).toBe(JSON.stringify(answer));
}

const BUY = '11111111-1111-4111-8111-1111111111e1';
const SELL = '22222222-2222-4222-8222-2222222222e2';
const leaderFills: LeaderFill[] = [BUY, SELL].map((fillId, i) => ({
  fillId,
  userId: LEADER,
  marketId: 'BTC/USDT',
  side: i === 0 ? 'buy' : 'sell',
  qty: parseAmount('0.001'),
  notional: parseAmount('45'),
  price: parseAmount('45000'),
}));

/** Copied positions as the read port answers them: one spot-booked, one reported by a TEST venue. */
const positions: CopiedPosition[] = [
  {
    orderId: 'buy-order-1',
    leaderFillId: BUY,
    symbol: 'BTC/USDT',
    marketId: 'market-btc',
    baseAsset: 'BTC',
    lotSize: parseAmount('0.00001'),
    bought: parseAmount('0.0005'),
    open: parseAmount('0.0003'),
    closing: 0n,
    status: 'open',
    placedAt: NOW,
  },
  {
    orderId: 'buy-order-2',
    leaderFillId: 'leader-fill-2',
    symbol: 'ETH/USDT',
    marketId: 'market-eth',
    baseAsset: 'ETH',
    lotSize: parseAmount('0.0001'),
    bought: parseAmount('0.01'),
    open: parseAmount('0.01'),
    closing: 0n,
    status: 'open',
    placedAt: NOW,
    reportedBy: { venue: 'TEST venue', test: true, asOf: NOW },
  },
];

class FakeClosePort implements CopyClosePort {
  readonly records = new Map<string, CopyCloseRecord>();
  async latest(_followId: string, closeKey: string) {
    const record = this.records.get(closeKey);
    return record ? { record, attempts: 1, settled: false } : null;
  }
  async resume(_: Principal, record: CopyCloseRecord) {
    return { orderId: record.followerOrderId };
  }
  async place(_: Principal, input: CopyClosePlaceInput) {
    const record: CopyCloseRecord = {
      closeKey: input.closeKey,
      followId: input.followId,
      leaderFillId: input.leaderFillId,
      followerOrderId: `close-${this.records.size + 1}`,
      clientOrderId: input.closeKey,
      symbol: input.symbol,
      marketId: 'market-btc',
      qty: input.qty,
      price: parseAmount('44000'),
    };
    // The key the next ask reads back is the base key, without its attempt.
    this.records.set(input.closeKey.replace(/#\d+$/, ''), record);
    return { orderId: record.followerOrderId };
  }
}

async function copyDesk(venueFollows?: VenueFollowsPort) {
  const now = () => NOW;
  const store = new MemoryCopyFollowStore();
  const directory = memoryLeaderDirectory({ now, feeShareLaw: fee, countActive: (id) => store.countActiveFollowsByLeader(id) });
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({ userId: FOLLOWER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'order-fund' }),
  );
  const time = (fillId: string) => new Date(NOW.getTime() + (leaderFills.findIndex((f) => f.fillId === fillId) + 1) * 1000);
  const copy = new CopyService(ledger, {
    accountAdmission: readyTestAdmission(),
    feeShareLaw: fee,
    jurisdictionLaw: jur,
    minTier: 'full',
    minInvestment: { published: true, amount: parseAmount('10') },
    store,
    directory,
    now,
    metricDefinitions: parseCopyMetricDefinitionsJson(
      JSON.stringify({ published: true, version: 'TEST-1', definitions: { publishedReturn: 'Return over the window.' } }),
    ),
    placeMirrorEnabled: true,
    inspectMarket: async () => ({ paper: false, lotSize: parseAmount('0.00001') }),
    placeFollowerOrder: async (_, input) => ({ orderId: `order-${input.clientOrderId.slice(-6)}` }),
    lookupLeaderFill: async (fillId) => leaderFills.find((f) => f.fillId === fillId) ?? null,
    listLeaderFillsSince: async (leaderId, after, limit) =>
      leaderFills
        .filter((f) => f.userId === leaderId)
        .map((f) => ({ fillId: f.fillId, marketId: f.marketId, at: time(f.fillId) }))
        .filter((f) => f.at.getTime() > after.at.getTime() || (f.at.getTime() === after.at.getTime() && f.fillId > (after.fillId ?? '')))
        .slice(0, limit),
    copiedPositions: async () => positions,
    copyClose: new FakeClosePort(),
    leadFeeShares: async () => [
      {
        fillId: 'fill-2',
        followId: 'follow-1',
        assetId: 'USDT',
        feeOnFill: parseAmount('0.2'),
        appliedShareBps: 1337,
        amount: parseAmount('0.02674'),
        at: NOW,
        venueFillId: 'venue-fill-2',
        ledgerKey: 'copy.share:fill-2',
      },
      {
        fillId: 'fill-1',
        followId: 'follow-1',
        assetId: 'BTC',
        feeOnFill: parseAmount('0.00001'),
        appliedShareBps: 1337,
        amount: parseAmount('0.000001337'),
        at: NOW,
        venueFillId: null,
        ledgerKey: 'copy.share:fill-1',
      },
    ],
    ...(venueFollows ? { venueFollows } : {}),
  });
  const listed = await copy.upsertListing(principalFor(OPERATOR, ['admin:write']), {
    clientRequestId: 'list:order-leader',
    leaderUserId: LEADER,
    displayName: 'Order Leader',
    recordKind: 'self_reported',
    state: 'listed',
    tenureStart: '2026-01-01T00:00:00.000Z',
    assets: ['BTC', 'ETH'],
    capacity: 50,
    strategyVersion: 'v1',
    publishedReturn: '12.5',
    windowStart: '2026-01-01T00:00:00.000Z',
    netOfCosts: true,
  });
  return { copy, store, directory, leaderRef: listed.leaderRef };
}

const followInput = (clientRequestId: string) => ({
  leaderId: LEADER,
  region: 'SG',
  permittedMarkets: ['BTC/USDT'],
  maxNotionalPerOrder: '100',
  maxAggregateExposure: '500',
  fixedOrderSize: '20',
  expiresAt: '2026-12-01T00:00:00.000Z',
  clientRequestId,
});

describe('copy follow answer schemas keep each answer byte for byte (weed project-state#3594)', () => {
  it('a follow, before and after its session key, amended, killed and listed', async () => {
    const { copy } = await copyDesk();
    const made = await copy.startFollow(follower, followInput('order-follow-0001'));
    keepsOrder(copyFollowAnswer, made);
    keepsOrder(copyFollowAnswer, await copy.amendFollow(follower, { followId: made.followId, maxPerMarket: '50' }));
    const granted = await copy.grantSessionKey(follower, { followId: made.followId });
    // A granted follow carries its key fields last: the presenter spreads them after every other key.
    expect(Object.keys(granted).slice(-3)).toEqual(['sessionKeyPrefix', 'sessionKeyId', 'sessionKey']);
    keepsOrder(copyGrantSessionKeyAnswer, granted);
    keepsOrder(copyListMyFollowsAnswer, await copy.listMyFollows(follower, 50));
    keepsOrder(copyFollowAnswer, await copy.killSessionKey(follower, { followId: made.followId }));
    keepsOrder(copyListMyFollowsAnswer, await copy.listMyFollows(follower, 50));
  });

  it('the venue follow check, unwritten and written', async () => {
    const port: VenueFollowsPort = { bind: async () => undefined, copiedOrders: async () => null };
    const { copy } = await copyDesk(port);
    const venue = { ...followInput('order-venue-0001'), permittedMarkets: ['BTC-USDC'] };
    const unwritten = await copy.checkVenueFollow(follower, venue);
    expect(unwritten.follow).toBeNull();
    keepsOrder(copyCheckVenueFollowAnswer, unwritten);
    await copy.startVenueFollow(follower, { ...venue, agentAccountId: '00000000-0000-4000-8000-0000000000a1' });
    const written = await copy.checkVenueFollow(follower, venue);
    expect(written.follow).not.toBeNull();
    keepsOrder(copyCheckVenueFollowAnswer, written);
  });

  it('the leader directory, a leader page and its trades', async () => {
    const { copy, leaderRef } = await copyDesk();
    const page = await copy.listLeaders(follower, { limit: 10 } as Parameters<CopyService['listLeaders']>[1]);
    expect(page.leaders).toHaveLength(1);
    keepsOrder(copyListLeadersAnswer, page);
    keepsOrder(copyLeaderProfileAnswer, await copy.leaderProfile(follower, { leaderRef }));
    // leaderTrades reads its orders from the spot tables; the pairing and the page are the real ones.
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 0, minute));
    const order = (side: 'buy' | 'sell', qty: string, quote: string, minute: number, id: string): LeaderOrderFills => ({
      orderId: `00000000-0000-4000-8000-0000000000${id}`,
      symbol: 'BTC/USDT',
      side,
      qty: parseAmount(qty),
      quote: parseAmount(quote),
      firstAt: at(minute),
      lastAt: at(minute),
      takeProfit: side === 'buy' ? parseAmount('130') : null,
      stopLoss: null,
    });
    const trades = pairLeaderTrades([
      order('buy', '2', '200', 1, 'b1'),
      order('sell', '1', '110', 2, 's1'),
      order('sell', '3', '90', 3, 's2'),
    ]);
    expect(trades.map((t) => t.state)).toEqual(['closed', 'closed']);
    keepsOrder(copyLeaderTradesAnswer, pageLeaderTrades(trades, null, 1));
  });

  it('the copied positions, a close of one, and the skip log', async () => {
    const { copy } = await copyDesk();
    const { followId } = await copy.startFollow(follower, followInput('order-follow-0002'));
    await copy.grantSessionKey(follower, { followId });
    keepsOrder(copyCopiedPositionsAnswer, await copy.copiedPositions(follower, { followId }));
    keepsOrder(copyCloseCopiedPositionAnswer, await copy.closePosition(follower, { followId, positionId: 'buy-order-1' }));
    const again = await copy.closePosition(follower, { followId, positionId: 'buy-order-1' });
    expect(again.duplicate).toBe(true);
    keepsOrder(copyCloseCopiedPositionAnswer, again);
    await copy.stop(follower, { followId, closeOnly: true });
    await copy.runMirrorSweep();
    const skips = await copy.skipLog(follower, { followId });
    expect(skips.items.length).toBeGreaterThan(0);
    keepsOrder(copySkipLogAnswer, skips);
  });
});

/** A fake of the lead desk's reads: each query answers the canned rows its text names. */
function fakeSql(answer: (text: string) => unknown[]): Sql {
  const query = (strings: TemplateStringsArray) => {
    // `sql([...])` and a nested fragment are not queries of their own.
    if (!('raw' in strings)) return strings;
    const text = strings.join('?');
    return /^\s*SELECT\b/.test(text) ? Promise.resolve(answer(text)) : strings;
  };
  // A transaction runs its body on the same fake.
  const fake = Object.assign(query, { begin: async (fn: (tx: typeof query) => unknown) => fn(fake) });
  return fake as Sql;
}

const applicationRow = (status: string) => ({
  id: '00000000-0000-4000-8000-0000000000f1',
  user_id: LEADER,
  display_name: 'Order Leader',
  status,
  approval_id: null,
  proposed_by: null,
  decided_by: null,
  approver_id: null,
  reason: status === 'rejected' ? 'TEST reason' : null,
  leader_ref: status === 'approved' ? 'ldr_order' : null,
  created_at: NOW,
  decided_at: status === 'pending' ? null : NOW,
});

describe('copy lead answer schemas keep each answer byte for byte (weed project-state#3594)', () => {
  async function leadDesk(status: string, venue: LeadVenueRead) {
    const { store, directory, copy } = await copyDesk();
    await copy.startFollow(follower, followInput('order-follow-0003'));
    const sql = fakeSql((text) => {
      if (text.includes('copy_lead_applications')) return [applicationRow(status)];
      if (text.includes('pg_advisory_xact_lock')) return [];
      if (text.includes('AS ongoing')) return [{ ongoing: '1', history: '1' }];
      if (text.includes('FROM trade.copy_follows'))
        return [{ follow_id: '00000000-0000-4000-8000-0000000000f2', relationship_state: 'ACTIVE', created_at: NOW }];
      if (text.includes('trade.orders'))
        return [
          {
            id: 'lead-order-1',
            symbol: 'BTC/USDT',
            side: 'buy',
            price: '45000',
            qty: '0.001',
            filled: '0',
            status: 'open',
            created_at: NOW,
          },
        ];
      throw new Error(`unexpected query: ${text}`);
    });
    const deps: LeadDeskDeps = {
      sql,
      approvals: {} as LeadDeskDeps['approvals'],
      directory,
      now: () => NOW,
      reapplyWaitSeconds: 3600,
      minVenueUsdc: parseAmount('100'),
      missionMinUsdc: parseAmount('100'),
      following: (userId) => leadFollowing({ follows: store, directory }, userId),
      venueUsdc: async () => venue,
    };
    return { desk: new LeadDesk(deps), copy };
  }
  const read: LeadVenueRead = { state: 'read', owner: '0xabc', test: true, usdc: parseAmount('250'), asOf: NOW };

  it('the application, eligibility, lead account and missions', async () => {
    for (const [status, venue] of [
      ['pending', read],
      ['rejected', { state: 'none' }],
      ['approved', { state: 'off' }],
    ] as const) {
      const { desk } = await leadDesk(status, venue);
      keepsOrder(myLeadApplicationAnswer, await desk.mine(leader));
      keepsOrder(leadEligibilityAnswer, await desk.eligibility(follower));
      keepsOrder(myLeadAnswer, await desk.myLead(leader));
      keepsOrder(leadMissionsAnswer, await desk.missions(leader));
    }
    const { desk } = await leadDesk('pending', read);
    // The open application answered again: its row, unchanged.
    keepsOrder(applyToLeadAnswer, await desk.apply(leader, { displayName: 'Order Leader' }));
  });

  it("the lead's trades, copiers, earnings and level", async () => {
    const { desk, copy } = await leadDesk('approved', read);
    const trades = await desk.trading.trades(leader);
    expect(trades.ongoing).toHaveLength(1);
    keepsOrder(leadTradesAnswer, trades);
    keepsOrder(leadCopiersAnswer, await desk.trading.copiers(leader));
    const earnings = await copy.leadEarnings(leader, { limit: 10 });
    expect(earnings.totals).toHaveLength(2);
    keepsOrder(leadEarningsAnswer, earnings);
    keepsOrder(leadLevelAnswer, await copy.leadLevel(leader));
  });

  it('the platform pauses', async () => {
    const sql = fakeSql(() => [
      { scope_kind: 'lead', scope_value: 'ldr_order' },
      { scope_kind: 'symbol', scope_value: 'BTC/USDT' },
    ]);
    const desk = new PlatformPauseDesk(partial<PlatformPauseDeps>({ sql }));
    keepsOrder(platformPausesAnswer, await desk.publicPauses());
  });
});
