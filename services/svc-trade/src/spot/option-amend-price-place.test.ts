import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';

import { installOptionAmend, installOptionPlace } from './option-place.js';
import { installNativeQtyUpAmend } from './qty-up-amend.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

installNativeQtyUpAmend(TradeService);
installOptionPlace(TradeService);
installOptionAmend(TradeService);

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
      `H8a: svc-trade option-amend-price-place is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const EXPIRY = '2026-12-25T00:00:00.000Z';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade option-amend-price-place (H8a PG-hard)', () => {
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

  describe('option amend price through matching', () => {
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

    async function restOption(clientOrderId: string) {
      return trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'option',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId,
        strike: amt('100'),
        expiry: EXPIRY,
      } as Parameters<TradeService['placeOrder']>[1] & {
        type: 'option';
        strike: ReturnType<typeof amt>;
        expiry: string;
      });
    }

    it('forwards strike + expiry + price through matching — mark is stripped', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await restOption('opt-amend-price');
      const outcome = await trade.amendOrder(principalFor(ALICE), original.id, {
        price: amt('101'),
        strike: amt('100'),
        expiry: EXPIRY,
        mark: '50',
      } as Parameters<TradeService['amendOrder']>[2] & {
        strike: ReturnType<typeof amt>;
        expiry: string;
        mark: string;
      });
      expect(outcome).toMatchObject({
        accepted: true,
        code: 'AMENDED',
        path: 'NATIVE_AMEND',
      });
      expect(outcome.order.price).toBe(amt('101'));
      expect(matching.amended).toHaveLength(1);
      const req = matching.amended[0]?.request as {
        price?: string;
        strike?: string | null;
        expiry?: string | null;
        mark?: string | null;
      };
      expect(req.price).toBe('101');
      expect(req.strike).toBe('100');
      expect(req.expiry).toBe(EXPIRY);
      expect(req.mark).toBeUndefined();
    });

    it('refuses a missing strike — no PATCH, no invented mark', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await restOption('opt-amend-price-miss-strike');
      await expect(
        trade.amendOrder(principalFor(ALICE), original.id, {
          price: amt('101'),
          expiry: EXPIRY,
          mark: '50',
        } as Parameters<TradeService['amendOrder']>[2] & { expiry: string; mark: string }),
      ).rejects.toMatchObject({ code: 'trade.missing_strike' });
      expect(matching.amended).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
      expect(await avail(ALICE, 'USDT')).toBe('800');
    });

    it('refuses a missing expiry — no PATCH, no invented mark', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await restOption('opt-amend-price-miss-expiry');
      await expect(
        trade.amendOrder(principalFor(ALICE), original.id, {
          price: amt('101'),
          strike: amt('100'),
          mark: '50',
        } as Parameters<TradeService['amendOrder']>[2] & { strike: ReturnType<typeof amt>; mark: string }),
      ).rejects.toMatchObject({ code: 'trade.missing_expiry' });
      expect(matching.amended).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
    });

    it('refuses a missing price — no PATCH, no invented mark', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await restOption('opt-amend-price-miss-price');
      await expect(
        trade.amendOrder(principalFor(ALICE), original.id, {
          strike: amt('100'),
          expiry: EXPIRY,
          price: null,
          mark: '50',
        } as Parameters<TradeService['amendOrder']>[2] & {
          strike: ReturnType<typeof amt>;
          expiry: string;
          price: null;
          mark: string;
        }),
      ).rejects.toMatchObject({ code: 'trade.missing_price' });
      expect(matching.amended).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
    });

    it('plain GTC qty-up does not set strike, expiry, or option price', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'gtc-qty-up',
      });
      const outcome = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('3') });
      expect(outcome).toMatchObject({ accepted: true, code: 'AMENDED' });
      expect(matching.amended).toHaveLength(1);
      const req = matching.amended[0]?.request as { strike?: string | null; expiry?: string | null };
      expect(req.strike).toBeUndefined();
      expect(req.expiry).toBeUndefined();
      expect(matching.amended[0]?.request.qty).toBe('3');
    });
  });
});
