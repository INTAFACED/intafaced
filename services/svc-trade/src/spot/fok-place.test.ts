import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';

import { installFokPlace } from './fok-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

installFokPlace(TradeService);

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade fok-place is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const MAKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade fok-place (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('FOK place through matching', () => {
    let ledger: MemoryLedger;
    let matching: StubMatching;
    let trade: TradeService;
    let btcusdt: Market;

    async function fund(userId: string, assetId: string, amount: string) {
      await ledger.post(
        recipes.deposit({
          userId,
          assetId,
          amount: amt(amount),
          rail: 'test',
          railRef: `${userId}:${assetId}:${amount}:${Math.random()}`,
        }),
      );
    }
    const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
    const heldFor = async (userId: string, assetId: string, orderId: string) =>
      formatAmount((await ledger.balance(orderHoldAccount(userId, assetId, orderId))).amount);
    const postsWithReason = (reason: string) => ledger.journal().filter((tx) => tx.reason === reason);

    beforeEach(async () => {
      await sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      matching = new StubMatching();
      trade = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 200,
      });
      btcusdt = await trade.listMarket({
        symbol: 'BTC/USDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: amt('1000'),
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
      });
    });

    it('fills completely — tif FOK, no leftover rest', async () => {
      await fund(ALICE, 'USDT', '500');
      matching.scriptFills([{ makerOrderId: MAKER, makerAccountId: 'mm', price: '100', qty: '1' }]);
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        tif: 'FOK',
        clientOrderId: 'fok-full',
      });
      expect(order.status).not.toBe('open');
      expect(matching.submitted[0]?.request.tif).toBe('FOK');
      expect(matching.submitted[0]?.request.price).toBe('100');
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
    });

    it('matching fok_unfillable rejects the whole — no invented fill, hold released', async () => {
      await fund(ALICE, 'USDT', '500');
      matching.scriptRejection('fok_unfillable', 'fill-or-kill order cannot be filled in full');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('3'),
        price: amt('100'),
        tif: 'FOK',
        clientOrderId: 'fok-short',
      });
      expect(order.status).toBe('rejected');
      expect(order.rejectCode).toBe('fok_unfillable');
      expect(matching.submitted[0]?.request.tif).toBe('FOK');
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('500');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('matching-invented FOK rest is cancelled — no leftover', async () => {
      await fund(ALICE, 'USDT', '500');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        tif: 'FOK',
        clientOrderId: 'fok-invented',
      });
      expect(order.status).toBe('cancelled');
      expect(matching.submitted[0]?.request.tif).toBe('FOK');
      expect(matching.cancelledOrders).toContain(order.id);
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
    });

    it('tif FOK without price throws trade.invalid_tif — no submit, no invented fill', async () => {
      await fund(ALICE, 'USDT', '500');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          tif: 'FOK',
          clientOrderId: 'fok-no-price',
        }),
      ).rejects.toMatchObject({ code: 'trade.invalid_tif' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('500');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('plain GTC still rests leftover', async () => {
      await fund(ALICE, 'USDT', '500');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'gtc-plain',
      });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.tif).toBe('GTC');
      expect(matching.submitted[0]?.request.tif).not.toBe('FOK');
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('100');
    });
  });
});
