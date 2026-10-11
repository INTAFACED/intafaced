import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';

import { installOptionPlace } from './option-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

installOptionPlace(TradeService);

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
      `H8a: svc-trade option-place is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const EXPIRY = '2026-12-25';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade option-place (H8a PG-hard)', () => {
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

  describe('option place through matching', () => {
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

    it('place option with strike + expiry — accepted, forwarded same pair', async () => {
      await fund(ALICE, 'USDT', '2000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'option',
        qty: amt('10'),
        price: amt('99'),
        clientOrderId: 'opt-rest',
        strike: amt('100'),
        expiry: EXPIRY,
      } as Parameters<TradeService['placeOrder']>[1] & {
        type: 'option';
        strike: ReturnType<typeof amt>;
        expiry: string;
      });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.type).toBe('option');
      expect(matching.submitted[0]?.request.strike).toBe('100');
      expect(matching.submitted[0]?.request.expiry).toBe(EXPIRY);
      expect(matching.submitted[0]?.request.price).toBe('99');
      expect(matching.submitted[0]?.request.mark).toBeUndefined();
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('990');
    });

    it('type option without strike throws trade.missing_strike — no submit, no hold', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'option',
          qty: amt('10'),
          price: amt('99'),
          clientOrderId: 'opt-miss-strike',
          expiry: EXPIRY,
        } as Parameters<TradeService['placeOrder']>[1] & { type: 'option'; expiry: string }),
      ).rejects.toMatchObject({ code: 'trade.missing_strike' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('type option without expiry throws trade.missing_expiry — no submit, no hold', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'option',
          qty: amt('10'),
          price: amt('99'),
          clientOrderId: 'opt-miss-expiry',
          strike: amt('100'),
        } as Parameters<TradeService['placeOrder']>[1] & { type: 'option'; strike: ReturnType<typeof amt> }),
      ).rejects.toMatchObject({ code: 'trade.missing_expiry' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('strike present as null throws trade.missing_strike — no invented mark', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('99'),
          clientOrderId: 'opt-null-strike',
          strike: null,
          expiry: EXPIRY,
        } as Parameters<TradeService['placeOrder']>[1] & { strike: null; expiry: string }),
      ).rejects.toMatchObject({ code: 'trade.missing_strike' });
      expect(matching.submitted).toHaveLength(0);
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('expiry present as blank throws trade.missing_expiry — no invented mark', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('99'),
          clientOrderId: 'opt-blank-expiry',
          strike: amt('100'),
          expiry: '  ',
        } as Parameters<TradeService['placeOrder']>[1] & { strike: ReturnType<typeof amt>; expiry: string }),
      ).rejects.toMatchObject({ code: 'trade.missing_expiry' });
      expect(matching.submitted).toHaveLength(0);
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('matching scriptRejection missing_strike rejects — hold released', async () => {
      await fund(ALICE, 'USDT', '2000');
      matching.scriptRejection('missing_strike', 'an option requires a strike');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('99'),
        clientOrderId: 'opt-engine',
        strike: amt('100'),
        expiry: EXPIRY,
      } as Parameters<TradeService['placeOrder']>[1] & {
        strike: ReturnType<typeof amt>;
        expiry: string;
      });
      expect(order.status).toBe('rejected');
      expect(order.rejectCode).toBe('missing_strike');
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('2000');
    });

    it('plain GTC does not set strike or expiry on the request', async () => {
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
      expect(matching.submitted[0]?.request.strike).toBeUndefined();
      expect(matching.submitted[0]?.request.expiry).toBeUndefined();
    });
  });

  describe('option exercise through matching', () => {
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

    it('exercise with strike + expiry — accepted, forwards exercise true at strike', async () => {
      await fund(ALICE, 'USDT', '2000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        clientOrderId: 'opt-ex',
        strike: amt('100'),
        expiry: EXPIRY,
        exercise: true,
      } as Parameters<TradeService['placeOrder']>[1] & {
        strike: ReturnType<typeof amt>;
        expiry: string;
        exercise: true;
      });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.exercise).toBe(true);
      expect(matching.submitted[0]?.request.strike).toBe('100');
      expect(matching.submitted[0]?.request.expiry).toBe(EXPIRY);
      expect(matching.submitted[0]?.request.mark).toBeUndefined();
    });

    it('exercise missing strike throws trade.missing_strike — no submit, no hold', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          clientOrderId: 'opt-ex-miss-strike',
          expiry: EXPIRY,
          exercise: true,
        } as Parameters<TradeService['placeOrder']>[1] & { expiry: string; exercise: true }),
      ).rejects.toMatchObject({ code: 'trade.missing_strike' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('exercise missing expiry throws trade.missing_expiry — no submit, no hold', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          clientOrderId: 'opt-ex-miss-expiry',
          strike: amt('100'),
          exercise: true,
        } as Parameters<TradeService['placeOrder']>[1] & { strike: ReturnType<typeof amt>; exercise: true }),
      ).rejects.toMatchObject({ code: 'trade.missing_expiry' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('exercise with mark 50 still forwards strike 100 and exercise true — mark not used', async () => {
      await fund(ALICE, 'USDT', '2000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        clientOrderId: 'opt-ex-mark',
        strike: amt('100'),
        expiry: EXPIRY,
        exercise: true,
        mark: '50',
      } as Parameters<TradeService['placeOrder']>[1] & {
        strike: ReturnType<typeof amt>;
        expiry: string;
        exercise: true;
        mark: string;
      });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.exercise).toBe(true);
      expect(matching.submitted[0]?.request.strike).toBe('100');
      expect(matching.submitted[0]?.request.expiry).toBe(EXPIRY);
      expect(matching.submitted[0]?.request.mark).toBeUndefined();
    });

    it('plain GTC still does not set exercise', async () => {
      await fund(ALICE, 'USDT', '2000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'gtc-plain-ex',
      });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.type).toBe('limit');
      expect(matching.submitted[0]?.request.exercise).toBeUndefined();
    });
  });
});
