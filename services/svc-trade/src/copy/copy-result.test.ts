/**
 * COPYRESULT acceptance. Amounts below are worked by hand, not copied from
 * the implementation: 0.1+0.2+0.3 = 0.6, 0.01+0.02+0.03 = 0.06,
 * average (100+110)/2 = 105, realised (120−105)×1 − 0.3 = 14.7,
 * unrealised (55−50)×2 = 10.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import { copyMirrorClientOrderId } from './auto-mirror-place.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { attachCopyExportRoute } from './copy-export-rest.js';
import { CopyService } from '../controls/test-admission.js';
import { SqlCopyFollowStore } from './follow-store.js';
import { FEE_LOOKUP_UNWIRED, readFollowResult } from './follow-result.js';
import { SqlMirrorEventLog, wholeBasisPoints } from './mirror-events.js';
import { COPY_TRAIL_WINDOW_MAX_MS } from './mirror-trail.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

const FOLLOWER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const LEADER = '22222222-2222-4222-8222-222222222222';
const LEADER_B = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const MARKET_BTC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const MARKET_ETH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const COUNTER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-02-01T00:00:00.000Z');
const FROM = '2026-01-01T00:00:00.000Z';
const TO = new Date(Date.parse(FROM) + COPY_TRAIL_WINDOW_MAX_MS).toISOString();
const SECRET = 'copy-result-edge-secret-32-chars!!';

const O1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const O2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const O3 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const O4 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4';
const F1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const F2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const F3 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const F4 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function principal(userId = FOLLOWER, scopes: string[] = ['trade:read', 'trade:write']): Principal {
  return {
    sub: userId,
    userId,
    sid: SESSION,
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(userId = FOLLOWER) {
  const raw = encodePrincipal(principal(userId));
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: `req-copy-result-${userId}`,
  });
}

describe('mirror divergence basis points (no database)', () => {
  it('rounds half away from zero to a whole number of basis points', () => {
    expect(wholeBasisPoints(parseAmount('0.5'), parseAmount('100'))).toBe(50n);
    expect(wholeBasisPoints(parseAmount('-0.5'), parseAmount('100'))).toBe(-50n);
    expect(wholeBasisPoints(parseAmount('0.005'), parseAmount('100'))).toBe(1n);
    expect(wholeBasisPoints(parseAmount('0.004'), parseAmount('100'))).toBe(0n);
  });
});

describe('copy follow result, trail and export', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    const envUrl = process.env.TEST_DATABASE_URL?.trim();
    if (envUrl) {
      db = await createTestDatabase({ service: 'trade', url: envUrl, migrations });
      return;
    }
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_copy_result')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    adminStop = async () => {
      await container.stop();
    };
    db = await createTestDatabase({ service: 'trade', url: container.getConnectionUri(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    // order_events refuses TRUNCATE. The harness reset skips that table.
    await truncateTradeExceptOrderEvents(db!.sql);
  });

  async function seedMarkets(): Promise<void> {
    await db!.sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name
      ) VALUES
        (${MARKET_BTC}, 'BTC-USDT', 'BTC', 'USDT', 'spot', 0.01, 0.0001, 0.0001, 1, 10, 20, 'pending', 'BTC-USDT'),
        (${MARKET_ETH}, 'ETH-USDC', 'ETH', 'USDC', 'spot', 0.01, 0.0001, 0.0001, 1, 10, 20, 'pending', 'ETH-USDC')
    `;
  }

  async function seedFill(input: {
    marketId: string;
    orderId: string;
    fillId: string;
    side: 'buy' | 'sell';
    price: string;
    qty: string;
    quote: string;
    feeAsset: string;
    fee: string;
    sequence: number;
    ts: string;
  }): Promise<void> {
    await db!.sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif,
        hold_asset, hold_amount
      ) VALUES (
        ${input.orderId}, ${FOLLOWER}, ${input.marketId}, ${input.orderId}, ${input.side}, 'limit',
        ${input.price}, ${input.qty}, ${input.qty}, 'filled', 'GTC', ${input.feeAsset}, ${input.quote}
      )
    `;
    await db!.sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence, ts
      ) VALUES (
        ${input.fillId}, ${input.orderId}, ${COUNTER}, ${input.marketId}, ${FOLLOWER}, ${input.side}, 'taker',
        ${input.price}, ${input.qty}, ${input.quote}, ${input.feeAsset}, ${input.fee}, 10, ${input.sequence}, ${input.ts}
      )
    `;
  }

  it('records the trail, the result and the export for the caller only', async () => {
    await seedMarkets();
    const events = new SqlMirrorEventLog(db!.sql);
    const fees = new Map([
      [F1, { asset: 'USDT', amount: '0.1' }],
      [F2, { asset: 'USDT', amount: '0.2' }],
      [F3, { asset: 'USDT', amount: '0.3' }],
      [F4, { asset: 'USDC', amount: '1.25' }],
    ]);
    const leaders = new Map([
      ['lf-buy-1', { marketId: 'BTC-USDT', side: 'buy' as const, qty: '1', notional: '100' }],
      ['lf-buy-2', { marketId: 'BTC-USDT', side: 'buy' as const, qty: '1', notional: '110' }],
      ['lf-sell', { marketId: 'BTC-USDT', side: 'sell' as const, qty: '1', notional: '120' }],
      ['lf-eth', { marketId: 'ETH-USDC', side: 'buy' as const, qty: '2', notional: '100' }],
      ['=1+1', { marketId: 'BTC-USDT', side: 'buy' as const, qty: '0.01', notional: '1' }],
      ['lf-other', { marketId: 'BTC-USDT', side: 'buy' as const, qty: '1', notional: '10' }],
      ['lf-pause', { marketId: 'BTC-USDT', side: 'buy' as const, qty: '1', notional: '10' }],
    ]);
    const orderByFill = new Map([
      ['lf-buy-1', O1],
      ['lf-buy-2', O2],
      ['lf-sell', O3],
      ['lf-eth', O4],
    ]);
    let followId = '';
    const copy = new CopyService(new MemoryLedger(), {
      feeShareLaw: { published: true, leaderShareBps: 5_000, earningsCapPerFollower: '100', decayRoundTrips: 100, decayShareBps: 1_000 },
      jurisdictionLaw: { published: true, allowedRegions: ['SG'] },
      placeMirrorEnabled: true,
      inspectMarket: async () => ({ paper: false }),
      store: new SqlCopyFollowStore(db!.sql),
      sql: db!.sql,
      // Every leader fill is planned before any copy fills here, so the sell is given the copied BTC it closes.
      copiedPositions: async () => [
        {
          orderId: O1,
          leaderFillId: 'lf-buy-1',
          symbol: 'BTC-USDT',
          marketId: MARKET_BTC,
          baseAsset: 'BTC',
          lotSize: parseAmount('0.00001'),
          bought: parseAmount('2'),
          open: parseAmount('2'),
          closing: 0n,
          status: 'open' as const,
          placedAt: NOW,
        },
      ],
      mirrorEvents: events,
      now: () => NOW,
      lookupMark: async (marketId) => {
        if (marketId === 'BTC-USDT') {
          return { marketId, price: parseAmount('130'), asOf: new Date(NOW.getTime() - 301_000), quality: 'mid' as const };
        }
        if (marketId === 'ETH-USDC') {
          return { marketId, price: parseAmount('55'), asOf: NOW, quality: 'mid' as const };
        }
        return null;
      },
      lookupFollowerFillFee: async (fillId) => {
        const fee = fees.get(fillId);
        return fee ? { fillId, userId: FOLLOWER, feeAsset: fee.asset, feeAmount: parseAmount(fee.amount), createdAt: NOW } : null;
      },
      lookupLeaderFill: async (fillId) => {
        const row = leaders.get(fillId);
        if (!row) return null;
        return {
          fillId,
          userId: fillId === 'lf-pause' ? LEADER_B : LEADER,
          marketId: row.marketId,
          side: row.side,
          qty: parseAmount(row.qty),
          notional: parseAmount(row.notional),
        };
      },
      placeFollowerOrder: async (_principal, input) => {
        for (const [fill, orderId] of orderByFill) {
          if (input.clientOrderId === copyMirrorClientOrderId(followId, fill)) return { orderId };
        }
        throw new Error(`unexpected mirror place ${input.clientOrderId}`);
      },
    });

    const followed = await copy.follow(principal(), {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT', 'ETH-USDC'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    followId = followed.followId;
    await copy.grantSessionKey(principal(), { followId });

    const planInput = (fillId: string) => ({
      followId,
      fillId,
      marketId: 'ignored',
      side: 'buy' as const,
      qty: '1',
      notional: '1',
    });
    for (const fillId of ['lf-buy-1', 'lf-buy-2', 'lf-sell', 'lf-eth', '=1+1']) {
      await copy.planMirrorForFollow(principal(), planInput(fillId));
    }
    const beforeReplay = await db!.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM copy_mirror_events WHERE follow_id = ${followId} AND leader_fill_id = 'lf-buy-1'
    `;
    await copy.planMirrorForFollow(principal(), planInput('lf-buy-1'));
    const afterReplay = await db!.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM copy_mirror_events WHERE follow_id = ${followId} AND leader_fill_id = 'lf-buy-1'
    `;
    expect(Number(afterReplay[0]!.n)).toBe(Number(beforeReplay[0]!.n));

    for (const fillId of ['lf-buy-1', 'lf-buy-2', 'lf-sell', 'lf-eth']) {
      await copy.placeMirrorForFollow(principal(), { followId, fillId, leaderPaper: false });
    }
    await seedFill({
      marketId: MARKET_BTC,
      orderId: O1,
      fillId: F1,
      side: 'buy',
      price: '100',
      qty: '1',
      quote: '100',
      feeAsset: 'USDT',
      fee: '0.1',
      sequence: 1,
      ts: '2026-02-01T00:00:01.000Z',
    });
    await seedFill({
      marketId: MARKET_BTC,
      orderId: O2,
      fillId: F2,
      side: 'buy',
      price: '110',
      qty: '1',
      quote: '110',
      feeAsset: 'USDT',
      fee: '0.2',
      sequence: 2,
      ts: '2026-02-01T00:00:02.000Z',
    });
    await seedFill({
      marketId: MARKET_BTC,
      orderId: O3,
      fillId: F3,
      side: 'sell',
      price: '120',
      qty: '1',
      quote: '120',
      feeAsset: 'USDT',
      fee: '0.3',
      sequence: 3,
      ts: '2026-02-01T00:00:03.000Z',
    });
    await seedFill({
      marketId: MARKET_ETH,
      orderId: O4,
      fillId: F4,
      side: 'buy',
      price: '50',
      qty: '2',
      quote: '100',
      feeAsset: 'USDC',
      fee: '1.25',
      sequence: 1,
      ts: '2026-02-01T00:00:04.000Z',
    });
    for (const [orderId, spotFill, side, price, qty] of [
      [O1, F1, 'buy', '100', '1'],
      [O2, F2, 'buy', '110', '1'],
      [O3, F3, 'sell', '120', '1'],
      [O4, F4, 'buy', '50', '2'],
    ] as const) {
      await copy.observeFollowerFill({
        orderId,
        fillId: spotFill,
        side,
        price: parseAmount(price),
        qty: parseAmount(qty),
      });
    }

    await db!.sql`
      INSERT INTO copy_settled_fee_shares (
        follow_id, fill_id, leader_id, follower_id, asset_id, protocol_fee, applied_share_bps,
        gross_leader_share, capped_leader_share, skipped_reason, settled
      ) VALUES
        (${followId}, 'lf-buy-1', ${LEADER}, ${FOLLOWER}, 'USDT', 0.1, 1000, 0.01, 0.01, NULL, true),
        (${followId}, 'lf-buy-2', ${LEADER}, ${FOLLOWER}, 'USDT', 0.2, 1000, 0.02, 0.02, NULL, true),
        (${followId}, 'lf-sell', ${LEADER}, ${FOLLOWER}, 'USDT', 0.3, 1000, 0.03, 0.03, NULL, true),
        (${followId}, 'lf-eth', ${LEADER}, ${FOLLOWER}, 'USDC', 1.25, 0, 0, 0, 'cap_reached', true)
    `;

    const kinds = await db!.sql<Array<{ kind: string }>>`
      SELECT kind FROM copy_mirror_events
       WHERE follow_id = ${followId} AND leader_fill_id = 'lf-buy-1'
       ORDER BY seq ASC
    `;
    expect(kinds.map((row) => row.kind)).toEqual(['intent', 'planned', 'placed', 'divergence', 'filled']);
    const divergence = await db!.sql<Array<{ price: string; basis_points: string; code: string | null }>>`
      SELECT price::text AS price, basis_points::text AS basis_points, code
        FROM copy_mirror_events
       WHERE follow_id = ${followId} AND leader_fill_id = 'lf-buy-1' AND kind = 'divergence'
    `;
    expect(divergence[0]?.code).toBeNull();

    const pausedFollow = await copy.follow(principal(), {
      leaderId: LEADER_B,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    await copy.planMirrorForFollow(principal(), { ...planInput('lf-pause'), followId: pausedFollow.followId });
    await copy.pause(principal(), { followId: pausedFollow.followId });
    await expect(
      copy.placeMirrorForFollow(principal(), { followId: pausedFollow.followId, fillId: 'lf-pause', leaderPaper: false }),
    ).rejects.toMatchObject({ code: 'trade.copy_paused' });
    const refused = await db!.sql<Array<{ kind: string; code: string | null }>>`
      SELECT kind, code FROM copy_mirror_events
       WHERE follow_id = ${pausedFollow.followId} AND leader_fill_id = 'lf-pause' AND kind = 'rejected'
    `;
    expect(refused).toEqual([{ kind: 'rejected', code: 'trade.copy_paused' }]);
    const refusedText = JSON.stringify(refused);
    expect(refusedText).not.toContain('fenced');

    await expect(db!.sql`UPDATE copy_mirror_events SET code = 'x'`).rejects.toThrow(/append-only/);
    await expect(db!.sql`DELETE FROM copy_mirror_events`).rejects.toThrow(/append-only/);

    const other = await copy.follow(principal(OTHER), {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    await copy.planMirrorForFollow(principal(OTHER), { ...planInput('lf-other'), followId: other.followId });

    const result = await copy.result(principal(), followId);
    expect(Object.keys(result).sort()).toEqual(
      [
        'assets',
        'fills',
        'followId',
        'leaderShare',
        'leaderShareReason',
        'mirroredOrders',
        'realisedPnl',
        'realisedPnlReason',
        'rejects',
        'tradingFee',
        'tradingFeeReason',
        'unrealisedPnl',
        'unrealisedPnlReason',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain(LEADER);
    expect(result.mirroredOrders).toBe(4);
    expect(result.fills).toBe(4);
    expect(result.rejects).toBe(0);
    expect(result.tradingFee).toBeNull();
    const usdt = result.assets.find((asset) => asset.quoteAsset === 'USDT');
    const usdc = result.assets.find((asset) => asset.quoteAsset === 'USDC');
    expect(usdt).toMatchObject({
      tradingFee: '0.6',
      tradingFeeReason: null,
      leaderShare: '0.06',
      leaderShareReason: null,
      realisedPnl: '14.7',
      realisedPnlReason: null,
      unrealisedPnl: null,
      unrealisedPnlReason: 'trade.mark_unavailable',
    });
    expect(usdc).toMatchObject({
      tradingFee: '1.25',
      leaderShare: '0',
      leaderShareSkippedReasons: ['cap_reached'],
      realisedPnl: '0',
      unrealisedPnl: '10',
      unrealisedPnlReason: null,
    });
    expect(Object.keys(usdt ?? {}).sort()).toEqual(
      [
        'fills',
        'leaderShare',
        'leaderShareReason',
        'leaderShareSkippedReasons',
        'mirroredOrders',
        'quoteAsset',
        'realisedPnl',
        'realisedPnlReason',
        'tradingFee',
        'tradingFeeReason',
        'unrealisedPnl',
        'unrealisedPnlReason',
      ].sort(),
    );

    const bare = await copy.follow(principal(), {
      leaderId: '55555555-5555-4555-8555-555555555556',
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const empty = await copy.result(principal(), bare.followId);
    expect(empty).toMatchObject({
      mirroredOrders: 0,
      fills: 0,
      rejects: 0,
      tradingFee: '0',
      leaderShare: '0',
      realisedPnl: null,
      realisedPnlReason: 'pnl_no_position',
      unrealisedPnl: null,
      unrealisedPnlReason: 'pnl_no_position',
      assets: [],
    });

    const unwired = await readFollowResult(db!.sql, { ...bare, followId } as never, {
      lookupFollowerFillFee: null,
      lookupMark: null,
      now: NOW,
    });
    const unwiredUsdt = unwired.assets.find((asset) => asset.quoteAsset === 'USDT');
    expect(unwiredUsdt?.tradingFee).toBeNull();
    expect(unwiredUsdt?.tradingFeeReason).toBe(FEE_LOOKUP_UNWIRED);
    expect(unwiredUsdt?.realisedPnl).toBeNull();
    expect(unwiredUsdt?.realisedPnlReason).toBe(FEE_LOOKUP_UNWIRED);
    expect(unwiredUsdt?.unrealisedPnlReason).toBe('trade.mark_unavailable');

    await expect(copy.result(principal(OTHER), followId)).rejects.toMatchObject({ code: 'trade.copy_not_following' });
    await expect(copy.result(principal(FOLLOWER, ['trade:write']), followId)).rejects.toMatchObject({ code: 'scope.denied' });

    const window = { followId, from: FROM, to: TO };
    const full = await copy.mirrorTrail(principal(), { ...window, limit: 50 });
    expect(full.rows.some((row) => row.leaderFillId === 'lf-other')).toBe(false);
    expect(JSON.stringify(full)).not.toContain(LEADER);
    expect(full.rows.map((row) => row.kind).filter((kind) => kind === 'filled').length).toBe(4);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await copy.mirrorTrail(principal(), { ...window, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.rows.map((row) => row.eventId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(full.rows.map((row) => row.eventId));
    expect(new Set(seen).size).toBe(seen.length);

    await expect(copy.mirrorTrail(principal(), { followId, limit: 10 })).rejects.toMatchObject({
      code: 'trade.copy_trail_window_unset',
    });
    await expect(
      copy.mirrorTrail(principal(), {
        followId,
        from: FROM,
        to: new Date(Date.parse(FROM) + COPY_TRAIL_WINDOW_MAX_MS + 1).toISOString(),
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_trail_window_too_wide' });
    await expect(copy.mirrorTrail(principal(), { ...window, limit: undefined })).rejects.toMatchObject({
      code: 'trade.copy_trail_limit_unset',
    });
    await expect(copy.mirrorTrail(principal(OTHER), { ...window, limit: 10 })).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });

    const csv = await copy.exportMirrorTrail(principal(), window);
    expect(csv.split('\n')[0]).toBe(
      'eventId,followId,leaderFillId,kind,followerOrderId,followerFillId,quantity,price,basisPoints,code,occurredAt',
    );
    expect(csv).toContain(`"'=1+1"`);
    expect(csv).toContain('100');
    expect(csv).not.toContain(LEADER);
    expect(csv).not.toContain('lf-other');
    expect(csv).not.toMatch(/(?:^|,)[+-]?\d+(?:\.\d+)?e[+-]\d+(?:,|$)/i);

    const app = Fastify();
    attachCopyExportRoute(
      app,
      (who, query) => copy.exportMirrorTrail(who, query),
      () => principal(OTHER),
    );
    await app.ready();
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/copy/export?followId=${encodeURIComponent(followId)}&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ intafacedCode: 'trade.copy_not_following' });
    await app.close();

    const caller = createTradeRouter({} as TradeService, undefined, copy).createCaller(signed(OTHER));
    await expect(caller.copy.result({ followId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('writes no trail row when the caller does not own the follow', async () => {
    const events = new SqlMirrorEventLog(db!.sql);
    const copy = new CopyService(new MemoryLedger(), {
      feeShareLaw: { published: true, leaderShareBps: 5_000, earningsCapPerFollower: '100', decayRoundTrips: 100, decayShareBps: 1_000 },
      jurisdictionLaw: { published: true, allowedRegions: ['SG'] },
      placeMirrorEnabled: true,
      store: new SqlCopyFollowStore(db!.sql),
      sql: db!.sql,
      mirrorEvents: events,
      now: () => NOW,
    });
    const followed = await copy.follow(principal(), {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const followId = followed.followId;
    const foreignPlan = {
      followId,
      fillId: 'lf-foreign',
      marketId: 'ignored',
      side: 'buy' as const,
      qty: '1',
      notional: '1',
    };
    await expect(copy.planMirrorForFollow(principal(OTHER), foreignPlan)).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    await expect(copy.placeMirrorForFollow(principal(OTHER), { followId, fillId: 'lf-foreign', leaderPaper: false })).rejects.toMatchObject(
      { code: 'trade.copy_not_following' },
    );
    const ownedRows = await db!.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM copy_mirror_events WHERE follow_id = ${followId}
    `;
    expect(Number(ownedRows[0]!.n)).toBe(0);
    expect((await copy.result(principal(), followId)).rejects).toBe(0);

    const invented = randomUUID();
    await expect(
      copy.planMirrorForFollow(principal(), {
        followId: invented,
        fillId: 'lf-invented',
        marketId: 'ignored',
        side: 'buy',
        qty: '1',
        notional: '1',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_not_following' });
    await expect(
      copy.placeMirrorForFollow(principal(), { followId: invented, fillId: 'lf-invented', leaderPaper: false }),
    ).rejects.toMatchObject({ code: 'trade.copy_not_following' });
    const inventedRows = await db!.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM copy_mirror_events WHERE follow_id = ${invented}
    `;
    expect(Number(inventedRows[0]!.n)).toBe(0);
  });
});
