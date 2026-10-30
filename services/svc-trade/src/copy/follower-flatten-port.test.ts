/**
 * COPYFLAT acceptance — `copy.flatten` sells the follow's own filled mirrors.
 *
 * Quantity comes from `copy_placed_mirrors` joined to this follower's fills.
 * The plan row is a decoy (99) and another account's fill is a decoy (50).
 * Neither may change the sell. Docker is not started; the admin URL is
 * TEST_DATABASE_URL, moved onto `intafaced_test` when the file names `test`
 * because the suite guard only accepts a database ending in `_test`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, MemoryLedger, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SqlCopyFollowStore } from './follow-store.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { CopyService } from '../controls/test-admission.js';
import { copyFlattenClientOrderId, createFollowerFlattenPort } from './follower-flatten-port.js';
import type { PlaceFollowerOrderInput, PlaceFollowerOrderPort } from './auto-mirror-place.js';
import { readyMarket } from '../spot/testing.js';
import type { Market } from '../spot/types.js';
import type { StepUpCheck } from '@intafaced/contracts';

/** Identity's step-up, approving: these tests are about the close-all itself (the gate's own tests are in copy-flatten-step-up.test.ts). */
/** Identity's step-up, approving, and like identity a second use of one approval for the same request is a replay. */
const usedApprovals = new Set<string>();
const approveStepUp: StepUpCheck = {
  require: async ({ approvalId, requestId }) => {
    const key = `${approvalId}|${requestId}`;
    const replayed = usedApprovals.has(key);
    usedApprovals.add(key);
    return { stepUpEventId: approvalId ?? 'appr-test', consumedAt: null, replayed };
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const FOLLOWER = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const SESSION = '33333333-3333-4333-8333-333333333333';
const BTC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ETH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

const publishedFee = {
  published: true as const,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};
const publishedJur = { published: true as const, allowedRegions: ['SG'] };

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. Copy flatten does not start Docker.');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

function principal(userId = FOLLOWER): Principal {
  return {
    sub: userId,
    userId,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function spot(id: string, symbol: string, base: string, status: Market['status'] = 'active'): Market {
  return readyMarket(id, {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDT',
    status,
    tickSize: parseAmount('0.01'),
    lotSize: parseAmount('0.0001'),
    minQty: parseAmount('0.0001'),
    maxQty: parseAmount('100'),
    minNotional: parseAmount('1'),
    listedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

type Placed = PlaceFollowerOrderInput & { principalUserId: string; orderId: string };

describe('copy.flatten follower port (TRD-0723)', () => {
  let db: TestDatabase | undefined;
  let seq = 0;
  let leaders = 0;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db!.sql);
    seq = 0;
  });

  function sql() {
    return db!.sql;
  }

  function nextLeader(): string {
    leaders += 1;
    return `22222222-2222-4222-8222-${leaders.toString(16).padStart(12, '0')}`;
  }

  async function insertMarket(id: string, symbol: string, base: string): Promise<void> {
    await sql()`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${id}, ${symbol}, ${base}, 'USDT', 'spot',
        '0.01', '0.0001', '0.0001', '1',
        10, 20, 'active', ${symbol}, now()
      )
    `;
  }

  async function insertFilledMirror(input: {
    followId: string;
    followerId: string;
    leaderId: string;
    marketId: string;
    symbol: string;
    base: string;
    fillQty: string;
    side: 'buy' | 'sell';
    fillUserId?: string;
    planQty?: string;
    feeAsset?: string;
    feeAmount?: string;
  }): Promise<void> {
    const orderId = randomUUID();
    const fillId = randomUUID();
    const leaderFillId = `leader-${fillId}`;
    seq += 1;
    const fillUser = input.fillUserId ?? input.followerId;
    const feeAsset = input.feeAsset ?? 'USDT';
    const feeAmount = input.feeAmount ?? '0';
    await sql()`
      INSERT INTO trade.orders (
        id, user_id, market_id, side, type, price, qty, filled_qty, status, tif,
        hold_asset, hold_amount, fee_discount_bps
      ) VALUES (
        ${orderId}, ${input.followerId}, ${input.marketId}, ${input.side}, 'limit',
        '100', ${input.fillQty}, ${input.fillQty}, 'filled', 'GTC',
        ${input.base}, ${input.fillQty}, 0
      )
    `;
    await sql()`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${fillId}, ${orderId}, ${randomUUID()}, ${input.marketId}, ${fillUser}, ${input.side}, 'taker',
        '100', ${input.fillQty}, '100', ${feeAsset}, ${feeAmount}, 0, ${seq}
      )
    `;
    await sql()`
      INSERT INTO trade.copy_placed_mirrors (follow_id, fill_id, order_id, client_order_id, price)
      VALUES (${input.followId}, ${leaderFillId}, ${orderId}, ${`mirror-${leaderFillId}`}, '100')
    `;
    if (input.planQty) {
      await sql()`
        INSERT INTO trade.copy_mirrored_fills (
          follow_id, fill_id, follower_id, leader_id, market_id, side, qty, notional, next_exposure
        ) VALUES (
          ${input.followId}, ${leaderFillId}, ${input.followerId}, ${input.leaderId}, ${input.symbol},
          ${input.side}, ${input.planQty}, ${input.planQty}, ${input.planQty}
        )
      `;
    }
  }

  async function deposit(ledger: LedgerClient, assetId: string, amount: string): Promise<void> {
    await ledger.post(
      recipes.deposit({
        userId: FOLLOWER,
        assetId,
        amount: parseAmount(amount),
        rail: 'test',
        railRef: `${assetId}-${amount}-${randomUUID()}`,
      }),
    );
  }

  function harness(opts: {
    markets: readonly Market[];
    bids: Record<string, string | null>;
    slippageCapBps: number | null;
    enabled?: boolean;
  }) {
    const ledger = new MemoryLedger();
    const store = new SqlCopyFollowStore(sql());
    const calls: Placed[] = [];
    const bySymbol = new Map(opts.markets.map((market) => [market.symbol, market]));
    const place: PlaceFollowerOrderPort = async (who, input) => {
      const orderId = randomUUID();
      const marketId = input.marketId;
      if (!marketId) throw new Error('flatten place requires a market id');
      calls.push({ ...input, marketId, principalUserId: who.userId, orderId });
      await sql()`
        INSERT INTO trade.orders (
          id, user_id, market_id, client_order_id, side, type, price, qty, status, tif,
          hold_asset, hold_amount, fee_discount_bps
        ) VALUES (
          ${orderId}, ${who.userId}, ${marketId}, ${input.clientOrderId}, 'sell', 'limit',
          ${formatAmount(input.price)}::numeric, ${formatAmount(input.qty)}::numeric, 'open', 'GTC',
          'BTC', ${formatAmount(input.qty)}::numeric, 0
        )
      `;
      return { orderId };
    };
    const port = createFollowerFlattenPort({
      sql: sql(),
      ledger,
      store,
      placeFollowerOrder: place,
      slippageCapBps: opts.slippageCapBps,
      loadMarket: async (symbol) => bySymbol.get(symbol) ?? null,
      bestBid: async (marketId) => {
        const raw = opts.bids[marketId];
        return raw == null ? null : parseAmount(raw);
      },
    });
    const copy = new CopyService(ledger, {
      stepUp: approveStepUp,
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
      placeMirrorEnabled: opts.enabled ?? true,
      store,
      placeFollowerOrder: place,
      flattenCopyPosition: port,
    });
    return { ledger, store, copy, calls, place };
  }

  async function open(copy: CopyService, leaderId: string, markets: readonly string[]) {
    return copy.follow(principal(), {
      leaderId,
      region: 'SG',
      permittedMarkets: markets,
      maxNotionalPerOrder: '100000',
      maxAggregateExposure: '100000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
  }

  it('sells exactly the filled 3 BTC at the floor, then detaches; a replay places nothing new', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const leaderId = nextLeader();
    const follow = await open(box.copy, leaderId, ['BTC-USDT']);
    await box.copy.grantSessionKey(principal(), { followId: follow.followId });
    await insertMarket(BTC_ID, 'BTC-USDT', 'BTC');
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '1',
      side: 'buy',
      planQty: '99',
    });
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '2',
      side: 'buy',
      planQty: '99',
    });
    seq += 1;
    const decoyOrder = await sql()<Array<{ id: string }>>`
      SELECT id::text AS id FROM trade.orders WHERE user_id = ${FOLLOWER} AND market_id = ${BTC_ID} LIMIT 1
    `;
    await sql()`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${randomUUID()}, ${decoyOrder[0]!.id}, ${randomUUID()}, ${BTC_ID}, ${OTHER}, 'buy', 'maker',
        '100', '50', '100', 'USDT', '0', 0, ${seq}
      )
    `;
    await deposit(box.ledger, 'BTC', '10');

    const acked = await box.copy.flatten(principal(), {
      followId: follow.followId,
      requestId: 'flatten-0001',
      stepUpApprovalId: 'appr-test',
    });
    expect(box.calls).toHaveLength(1);
    const sell = box.calls[0]!;
    expect(sell.principalUserId).toBe(FOLLOWER);
    expect(sell.side).toBe('sell');
    expect(sell.symbol).toBe('BTC-USDT');
    expect(sell.marketId).toBe(BTC_ID);
    expect(formatAmount(sell.qty)).toBe('3');
    expect(formatAmount(sell.price)).toBe('98.5');
    expect(sell.clientOrderId).toBe(copyFlattenClientOrderId(follow.followId, 'BTC-USDT'));
    expect(sell.clientOrderId.length).toBeLessThanOrEqual(64);
    expect(acked.orderIds).toEqual([sell.orderId]);
    expect(acked).toMatchObject({
      followId: follow.followId,
      relationshipState: 'DETACHED',
      disposition: 'DETACH_FLATTEN',
      newIntentFenced: true,
      flattenChosen: true,
      flattenInvented: false,
      sessionKeyRevoked: true,
    });
    expect(Object.keys(acked).sort()).toEqual(
      [
        'disposition',
        'flattenChosen',
        'flattenInvented',
        'followId',
        'newIntentFenced',
        'orderIds',
        'relationshipState',
        'sessionKeyRevoked',
      ].sort(),
    );
    expect(JSON.stringify(acked)).not.toContain(leaderId);

    const row = await sql()<Array<{ user_id: string }>>`
      SELECT user_id::text AS user_id FROM trade.orders WHERE id = ${sell.orderId}
    `;
    expect(row[0]?.user_id).toBe(FOLLOWER);
    const foreign = await sql()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trade.orders
       WHERE client_order_id LIKE 'copy-flatten:%' AND user_id <> ${FOLLOWER}
    `;
    expect(foreign[0]?.n).toBe(0);

    const detached = await box.store.getFollow(follow.followId);
    expect(detached?.relationshipState).toBe('DETACHED');
    expect(detached?.sessionKeyRevoked).toBe(true);

    const again = await box.copy.flatten(principal(), {
      followId: follow.followId,
      requestId: 'flatten-0001',
      stepUpApprovalId: 'appr-test',
    });
    expect(box.calls).toHaveLength(1);
    expect(again.orderIds).toEqual(acked.orderIds);

    // A new close-all (a new confirmation and request) on the follow already left is refused, and nothing is placed (#6920).
    await expect(
      box.copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0002', stepUpApprovalId: 'appr-test-2' }),
    ).rejects.toMatchObject({ code: 'trade.copy_detached' });
    expect(box.calls).toHaveLength(1);
    expect(await box.store.getFollow(follow.followId)).toEqual(detached);
  });

  it('refuses drift and places nothing when available balance is below the mirrored net', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const leaderId = nextLeader();
    const follow = await open(box.copy, leaderId, ['BTC-USDT']);
    await insertMarket(BTC_ID, 'BTC-USDT', 'BTC');
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '3',
      side: 'buy',
    });
    await deposit(box.ledger, 'BTC', '2');
    await expect(
      box.copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' }),
    ).rejects.toMatchObject({
      code: 'trade.copy_flatten_drift',
    });
    expect(box.calls).toEqual([]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('ACTIVE');
  });

  it('refuses unavailable when the floor is unpublished and leaves the follow attached', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: null });
    const leaderId = nextLeader();
    const follow = await open(box.copy, leaderId, ['BTC-USDT']);
    await insertMarket(BTC_ID, 'BTC-USDT', 'BTC');
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '3',
      side: 'buy',
    });
    await deposit(box.ledger, 'BTC', '10');
    await expect(
      box.copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' }),
    ).rejects.toMatchObject({
      code: 'trade.copy_flatten_unavailable',
    });
    expect(box.calls).toEqual([]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('ACTIVE');
  });

  it('refuses unavailable when the market is halted and leaves the follow attached', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC', 'halted');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const leaderId = nextLeader();
    const follow = await open(box.copy, leaderId, ['BTC-USDT']);
    await insertMarket(BTC_ID, 'BTC-USDT', 'BTC');
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '3',
      side: 'buy',
    });
    await deposit(box.ledger, 'BTC', '10');
    await expect(
      box.copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' }),
    ).rejects.toMatchObject({
      code: 'trade.copy_flatten_unavailable',
    });
    expect(box.calls).toEqual([]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('ACTIVE');
  });

  it('returns partial with the first order id, stays fenced, and the retry places only the second market', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const eth = spot(ETH_ID, 'ETH-USDT', 'ETH');
    const bids: Record<string, string | null> = { [BTC_ID]: '100', [ETH_ID]: null };
    const box = harness({ markets: [btc, eth], bids, slippageCapBps: 150 });
    const leaderId = nextLeader();
    const follow = await open(box.copy, leaderId, ['BTC-USDT', 'ETH-USDT']);
    await box.copy.grantSessionKey(principal(), { followId: follow.followId });
    await insertMarket(BTC_ID, 'BTC-USDT', 'BTC');
    await insertMarket(ETH_ID, 'ETH-USDT', 'ETH');
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '3',
      side: 'buy',
    });
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: ETH_ID,
      symbol: 'ETH-USDT',
      base: 'ETH',
      fillQty: '1',
      side: 'buy',
    });
    await deposit(box.ledger, 'BTC', '10');
    await deposit(box.ledger, 'ETH', '5');

    const stateAtPlace: string[] = [];
    const keyAtPlace: Array<boolean | undefined> = [];
    const inner = box.place;
    const wrapped: PlaceFollowerOrderPort = async (who, input) => {
      const mid = await box.store.getFollow(follow.followId);
      stateAtPlace.push(mid?.relationshipState ?? 'missing');
      keyAtPlace.push(mid?.sessionKeyRevoked);
      return inner(who, input);
    };
    const replay = createFollowerFlattenPort({
      sql: sql(),
      ledger: box.ledger,
      store: box.store,
      placeFollowerOrder: wrapped,
      slippageCapBps: 150,
      loadMarket: async (symbol) => (symbol === 'ETH-USDT' ? eth : btc),
      bestBid: async (marketId) => {
        const raw = bids[marketId];
        return raw == null ? null : parseAmount(raw);
      },
    });
    const copy = new CopyService(box.ledger, {
      stepUp: approveStepUp,
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
      placeMirrorEnabled: true,
      store: box.store,
      placeFollowerOrder: wrapped,
      flattenCopyPosition: replay,
    });

    await expect(
      copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' }),
    ).rejects.toMatchObject({
      code: 'trade.copy_flatten_partial',
      orderIds: [expect.any(String)],
    });
    expect(stateAtPlace).toEqual(['STOPPING']);
    expect(keyAtPlace).toEqual([false]);
    expect(box.calls.map((call) => call.symbol)).toEqual(['BTC-USDT']);
    const fenced = await box.store.getFollow(follow.followId);
    expect(fenced?.relationshipState).toBe('STOPPING');
    expect(fenced?.sessionKeyRevoked).not.toBe(true);
    await expect(
      copy.planMirrorForFollow(principal(), {
        followId: follow.followId,
        fillId: 'fill-after-partial',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '1',
        notional: '1',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_stopped' });

    const firstId = box.calls[0]!.orderId;
    bids[ETH_ID] = '100';
    const acked = await copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' });
    expect(box.calls.map((call) => call.symbol)).toEqual(['BTC-USDT', 'ETH-USDT']);
    expect(formatAmount(box.calls[1]!.qty)).toBe('1');
    expect(formatAmount(box.calls[1]!.price)).toBe('98.5');
    expect(acked.orderIds).toEqual([firstId, box.calls[1]!.orderId]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('DETACHED');
    expect((await box.store.getFollow(follow.followId))?.sessionKeyRevoked).toBe(true);

    const third = await copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' });
    expect(box.calls).toHaveLength(2);
    expect(third.orderIds).toEqual(acked.orderIds);
  });

  it('keeps refusing trade.copy_flatten_refused when the place flag is off, and the follow stays attached', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150, enabled: false });
    const leaderId = nextLeader();
    const follow = await open(box.copy, leaderId, ['BTC-USDT']);
    await insertMarket(BTC_ID, 'BTC-USDT', 'BTC');
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '3',
      side: 'buy',
    });
    await deposit(box.ledger, 'BTC', '10');
    await expect(
      box.copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' }),
    ).rejects.toMatchObject({
      code: 'trade.copy_flatten_refused',
    });
    expect(box.calls).toEqual([]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('ACTIVE');
  });

  it('answers not found for another account follow', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const follow = await open(box.copy, nextLeader(), ['BTC-USDT']);
    await expect(
      box.copy.flatten(principal(OTHER), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' }),
    ).rejects.toMatchObject({
      code: 'trade.copy_not_following',
    });
    expect(box.calls).toEqual([]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('ACTIVE');
  });

  it('detaches with an empty order list when the follow has nothing to close', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const follow = await open(box.copy, nextLeader(), ['BTC-USDT']);
    const acked = await box.copy.flatten(principal(), {
      followId: follow.followId,
      requestId: 'flatten-0001',
      stepUpApprovalId: 'appr-test',
    });
    expect(acked.orderIds).toEqual([]);
    expect(box.calls).toEqual([]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('DETACHED');
  });

  it('treats a net at or below zero as nothing to close', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const leaderId = nextLeader();
    const follow = await open(box.copy, leaderId, ['BTC-USDT']);
    await insertMarket(BTC_ID, 'BTC-USDT', 'BTC');
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '1',
      side: 'buy',
    });
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '1',
      side: 'sell',
    });
    const acked = await box.copy.flatten(principal(), {
      followId: follow.followId,
      requestId: 'flatten-0001',
      stepUpApprovalId: 'appr-test',
    });
    expect(acked.orderIds).toEqual([]);
    expect(box.calls).toEqual([]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('DETACHED');
  });

  async function buyWithFee(box: ReturnType<typeof harness>, leaderId: string, feeAsset: string, feeAmount: string) {
    const follow = await open(box.copy, leaderId, ['BTC-USDT']);
    await box.copy.grantSessionKey(principal(), { followId: follow.followId });
    await insertMarket(BTC_ID, 'BTC-USDT', 'BTC');
    await insertFilledMirror({
      followId: follow.followId,
      followerId: FOLLOWER,
      leaderId,
      marketId: BTC_ID,
      symbol: 'BTC-USDT',
      base: 'BTC',
      fillQty: '3',
      side: 'buy',
      feeAsset,
      feeAmount,
    });
    return follow;
  }

  it('sells exactly 2.994 after a base-asset buy fee when the deposit equals that net, then detaches', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const follow = await buyWithFee(box, nextLeader(), 'BTC', '0.006');
    await deposit(box.ledger, 'BTC', '2.994');

    const acked = await box.copy.flatten(principal(), {
      followId: follow.followId,
      requestId: 'flatten-0001',
      stepUpApprovalId: 'appr-test',
    });
    expect(box.calls).toHaveLength(1);
    const sell = box.calls[0]!;
    expect(sell.side).toBe('sell');
    expect(sell.symbol).toBe('BTC-USDT');
    expect(formatAmount(sell.qty)).toBe('2.994');
    expect(formatAmount(sell.price)).toBe('98.5');
    expect(acked.orderIds).toEqual([sell.orderId]);
    expect(acked.relationshipState).toBe('DETACHED');
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('DETACHED');
  });

  it('sells exactly 2.994 after a base-asset buy fee when the follower also holds their own coin', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const follow = await buyWithFee(box, nextLeader(), 'BTC', '0.006');
    await deposit(box.ledger, 'BTC', '10');

    const acked = await box.copy.flatten(principal(), {
      followId: follow.followId,
      requestId: 'flatten-0001',
      stepUpApprovalId: 'appr-test',
    });
    expect(box.calls).toHaveLength(1);
    expect(formatAmount(box.calls[0]!.qty)).toBe('2.994');
    expect(formatAmount(box.calls[0]!.price)).toBe('98.5');
    expect(acked.orderIds).toEqual([box.calls[0]!.orderId]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('DETACHED');
  });

  it('refuses unavailable when a buy fee is nonzero in an asset that is neither base nor quote', async () => {
    const btc = spot(BTC_ID, 'BTC-USDT', 'BTC');
    const box = harness({ markets: [btc], bids: { [BTC_ID]: '100' }, slippageCapBps: 150 });
    const follow = await buyWithFee(box, nextLeader(), 'ETH', '0.006');
    await deposit(box.ledger, 'BTC', '10');

    await expect(
      box.copy.flatten(principal(), { followId: follow.followId, requestId: 'flatten-0001', stepUpApprovalId: 'appr-test' }),
    ).rejects.toMatchObject({
      code: 'trade.copy_flatten_unavailable',
    });
    expect(box.calls).toEqual([]);
    expect((await box.store.getFollow(follow.followId))?.relationshipState).toBe('ACTIVE');
  });
});
