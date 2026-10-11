import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';

import { installNativeQtyUpAmend } from './qty-up-amend.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

installNativeQtyUpAmend(TradeService);

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
      `H8a: svc-trade qty-up-amend is PG-hard (no skip-green). ` +
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

describe('svc-trade qty-up-amend (H8a PG-hard)', () => {
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

  describe('native amend qty-up', () => {
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
    async function rest(qty: string, price: string, clientOrderId: string) {
      return trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt(qty),
        price: amt(price),
        clientOrderId,
      });
    }

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

    it('takes extra ledger hold then PATCHes matching', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest('2', '100', 'native-qty-up');
      const outcome = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('3') });
      expect(outcome).toMatchObject({
        accepted: true,
        code: 'AMENDED',
        path: 'NATIVE_AMEND',
        reconciliationRequired: false,
      });
      expect(outcome.order.qty).toBe(amt('3'));
      expect(outcome.order.holdAmount).toBe(amt('300'));
      expect(matching.amended).toHaveLength(1);
      expect(matching.amended[0]?.request.qty).toBe('3');
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('300');
      expect(await avail(ALICE, 'USDT')).toBe('700');
      expect(postsWithReason('order.hold.amend')).toHaveLength(1);
    });

    it('refuses when the extra hold cannot be taken', async () => {
      await fund(ALICE, 'USDT', '200');
      const original = await rest('2', '100', 'native-qty-up-broke');
      const outcome = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('3') });
      expect(outcome).toMatchObject({
        accepted: false,
        code: 'NOT_AMENDABLE',
        reasonCode: 'ledger.insufficient_funds',
        path: 'NATIVE_AMEND',
      });
      expect(matching.amended).toHaveLength(0);
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
      expect(postsWithReason('order.hold.amend')).toHaveLength(0);
    });

    it('releases the extra hold when matching refuses', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest('2', '100', 'native-qty-up-refuse');
      matching.amendScript = async () => ({
        accepted: false,
        orderId: original.id,
        sequence: null,
        version: 1,
        priority: null,
        fills: [],
        resting: null,
        rejected: { code: 'version_mismatch', message: 'stale' },
        cancellations: [],
        triggered: [],
      });
      const outcome = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('3') });
      expect(outcome).toMatchObject({ accepted: false, code: 'VERSION_MISMATCH', path: 'NATIVE_AMEND' });
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('200');
      expect(await avail(ALICE, 'USDT')).toBe('800');
      expect(postsWithReason('order.hold.amend')).toHaveLength(1);
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('returns the extra hold when a qty-up is refused after a qty-down already released that version', async () => {
      await fund(ALICE, 'USDT', '1000');
      const original = await rest('2', '100', 'native-qty-up-after-down');
      const down = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('1') });
      expect(down).toMatchObject({ accepted: true, code: 'AMENDED' });
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('100');
      expect(await avail(ALICE, 'USDT')).toBe('900');
      matching.amendScript = async () => ({
        accepted: false,
        orderId: original.id,
        sequence: null,
        version: down.order.engineVersion,
        priority: null,
        fills: [],
        resting: null,
        rejected: { code: 'version_mismatch', message: 'stale' },
        cancellations: [],
        triggered: [],
      });
      const up = await trade.amendOrder(principalFor(ALICE), original.id, { qty: amt('2') });
      expect(up).toMatchObject({ accepted: false, code: 'VERSION_MISMATCH' });
      expect(await heldFor(ALICE, 'USDT', original.id)).toBe('100');
      expect(await avail(ALICE, 'USDT')).toBe('900');
    });
  });
});
