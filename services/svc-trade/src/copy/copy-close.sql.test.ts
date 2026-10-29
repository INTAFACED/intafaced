/**
 * Closing one copied position on Postgres (CB-copy-10): the copied positions read from the follower's own orders and
 * fills, the close placed once per key at the protection floor, a retry after an unknown outcome sending the same
 * order, a typed refusal leaving nothing behind, and a flatten after a close never selling the closed coin again.
 * Docker is not started; TEST_DATABASE_URL is moved onto `intafaced_test` as the other copy suites do.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SqlCopyFollowStore } from './follow-store.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { CopyService } from '../controls/test-admission.js';
import { createCopyClosePort, copyCloseClientOrderId } from './copy-close.js';
import { createFollowerFlattenPort } from './follower-flatten-port.js';
import type { PlaceFollowerOrderInput, PlaceFollowerOrderPort } from './auto-mirror-place.js';
import { orderIdFor } from '../spot/ids.js';
import { readyMarket } from '../spot/testing.js';
import { TradeError, type Market } from '../spot/types.js';
import { SqlMirrorEventLog } from './mirror-events.js';
import { recordCopySkip } from './skip-log.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const FOLLOWER = '11111111-1111-4111-8111-1111111111d1';
const LEADER = '22222222-2222-4222-8222-2222222222d2';
const SESSION = '33333333-3333-4333-8333-3333333333d3';
const BTC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad1';

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. Copy close does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const principal = {
  sub: FOLLOWER,
  userId: FOLLOWER,
  sid: SESSION,
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 60_000),
} as Principal;

const btc: Market = readyMarket(BTC_ID, {
  symbol: 'BTC-USDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'active',
  tickSize: parseAmount('0.01'),
  lotSize: parseAmount('0.0001'),
  minQty: parseAmount('0.0001'),
  maxQty: parseAmount('100'),
  minNotional: parseAmount('1'),
  listedAt: new Date('2026-01-01T00:00:00.000Z'),
});

describe('copy.closePosition on Postgres (CB-copy-10)', () => {
  let db: TestDatabase | undefined;
  let seq = 0;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db!.sql);
    await db!.sql`DELETE FROM trade.copy_close_orders`;
    seq = 0;
    await db!.sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (${BTC_ID}, 'BTC-USDT', 'BTC', 'USDT', 'spot', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC-USDT', now())
    `;
  });

  /** A filled order of the follower's, with its fill; a copied buy or sell also gets its copy_placed_mirrors row. */
  async function filledOrder(input: { followId?: string; side: 'buy' | 'sell'; qty: string; at: string; clientOrderId?: string }) {
    const orderId = randomUUID();
    const leaderFillId = `leader-${randomUUID()}`;
    seq += 1;
    await db!.sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif,
        hold_asset, hold_amount, fee_discount_bps
      ) VALUES (
        ${orderId}, ${FOLLOWER}, ${BTC_ID}, ${input.clientOrderId ?? null}, ${input.side}, 'limit',
        '100', ${input.qty}, ${input.qty}, 'filled', 'GTC', 'BTC', ${input.qty}, 0
      )
    `;
    await db!.sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${randomUUID()}, ${orderId}, ${randomUUID()}, ${BTC_ID}, ${FOLLOWER}, ${input.side}, 'taker',
        '100', ${input.qty}, '100', 'USDT', '0', 0, ${seq}
      )
    `;
    if (input.followId) {
      await db!.sql`
        INSERT INTO trade.copy_placed_mirrors (follow_id, fill_id, order_id, client_order_id, price, created_at)
        VALUES (${input.followId}, ${leaderFillId}, ${orderId}, ${`mirror-${leaderFillId}`}, '100', ${input.at}::timestamptz)
      `;
    }
    return { orderId, leaderFillId };
  }

  /** Marks a placed close order filled, as the matching engine would. */
  async function fillOrder(orderId: string, qty: string) {
    seq += 1;
    await db!.sql`UPDATE trade.orders SET filled_qty = ${qty}, status = 'filled' WHERE id = ${orderId}`;
    await db!.sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (${randomUUID()}, ${orderId}, ${randomUUID()}, ${BTC_ID}, ${FOLLOWER}, 'sell', 'taker', '99', ${qty}, '99', 'USDT', '0', 0, ${seq})
    `;
  }

  function harness(opts: { fail?: () => Error | null } = {}) {
    const ledger = new MemoryLedger();
    const store = new SqlCopyFollowStore(db!.sql);
    const calls: PlaceFollowerOrderInput[] = [];
    const place: PlaceFollowerOrderPort = async (who, input) => {
      calls.push(input);
      const failure = opts.fail?.();
      if (failure) throw failure;
      // The spot path's own once-per-client-id: the same client id is the same order.
      const orderId = orderIdFor(who.userId, input.marketId!, input.clientOrderId);
      await db!.sql`
        INSERT INTO trade.orders (
          id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps
        ) VALUES (
          ${orderId}, ${who.userId}, ${input.marketId!}, ${input.clientOrderId}, ${input.side}, 'limit',
          ${formatAmount(input.price)}::numeric, ${formatAmount(input.qty)}::numeric, 'open', 'GTC', 'BTC', ${formatAmount(input.qty)}::numeric, 0
        ) ON CONFLICT (id) DO NOTHING
      `;
      return { orderId };
    };
    const priceDeps = {
      slippageCapBps: 100,
      loadMarket: async (symbol: string) => (symbol === btc.symbol ? btc : null),
      bestBid: async () => parseAmount('100'),
    };
    const copy = new CopyService(ledger, {
      feeShareLaw: { published: true, leaderShareBps: 5_000, earningsCapPerFollower: '100', decayRoundTrips: 100, decayShareBps: 1_000 },
      jurisdictionLaw: { published: true, allowedRegions: ['SG'] },
      placeMirrorEnabled: true,
      store,
      sql: db!.sql,
      placeFollowerOrder: place,
      copyClose: createCopyClosePort({ sql: db!.sql, placeFollowerOrder: place, ...priceDeps }),
      flattenCopyPosition: createFollowerFlattenPort({ sql: db!.sql, ledger, store, placeFollowerOrder: place, ...priceDeps }),
    });
    return { copy, calls, ledger };
  }

  async function follow(copy: CopyService) {
    const made = await copy.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '100000',
      maxAggregateExposure: '100000',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    return made.followId;
  }

  it('reads each copied buy with what is open, newest first, after the leader sells copied', async () => {
    const box = harness();
    const followId = await follow(box.copy);
    await filledOrder({ followId, side: 'buy', qty: '0.5', at: '2026-10-24T08:00:01Z' });
    const second = await filledOrder({ followId, side: 'buy', qty: '0.5', at: '2026-10-24T08:00:02Z' });
    await filledOrder({ followId, side: 'sell', qty: '0.7', at: '2026-10-24T08:00:03Z' });

    const { positions } = await box.copy.copiedPositions(principal, { followId });
    expect(positions.map((p) => [p.positionId, p.open, p.status])).toEqual([
      [second.orderId, '0.3', 'open'],
      [expect.any(String), '0', 'closed'],
    ]);
  });

  it('closes a position once at the floor; the same close again returns the same order', async () => {
    const box = harness();
    const followId = await follow(box.copy);
    const bought = await filledOrder({ followId, side: 'buy', qty: '0.5', at: '2026-10-24T08:00:01Z' });

    const first = await box.copy.closePosition(principal, { followId, positionId: bought.orderId });
    const key = `copy.close:${followId}:${bought.leaderFillId}`;
    expect(first).toMatchObject({ qty: '0.5', duplicate: false, orderId: orderIdFor(FOLLOWER, BTC_ID, copyCloseClientOrderId(key)) });
    // Floor: best bid 100 less 1% is 99.
    expect(box.calls.map((c) => [c.side, formatAmount(c.qty), formatAmount(c.price), c.clientOrderId])).toEqual([
      ['sell', '0.5', '99', copyCloseClientOrderId(key)],
    ]);
    expect((await box.copy.copiedPositions(principal, { followId })).positions[0]).toMatchObject({ open: '0', status: 'closing' });

    const again = await box.copy.closePosition(principal, { followId, positionId: bought.orderId });
    expect(again).toMatchObject({ orderId: first.orderId, duplicate: true });
    expect(box.calls).toHaveLength(1);

    await fillOrder(first.orderId, '0.5');
    expect((await box.copy.copiedPositions(principal, { followId })).positions[0]).toMatchObject({ open: '0', status: 'closed' });
  });

  it('refuses more than is open by its typed code; nothing is recorded or placed and the position reads the same', async () => {
    const box = harness();
    const followId = await follow(box.copy);
    const bought = await filledOrder({ followId, side: 'buy', qty: '0.5', at: '2026-10-24T08:00:01Z' });
    const before = await box.copy.copiedPositions(principal, { followId });

    await expect(box.copy.closePosition(principal, { followId, positionId: bought.orderId, qty: '1' })).rejects.toMatchObject({
      code: 'trade.copy_close_qty_exceeds',
    });
    expect(box.calls).toEqual([]);
    expect(await db!.sql`SELECT 1 FROM trade.copy_close_orders`).toHaveLength(0);
    expect(await box.copy.copiedPositions(principal, { followId })).toEqual(before);
  });

  it('after an unknown outcome reads closing, and a retry sends the very same order', async () => {
    let fail = true;
    const box = harness({ fail: () => (fail ? new Error('connection reset') : null) });
    const followId = await follow(box.copy);
    const bought = await filledOrder({ followId, side: 'buy', qty: '0.5', at: '2026-10-24T08:00:01Z' });

    await expect(box.copy.closePosition(principal, { followId, positionId: bought.orderId, qty: '0.2' })).rejects.toThrow(
      'connection reset',
    );
    expect((await box.copy.copiedPositions(principal, { followId })).positions[0]).toMatchObject({
      open: '0.3',
      closing: '0.2',
      status: 'closing',
    });

    fail = false;
    const retried = await box.copy.closePosition(principal, { followId, positionId: bought.orderId, qty: '0.2' });
    expect(retried.duplicate).toBe(true);
    expect(box.calls).toHaveLength(2);
    expect(box.calls[1]).toEqual(box.calls[0]);
    expect(await db!.sql`SELECT 1 FROM trade.orders WHERE side = 'sell'`).toHaveLength(1);
  });

  it('a typed refusal of the place frees the key and leaves the position open', async () => {
    let refuse = true;
    const box = harness({ fail: () => (refuse ? new TradeError('halted', 'trade.market_not_tradable') : null) });
    const followId = await follow(box.copy);
    const bought = await filledOrder({ followId, side: 'buy', qty: '0.5', at: '2026-10-24T08:00:01Z' });

    await expect(box.copy.closePosition(principal, { followId, positionId: bought.orderId })).rejects.toMatchObject({
      code: 'trade.market_not_tradable',
    });
    expect(await db!.sql`SELECT 1 FROM trade.copy_close_orders`).toHaveLength(0);
    expect((await box.copy.copiedPositions(principal, { followId })).positions[0]).toMatchObject({ open: '0.5', status: 'open' });

    refuse = false;
    expect(await box.copy.closePosition(principal, { followId, positionId: bought.orderId })).toMatchObject({
      duplicate: false,
      qty: '0.5',
    });
  });

  it('after the close is cancelled unfilled, closing again places the next attempt, once', async () => {
    const box = harness();
    const followId = await follow(box.copy);
    const bought = await filledOrder({ followId, side: 'buy', qty: '0.5', at: '2026-10-24T08:00:01Z' });
    const key = `copy.close:${followId}:${bought.leaderFillId}`;

    const first = await box.copy.closePosition(principal, { followId, positionId: bought.orderId });
    await db!.sql`UPDATE trade.orders SET status = 'cancelled' WHERE id = ${first.orderId}`;
    expect((await box.copy.copiedPositions(principal, { followId })).positions[0]).toMatchObject({ open: '0.5', status: 'open' });

    const second = await box.copy.closePosition(principal, { followId, positionId: bought.orderId });
    expect(second).toMatchObject({ duplicate: false, qty: '0.5' });
    expect(second.orderId).not.toBe(first.orderId);
    expect(box.calls.map((c) => c.clientOrderId)).toEqual([copyCloseClientOrderId(key), copyCloseClientOrderId(`${key}#2`)]);

    const again = await box.copy.closePosition(principal, { followId, positionId: bought.orderId });
    expect(again).toMatchObject({ orderId: second.orderId, duplicate: true });
    expect(box.calls).toHaveLength(2);
  });

  it('a flatten after a filled close sells only what is still copied and open', async () => {
    const box = harness();
    const followId = await follow(box.copy);
    await box.copy.grantSessionKey(principal, { followId });
    await box.ledger.post(recipes.deposit({ userId: FOLLOWER, assetId: 'BTC', amount: parseAmount('1'), rail: 'test', railRef: 'btc-1' }));
    const bought = await filledOrder({ followId, side: 'buy', qty: '0.5', at: '2026-10-24T08:00:01Z' });

    const closed = await box.copy.closePosition(principal, { followId, positionId: bought.orderId, qty: '0.2' });
    await fillOrder(closed.orderId, '0.2');
    await box.copy.flatten(principal, { followId });
    expect(box.calls.map((c) => formatAmount(c.qty))).toEqual(['0.2', '0.3']);
  });

  it('keeps one skip row per follow and leader fill on Postgres, newest first', async () => {
    const log = new SqlMirrorEventLog(db!.sql);
    const followId = `follow-${randomUUID()}`;
    const at = new Date('2026-10-24T08:00:00.000Z');
    expect(await recordCopySkip(log, { followId, leaderFillId: 'fill-a', reason: 'paused', at })).toBe('inserted');
    expect(await recordCopySkip(log, { followId, leaderFillId: 'fill-a', reason: 'stopped', at })).toBe('replay');
    await recordCopySkip(log, { followId, leaderFillId: 'fill-b', reason: 'risk_control', at: new Date(at.getTime() + 1000) });
    expect((await log.listSkips(followId, 100)).map((r) => [r.leaderFillId, r.code])).toEqual([
      ['fill-b', 'risk_control'],
      ['fill-a', 'paused'],
    ]);
  });
});
