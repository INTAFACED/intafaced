import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';

import { installGtdGttPlace } from './gtd-gtt-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

installGtdGttPlace(TradeService);

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
      `H8a: svc-trade gtd-gtt-place is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const EXPIRE = '2026-08-25T18:00:00.000Z';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade gtd-gtt-place (H8a PG-hard)', () => {
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

  describe('GTD/GTT place through the matching clock', () => {
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

    it('rests a GTD and forwards expireAt to matching — no invented expiry', async () => {
      await fund(ALICE, 'USDT', '500');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        tif: 'GTD',
        expireAt: EXPIRE,
        clientOrderId: 'gtd-rest',
      } as Parameters<TradeService['placeOrder']>[1] & { expireAt: string });
      expect(order.status).toBe('open');
      expect(matching.submitted).toHaveLength(1);
      expect(matching.submitted[0]?.request.tif).toBe('GTD');
      expect(matching.submitted[0]?.request.expireAt).toBe(EXPIRE);
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('100');
      expect(await avail(ALICE, 'USDT')).toBe('400');
    });

    it('refuses GTT when expireAt is missing — no hold, no invented EOD', async () => {
      await fund(ALICE, 'USDT', '500');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          tif: 'GTT',
          clientOrderId: 'gtt-no-expire',
        }),
      ).rejects.toMatchObject({ code: 'trade.missing_expire_at' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('500');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('refuses when matching has no engine clock and releases the hold', async () => {
      await fund(ALICE, 'USDT', '500');
      matching.script1((request) => ({
        accepted: false,
        sequence: null,
        fills: [],
        resting: null,
        rejected: { code: 'engine_clock_missing', message: 'GTD/GTT expires on the engine clock' },
        cancellations: [],
        triggered: [],
      }));
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        tif: 'GTD',
        expireAt: EXPIRE,
        clientOrderId: 'gtd-no-clock',
      } as Parameters<TradeService['placeOrder']>[1] & { expireAt: string });
      expect(order.status).toBe('rejected');
      expect(order.rejectCode).toBe('engine_clock_missing');
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('500');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('releases the hold through ledger-client when matching reports expired', async () => {
      await fund(ALICE, 'USDT', '500');
      const resting = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        tif: 'GTD',
        expireAt: EXPIRE,
        clientOrderId: 'gtd-then-expire',
      } as Parameters<TradeService['placeOrder']>[1] & { expireAt: string });
      expect(resting.status).toBe('open');
      expect(await heldFor(ALICE, 'USDT', resting.id)).toBe('100');

      matching.script1((request, next) => {
        const sequence = next();
        return {
          accepted: true,
          sequence,
          fills: [],
          resting: {
            kind: 'book' as const,
            orderId: request.orderId,
            accountId: request.accountId,
            side: request.side,
            price: request.price ?? '0',
            remaining: request.qty,
            sequence,
            version: 1,
          },
          rejected: null,
          cancellations: [
            {
              orderId: resting.id,
              accountId: ALICE,
              remainingQty: '1',
              sequence: next(),
              reason: 'expired',
            },
          ],
          triggered: [],
        };
      });

      await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('99'),
        clientOrderId: 'later-clock',
      });

      const expired = await trade.getOrder(principalFor(ALICE), resting.id);
      expect(expired.status).toBe('expired');
      expect(await heldFor(ALICE, 'USDT', resting.id)).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('401');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });
  });
});
