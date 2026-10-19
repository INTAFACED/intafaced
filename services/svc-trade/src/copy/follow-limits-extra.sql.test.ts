/**
 * COPYLIMITS durability. Peak and the open-order count live in Postgres.
 * The admin URL must name a *_test database (intafaced_test on the shared
 * host). This file does not start Docker.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, type Amount } from '@intafaced/ledger-client';
import { CopyService } from '../controls/test-admission.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { SqlCopyFollowStore } from './follow-store.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './fee-share-law.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

const FOLLOWER = '11111111-1111-4111-8111-111111111111';
const LEADER = '22222222-2222-4222-8222-222222222222';
const MARKET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ORDER_OPEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ORDER_FILLED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ORDER_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const principal = { userId: FOLLOWER } as import('@intafaced/auth').Principal;

const publishedFee: CopyFeeShareLaw = {
  published: true,
  leaderShareBps: 5_000,
  earningsCapPerFollower: '100',
  decayRoundTrips: 100,
  decayShareBps: 1_000,
};
const publishedJur: CopyJurisdictionLaw = { published: true, allowedRegions: ['SG'] };

function adminUrl(): string {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!envUrl) {
    throw new Error('TEST_DATABASE_URL is unset — COPYLIMITS does not start Docker');
  }
  const url = new URL(envUrl);
  if (url.pathname === '/test') url.pathname = '/intafaced_test';
  return url.toString();
}

describe('copy follower limits are durable', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db!.sql);
  });

  function leaderFill() {
    return async (fillId: string) => ({
      fillId,
      userId: LEADER,
      marketId: 'BTC-USDT',
      side: 'buy' as const,
      qty: parseAmount('0.01'),
      notional: parseAmount('10'),
      price: parseAmount('1000'),
    });
  }

  it('keeps an 18-place peak across a new store and then stops a 40 drop against a cap of 30', async () => {
    let figure: Amount | null = parseAmount('100');
    const first = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
      store: new SqlCopyFollowStore(db!.sql),
      lookupLeaderFill: leaderFill(),
      readResultFigure: async () => ({ figure, missing: null }),
    });
    const followed = await first.follow(principal, {
      leaderId: LEADER,
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      maxDrawdown: '30',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    await first.planMirrorForFollow(principal, {
      followId: followed.followId,
      fillId: 'peak-1',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '10',
    });

    const restarted = new SqlCopyFollowStore(db!.sql);
    const loaded = await restarted.getFollow(followed.followId);
    expect(loaded?.peakResult).toBe(parseAmount('100'));

    figure = parseAmount('60');
    const second = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
      store: restarted,
      lookupLeaderFill: leaderFill(),
      readResultFigure: async () => ({ figure, missing: null }),
    });
    await expect(
      second.planMirrorForFollow(principal, {
        followId: followed.followId,
        fillId: 'peak-2',
        marketId: 'BTC-USDT',
        side: 'buy',
        qty: '0.01',
        notional: '10',
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_drawdown_stop' });
    expect((await restarted.getFollow(followed.followId))?.peakResult).toBe(parseAmount('100'));

    const exact = '1.123456789012345678';
    figure = parseAmount(exact);
    const precise = await second.follow(principal, {
      leaderId: '33333333-3333-4333-8333-333333333333',
      region: 'SG',
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: '1000',
      maxAggregateExposure: '10000',
      maxDrawdown: '30',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const third = new CopyService(new MemoryLedger(), {
      feeShareLaw: publishedFee,
      jurisdictionLaw: publishedJur,
      store: restarted,
      lookupLeaderFill: async (fillId) => ({
        fillId,
        userId: '33333333-3333-4333-8333-333333333333',
        marketId: 'BTC-USDT',
        side: 'buy' as const,
        qty: parseAmount('0.01'),
        notional: parseAmount('10'),
        price: parseAmount('1000'),
      }),
      readResultFigure: async () => ({ figure, missing: null }),
    });
    await third.planMirrorForFollow(principal, {
      followId: precise.followId,
      fillId: 'peak-exact',
      marketId: 'BTC-USDT',
      side: 'buy',
      qty: '0.01',
      notional: '10',
    });
    const again = await new SqlCopyFollowStore(db!.sql).getFollow(precise.followId);
    expect(again?.peakResult).toBe(parseAmount(exact));
  });

  it('counts only this follow’s non-terminal orders, and an unreadable state counts as open', async () => {
    await db!.sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name
      ) VALUES (
        ${MARKET}, 'BTC-USDT', 'BTC', 'USDT', 'spot', 0.01, 0.0001, 0.0001, 1, 10, 20, 'pending', 'BTC-USDT'
      )
    `;
    async function order(id: string, status: string) {
      await db!.sql`
        INSERT INTO trade.orders (
          id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif,
          hold_asset, hold_amount
        ) VALUES (
          ${id}, ${FOLLOWER}, ${MARKET}, ${id}, 'buy', 'limit', 100, 1, 0, ${status}::trade.order_status, 'GTC',
          'USDT', 100
        )
      `;
    }
    await order(ORDER_OPEN, 'open');
    await order(ORDER_FILLED, 'filled');
    await order(ORDER_OTHER, 'open');
    await db!.sql`
      INSERT INTO copy_placed_mirrors (follow_id, fill_id, order_id, client_order_id, price)
      VALUES
        ('follow-a', 'fill-open', ${ORDER_OPEN}, 'c-open', 100),
        ('follow-a', 'fill-filled', ${ORDER_FILLED}, 'c-filled', 100),
        ('follow-a', 'fill-missing', 'missing-order', 'c-missing', 100),
        ('follow-b', 'fill-other', ${ORDER_OTHER}, 'c-other', 100)
    `;
    const store = new SqlCopyFollowStore(db!.sql);
    expect(await store.countOpenMirrors('follow-a')).toBe(2);
    expect(await store.countOpenMirrors('follow-b')).toBe(1);
  });
});
