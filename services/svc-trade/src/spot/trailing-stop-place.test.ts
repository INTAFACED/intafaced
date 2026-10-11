import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';

import { installTrailingStopPlace } from './trailing-stop-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

installTrailingStopPlace(TradeService);

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
      `H8a: svc-trade trailing-stop-place is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade trailing-stop-place (H8a PG-hard)', () => {
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

  describe('trailing stop place through matching', () => {
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

    it('place trailing stop with trail + mark — accepted, forwarded as stop', async () => {
      await fund(ALICE, 'BTC', '20');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        clientOrderId: 'ts-rest',
        trail: amt('5'),
        mark: amt('100'),
      } as Parameters<TradeService['placeOrder']>[1] & { trail: ReturnType<typeof amt>; mark: ReturnType<typeof amt> });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.type).toBe('stop');
      expect(matching.submitted[0]?.request.trail).toBe('5');
      expect(matching.submitted[0]?.request.mark).toBe('100');
      expect(matching.submitted[0]?.request.price).toBeNull();
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('10');
    });

    it('trail present as null throws trade.missing_trail — no submit, no hold', async () => {
      await fund(ALICE, 'BTC', '20');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'sell',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'ts-miss',
          trail: null,
          mark: amt('100'),
        } as Parameters<TradeService['placeOrder']>[1] & { trail: null; mark: ReturnType<typeof amt> }),
      ).rejects.toMatchObject({ code: 'trade.missing_trail' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'BTC')).toBe('20');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('mark present as null throws trade.missing_mark — no invented mark', async () => {
      await fund(ALICE, 'BTC', '20');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'sell',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'ts-nomark',
          trail: amt('5'),
          mark: null,
        } as Parameters<TradeService['placeOrder']>[1] & { trail: ReturnType<typeof amt>; mark: null }),
      ).rejects.toMatchObject({ code: 'trade.missing_mark' });
      expect(matching.submitted).toHaveLength(0);
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('matching scriptRejection missing_trail rejects — hold released', async () => {
      await fund(ALICE, 'BTC', '20');
      matching.scriptRejection('missing_trail', 'a trailing stop requires a trail');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        clientOrderId: 'ts-engine',
        trail: amt('5'),
        mark: amt('100'),
      } as Parameters<TradeService['placeOrder']>[1] & { trail: ReturnType<typeof amt>; mark: ReturnType<typeof amt> });
      expect(order.status).toBe('rejected');
      expect(order.rejectCode).toBe('missing_trail');
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('0');
      expect(await avail(ALICE, 'BTC')).toBe('20');
    });

    it('plain GTC does not set trail or mark on the request', async () => {
      await fund(ALICE, 'USDT', '2000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'gtc-plain',
      });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.type).toBe('limit');
      expect(matching.submitted[0]?.request.trail).toBeUndefined();
      expect(matching.submitted[0]?.request.mark).toBeUndefined();
    });
  });
});
