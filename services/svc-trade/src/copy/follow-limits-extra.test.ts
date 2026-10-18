/**
 * COPYLIMITS acceptance. Amounts are worked by hand:
 * follower limit 100.5 against leader price 100 is 50 bps
 * (0.5 / 100 × 10000). Peak 100 minus current 60 is 40.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { CopyService } from '../controls/test-admission.js';
import type { LookupLeaderFillPort } from './copy-service.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import { followResultFigure, type FollowResult } from './follow-result.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';

const FOLLOWER = '00000000-0000-4000-8000-0000000000a1';
const LEADER = '00000000-0000-4000-8000-0000000000a2';
const LEADER_B = '00000000-0000-4000-8000-0000000000a3';
const principal = { userId: FOLLOWER } as import('@intafaced/auth').Principal;
const futureExpiry = '2026-12-01T00:00:00.000Z';

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};

const publishedJur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

const here = dirname(fileURLToPath(import.meta.url));

function baseFollow(leaderId = LEADER) {
  return {
    leaderId,
    region: 'SG',
    permittedMarkets: ['BTC-USDT', 'ETH-USDT'] as const,
    maxNotionalPerOrder: '1000',
    maxAggregateExposure: '10000',
    expiresAt: futureExpiry,
  };
}

function fill(fillId: string, input: { qty: string; notional: string; price?: string; marketId?: string; userId?: string }) {
  return {
    fillId,
    userId: input.userId ?? LEADER,
    marketId: input.marketId ?? 'BTC-USDT',
    side: 'buy' as const,
    qty: parseAmount(input.qty),
    notional: parseAmount(input.notional),
    ...(input.price !== undefined ? { price: parseAmount(input.price) } : {}),
  };
}

function lookup(rows: ReturnType<typeof fill>[]): LookupLeaderFillPort {
  return async (fillId) => rows.find((row) => row.fillId === fillId) ?? null;
}

function service(options: {
  rows?: ReturnType<typeof fill>[];
  store?: MemoryCopyFollowStore;
  place?: (orderId: string) => { orderId: string };
  figure?: () => { figure: Amount | null; missing: string | null };
  places?: { n: number };
}) {
  const places = options.places ?? { n: 0 };
  return new CopyService(new MemoryLedger(), {
    feeShareLaw: publishedFee,
    jurisdictionLaw: publishedJur,
    store: options.store,
    placeMirrorEnabled: true,
    inspectMarket: async () => ({ paper: false }),
    lookupLeaderFill: lookup(options.rows ?? []),
    placeFollowerOrder: async () => {
      places.n += 1;
      return options.place ? options.place(`ord-${places.n}`) : { orderId: `ord-${places.n}` };
    },
    ...(options.figure ? { readResultFigure: async () => options.figure!() } : {}),
  });
}

describe('slippage cap', () => {
  const rows = [fill('fill-50', { qty: '1', notional: '100.5', price: '100' })];

  it('passes 50 bps under a 60 bps cap and places, and refuses 40 bps with nothing placed', async () => {
    const places = { n: 0 };
    const wide = service({ rows, places });
    const followed = await wide.follow(principal, { ...baseFollow(), maxSlippageBps: 60 });
    expect(followed.maxSlippageBps).toBe(60);
    const plan = await wide.planMirrorForFollow(principal, {
      followId: followed.followId,
      fillId: 'fill-50',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '1',
      notional: '100.5',
    });
    expect(plan.reason).toBe('within_envelope');
    await wide.grantSessionKey(principal, { followId: followed.followId });
    const placed = await wide.placeMirrorForFollow(principal, {
      followId: followed.followId,
      fillId: 'fill-50',
      leaderPaper: false,
    });
    expect(placed.orderId).toBe('ord-1');
    expect(places.n).toBe(1);

    const tightPlaces = { n: 0 };
    const tight = service({ rows, places: tightPlaces });
    const tightFollow = await tight.follow(principal, { ...baseFollow(), maxSlippageBps: 40 });
    await expect(
      tight.planMirrorForFollow(principal, {
        followId: tightFollow.followId,
        fillId: 'fill-50',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '1',
        notional: '100.5',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_slippage_exceeded' });
    await tight.grantSessionKey(principal, { followId: tightFollow.followId });
    await expect(
      tight.placeMirrorForFollow(principal, {
        followId: tightFollow.followId,
        fillId: 'fill-50',
        leaderPaper: false,
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_auto_mirror_place_socket' });
    expect(tightPlaces.n).toBe(0);
  });

  it('place refuses 50 bps against a 40 bps cap when a plan already exists, and does not place', async () => {
    const store = new MemoryCopyFollowStore();
    const places = { n: 0 };
    const copy = service({ rows, store, places });
    const followed = await copy.follow(principal, { ...baseFollow(), maxSlippageBps: 40 });
    await store.claimMirrorFill({
      followId: followed.followId,
      fillId: 'fill-50',
      maxAggregate: parseAmount('10000'),
      plan: {
        fillId: 'fill-50',
        followId: followed.followId,
        followerId: FOLLOWER,
        leaderId: LEADER,
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: parseAmount('1'),
        notional: parseAmount('100.5'),
      },
    });
    await copy.grantSessionKey(principal, { followId: followed.followId });
    await expect(
      copy.placeMirrorForFollow(principal, { followId: followed.followId, fillId: 'fill-50', leaderPaper: false }),
    ).rejects.toMatchObject({ code: 'trade.copy_slippage_exceeded' });
    expect(places.n).toBe(0);
  });

  it('binds a leader cap of 30 over a follower 60, and refuses a leader cap with no follower cap', async () => {
    const copy = service({});
    const followed = await copy.follow(principal, {
      ...baseFollow(),
      maxSlippageBps: 60,
      leaderSettings: { maxSlippageBps: 30 },
    });
    expect(followed.maxSlippageBps).toBe(30);
    await expect(
      copy.follow(principal, {
        ...baseFollow(LEADER_B),
        leaderSettings: { maxSlippageBps: 30 },
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_limit_missing' });
    const mine = await copy.listMyFollows(principal, 10);
    expect(mine.map((row) => row.leaderId).sort()).toEqual([LEADER]);
  });

  it('refuses when the leader price is missing or zero', async () => {
    const missing = service({ rows: [fill('fill-none', { qty: '1', notional: '100' })] });
    const followed = await missing.follow(principal, { ...baseFollow(), maxSlippageBps: 60 });
    await expect(
      missing.planMirrorForFollow(principal, {
        followId: followed.followId,
        fillId: 'fill-none',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '1',
        notional: '100',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_limit_unevaluable' });

    const zero = service({ rows: [fill('fill-zero', { qty: '1', notional: '1', price: '0' })] });
    const zeroFollow = await zero.follow(principal, { ...baseFollow(), maxSlippageBps: 60 });
    await expect(
      zero.planMirrorForFollow(principal, {
        followId: zeroFollow.followId,
        fillId: 'fill-zero',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '1',
        notional: '1',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_limit_unevaluable' });
  });
});

describe('concurrency cap', () => {
  function rowsFor(ids: string[]) {
    return ids.map((fillId) => fill(fillId, { qty: '0.01', notional: '10', price: '1000' }));
  }

  async function placed(copy: CopyService, followId: string, fillId: string) {
    await copy.planMirrorForFollow(principal, {
      followId,
      fillId,
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '10',
    });
    await copy.grantSessionKey(principal, { followId });
    return copy.placeMirrorForFollow(principal, { followId, fillId, leaderPaper: false });
  }

  it('refuses the third open mirror, allows the next after one fills, and ignores another follow', async () => {
    const store = new MemoryCopyFollowStore();
    const places = { n: 0 };
    const copy = service({
      store,
      places,
      rows: [
        ...rowsFor(['c1', 'c2', 'c3', 'c4']),
        fill('other-1', { qty: '0.01', notional: '10', price: '1000', userId: LEADER_B }),
        fill('other-2', { qty: '0.01', notional: '10', price: '1000', userId: LEADER_B }),
      ],
    });
    const followed = await copy.follow(principal, { ...baseFollow(), maxConcurrent: 2 });
    const other = await copy.follow(principal, { ...baseFollow(LEADER_B), maxConcurrent: 2 });
    const first = await placed(copy, followed.followId, 'c1');
    const second = await placed(copy, followed.followId, 'c2');
    store.noteMirrorOrderState(first.orderId, 'open');
    store.noteMirrorOrderState(second.orderId, 'open');
    await placed(copy, other.followId, 'other-1');
    await placed(copy, other.followId, 'other-2');
    const before = places.n;
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: followed.followId,
        fillId: 'c3',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_concurrency_exceeded' });
    expect(places.n).toBe(before);

    store.noteMirrorOrderState(first.orderId, 'filled');
    const third = await placed(copy, followed.followId, 'c3');
    expect(third.orderId).toBeTruthy();
    expect(places.n).toBe(before + 1);
  });

  it('places exactly one of two concurrent fills of one follow when the cap is 1', async () => {
    const store = new MemoryCopyFollowStore();
    const places = { n: 0 };
    const copy = service({ store, places, rows: rowsFor(['p1', 'p2']) });
    const followed = await copy.follow(principal, { ...baseFollow(), maxConcurrent: 1 });
    for (const fillId of ['p1', 'p2']) {
      await copy.planMirrorForFollow(principal, {
        followId: followed.followId,
        fillId,
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      });
    }
    await copy.grantSessionKey(principal, { followId: followed.followId });
    const results = await Promise.allSettled(
      ['p1', 'p2'].map((fillId) => copy.placeMirrorForFollow(principal, { followId: followed.followId, fillId, leaderPaper: false })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(places.n).toBe(1);
  });

  it('counts an unreadable order state as open and refuses', async () => {
    const store = new MemoryCopyFollowStore();
    const copy = service({ store, rows: rowsFor(['u1', 'u2']) });
    const followed = await copy.follow(principal, { ...baseFollow(), maxConcurrent: 1 });
    const first = await placed(copy, followed.followId, 'u1');
    store.noteMirrorOrderState(first.orderId, null);
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: followed.followId,
        fillId: 'u2',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_concurrency_exceeded' });
  });
});

describe('drawdown stop', () => {
  it('refuses peak 100 current 60 against cap 30, passes cap 50, and refuses a null figure', async () => {
    const store = new MemoryCopyFollowStore();
    let figure: Amount | null = parseAmount('100');
    const copy = service({
      store,
      rows: [
        fill('d1', { qty: '0.01', notional: '10', price: '1000' }),
        fill('d2', { qty: '0.01', notional: '10', price: '1000' }),
        fill('d3', { qty: '0.01', notional: '10', price: '1000', userId: LEADER_B }),
        fill('d4', { qty: '0.01', notional: '10', price: '1000', userId: LEADER_B }),
        fill('d5', { qty: '0.01', notional: '10', price: '1000', userId: '00000000-0000-4000-8000-0000000000a4' }),
      ],
      figure: () => ({ figure, missing: figure === null ? 'trade.mark_unavailable' : null }),
    });
    const tight = await copy.follow(principal, { ...baseFollow(), maxDrawdown: '30' });
    await copy.planMirrorForFollow(principal, {
      followId: tight.followId,
      fillId: 'd1',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '10',
    });
    expect((await copy.listMyFollows(principal, 10)).find((row) => row.followId === tight.followId)?.peakResult).toBe('100');
    figure = parseAmount('60');
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: tight.followId,
        fillId: 'd2',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_drawdown_stop' });
    expect((await copy.listMyFollows(principal, 10)).find((row) => row.followId === tight.followId)?.peakResult).toBe('100');

    const wide = await copy.follow(principal, {
      ...baseFollow(LEADER_B),
      maxDrawdown: '50',
    });
    figure = parseAmount('100');
    await copy.planMirrorForFollow(principal, {
      followId: wide.followId,
      fillId: 'd3',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '10',
    });
    figure = parseAmount('60');
    const passed = await copy.planMirrorForFollow(principal, {
      followId: wide.followId,
      fillId: 'd4',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '10',
    });
    expect(passed.reason).toBe('within_envelope');

    figure = null;
    const blank = await copy.follow(principal, {
      ...baseFollow('00000000-0000-4000-8000-0000000000a4'),
      permittedMarkets: ['BTC-USDT'],
      maxDrawdown: '30',
    });
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: blank.followId,
        fillId: 'd5',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      }),
    ).rejects.toThrow(/trade\.mark_unavailable/);
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: blank.followId,
        fillId: 'd5',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_limit_unevaluable' });
  });

  it('keeps 18 decimal places on the peak', async () => {
    const exact = '1.123456789012345678';
    const store = new MemoryCopyFollowStore();
    const copy = service({
      store,
      rows: [fill('exact', { qty: '0.01', notional: '10', price: '1000' })],
      figure: () => ({ figure: parseAmount(exact), missing: null }),
    });
    const followed = await copy.follow(principal, { ...baseFollow(), maxDrawdown: '0.000000000000000001' });
    await copy.planMirrorForFollow(principal, {
      followId: followed.followId,
      fillId: 'exact',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '10',
    });
    const shown = (await copy.listMyFollows(principal, 10)).find((row) => row.followId === followed.followId);
    expect(shown?.peakResult).toBe(formatAmount(parseAmount(exact)));
    expect(shown?.peakResult).toBe(exact);
  });
});

describe('leverage is a typed door only', () => {
  it('refuses maxLeverage and creates no follow', async () => {
    const copy = service({});
    await expect(copy.follow(principal, { ...baseFollow(), maxLeverage: '2' })).rejects.toMatchObject({
      code: 'trade.copy_leverage_unsupported',
    });
    expect(await copy.listMyFollows(principal, 10)).toEqual([]);
    const src = readFileSync(join(here, 'auto-mirror-place.ts'), 'utf8');
    expect(src).not.toMatch(/leverage/);
    expect(src).toMatch(/limit/);
  });
});

describe('instrument list per leader', () => {
  it('keeps each leader’s list, lets a leader narrow, and refuses a market outside the list', async () => {
    const copy = service({
      rows: [
        fill('in-btc', { qty: '0.01', notional: '10', price: '1000', marketId: 'BTC-USDT' }),
        fill('in-eth', { qty: '0.01', notional: '10', price: '1000', marketId: 'ETH-USDT' }),
        fill('in-sol', { qty: '0.01', notional: '10', price: '1000', marketId: 'SOL-USDT', userId: LEADER_B }),
      ],
    });
    const btc = await copy.follow(principal, {
      ...baseFollow(),
      permittedMarkets: ['BTC-USDT'],
    });
    const eth = await copy.follow(principal, {
      ...baseFollow(LEADER_B),
      permittedMarkets: ['ETH-USDT', 'SOL-USDT'],
      leaderSettings: { permittedInstruments: ['ETH-USDT'] },
    });
    expect(btc.permittedMarkets).toEqual(['BTC-USDT']);
    expect(eth.permittedMarkets).toEqual(['ETH-USDT']);
    expect(eth.permittedMarkets).not.toContain('SOL-USDT');
    await expect(
      copy.planMirrorForFollow(principal, {
        followId: btc.followId,
        fillId: 'in-eth',
        marketId: 'ETH-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_market_not_permitted' });
  });
});

describe('presented follow keys', () => {
  it('returns the follower’s own limits and no extra leader fields', async () => {
    const copy = service({});
    const followed = await copy.follow(principal, {
      ...baseFollow(),
      maxSlippageBps: 60,
      maxConcurrent: 2,
      maxDrawdown: '30',
    });
    const allowed = new Set([
      'followId',
      'followerId',
      'leaderId',
      'leaderRef',
      'leaderStatus',
      'permittedMarkets',
      'maxNotionalPerOrder',
      'maxAggregateExposure',
      'maxLoss',
      'maxSlippageBps',
      'maxConcurrent',
      'maxDrawdown',
      'peakResult',
      'currentExposure',
      'remainingExposure',
      'expiresAt',
      'region',
      'createdAt',
      'feeShareKilled',
      'sessionKeyGranted',
      'sessionKeyRevoked',
      'sessionKeyPrefix',
      'sessionKeyId',
      'sessionKey',
      'relationshipState',
      'newIntentFenced',
    ]);
    for (const key of Object.keys(followed)) expect(allowed.has(key), key).toBe(true);
    expect(followed.maxDrawdown).toBe('30');
    expect(followed.maxConcurrent).toBe(2);
    expect(JSON.stringify(followed)).not.toContain('00000000-0000-4000-8000-0000000000ff');
  });
});

describe('follow result figure', () => {
  function result(patch: Partial<FollowResult>): FollowResult {
    return {
      followId: 'f',
      mirroredOrders: 0,
      fills: 0,
      rejects: 0,
      tradingFee: null,
      tradingFeeReason: 'per_quote_asset',
      leaderShare: null,
      leaderShareReason: 'per_quote_asset',
      realisedPnl: null,
      realisedPnlReason: 'per_quote_asset',
      unrealisedPnl: null,
      unrealisedPnlReason: 'per_quote_asset',
      assets: [],
      ...patch,
    };
  }

  it('is zero with no position, sums one asset, and names a missing mark', () => {
    expect(followResultFigure(result({})).figure).toBe('0');
    expect(
      followResultFigure(
        result({
          assets: [
            {
              quoteAsset: 'USDT',
              tradingFee: '0',
              tradingFeeReason: null,
              leaderShare: null,
              leaderShareReason: 'leader_share_unset',
              leaderShareSkippedReasons: [],
              mirroredOrders: 1,
              fills: 1,
              realisedPnl: '40',
              realisedPnlReason: null,
              unrealisedPnl: '20',
              unrealisedPnlReason: null,
            },
          ],
        }),
      ).figure,
    ).toBe('60');
    const missing = followResultFigure(
      result({
        assets: [
          {
            quoteAsset: 'USDT',
            tradingFee: '0',
            tradingFeeReason: null,
            leaderShare: null,
            leaderShareReason: 'leader_share_unset',
            leaderShareSkippedReasons: [],
            mirroredOrders: 1,
            fills: 1,
            realisedPnl: '40',
            realisedPnlReason: null,
            unrealisedPnl: null,
            unrealisedPnlReason: 'trade.mark_unavailable',
          },
        ],
      }),
    );
    expect(missing.figure).toBeNull();
    expect(missing.missing).toBe('trade.mark_unavailable');
  });
});
