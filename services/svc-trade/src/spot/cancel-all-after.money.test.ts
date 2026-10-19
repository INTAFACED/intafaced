import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import './cancel-all-after.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import { TradeError, type Market } from './types.js';

type Armable = {
  armCancelAllAfter(
    principal: ReturnType<typeof principalFor>,
    timeoutSec: number,
    published: readonly number[] | null,
    graceMs?: number,
  ): Promise<{ armed: boolean; timeoutSec: number; deadline: Date | null }>;
  sweepCancelAllAfter(): Promise<{ examined: number; fired: number; unavailable: number; failed: number }>;
};

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_caa_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    throw new Error(
      `svc-trade cancel-all-after is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const PUBLISHED = [0, 10, 60] as const;

describe('svc-trade spot cancel-all-after dead-man switch (PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let trade: TradeService;
  let btcusdt: Market;
  let clock = new Date('2026-10-19T12:00:00Z');

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const caa = () => trade as unknown as Armable;
  const principal = (userId: string, ttlMs = 3_600_000) => ({ ...principalFor(userId), expiresAt: new Date(clock.getTime() + ttlMs) });
  const tick = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: `${userId}:${assetId}:${amount}` }));
  }
  const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  const rest = (userId: string, clientOrderId: string, price = '100') =>
    trade.placeOrder(principalFor(userId), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt(price),
      clientOrderId,
    });
  const statusOf = async (id: string) =>
    (await sql<Array<{ status: string }>>`SELECT status FROM trade.orders WHERE id = ${id}`)[0]?.status;
  const rowCount = async () => (await sql`SELECT 1 FROM trade.cancel_all_after`).length;

  beforeEach(async () => {
    await sql`TRUNCATE trade.cancel_all_after, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    clock = new Date('2026-10-19T12:00:00Z');
    ledger = new MemoryLedger();
    matching = new StubMatching();
    trade = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
      now: () => clock,
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
      makerBps: 0,
      takerBps: 0,
    });
    await fund(ALICE, 'USDT', '1000');
    await fund(BOB, 'USDT', '1000');
  });

  it('cancels every open order of the user after the deadline and releases the holds, and only that user', async () => {
    const a1 = await rest(ALICE, 'a-1');
    const a2 = await rest(ALICE, 'a-2', '99');
    const b1 = await rest(BOB, 'b-1');
    expect(await avail(ALICE, 'USDT')).toBe('801');
    await caa().armCancelAllAfter(principal(ALICE), 10, PUBLISHED);

    tick(9_000);
    expect(await caa().sweepCancelAllAfter()).toMatchObject({ examined: 0, fired: 0 });
    expect(await statusOf(a1.id)).toBe('open');

    tick(1_000);
    expect(await caa().sweepCancelAllAfter()).toMatchObject({ fired: 1, failed: 0 });
    expect(await statusOf(a1.id)).toBe('cancelled');
    expect(await statusOf(a2.id)).toBe('cancelled');
    expect(await statusOf(b1.id)).toBe('open');
    expect(await avail(ALICE, 'USDT')).toBe('1000');
    expect(await rowCount()).toBe(0);
    // Idempotent: a second pass finds nothing.
    expect(await caa().sweepCancelAllAfter()).toMatchObject({ examined: 0, fired: 0 });
  });

  it('re-arming pushes the deadline out; the earlier deadline no longer fires', async () => {
    const a1 = await rest(ALICE, 'a-1');
    await caa().armCancelAllAfter(principal(ALICE), 10, PUBLISHED);
    tick(8_000);
    const again = await caa().armCancelAllAfter(principal(ALICE), 10, PUBLISHED);
    expect(again.deadline?.getTime()).toBe(clock.getTime() + 10_000);
    tick(5_000);
    expect(await caa().sweepCancelAllAfter()).toMatchObject({ fired: 0 });
    expect(await statusOf(a1.id)).toBe('open');
    tick(5_000);
    expect(await caa().sweepCancelAllAfter()).toMatchObject({ fired: 1 });
    expect(await statusOf(a1.id)).toBe('cancelled');
  });

  it('timeout 0 disarms and cancels nothing, even when the owner published no timeouts', async () => {
    const a1 = await rest(ALICE, 'a-1');
    await caa().armCancelAllAfter(principal(ALICE), 10, PUBLISHED);
    const off = await caa().armCancelAllAfter(principal(ALICE), 0, null);
    expect(off).toMatchObject({ armed: false, deadline: null });
    expect(await rowCount()).toBe(0);
    tick(60_000);
    expect(await caa().sweepCancelAllAfter()).toMatchObject({ examined: 0, fired: 0 });
    expect(await statusOf(a1.id)).toBe('open');
  });

  it('refuses a blank published set and an unpublished timeout, arming nothing', async () => {
    await expect(caa().armCancelAllAfter(principal(ALICE), 10, null)).rejects.toMatchObject({ code: 'trade.cancel_all_after_unset' });
    await expect(caa().armCancelAllAfter(principal(ALICE), 15, PUBLISHED)).rejects.toMatchObject({
      code: 'trade.cancel_all_after_rejected',
    });
    await expect(caa().armCancelAllAfter(principal(ALICE), -5, PUBLISHED)).rejects.toMatchObject({
      code: 'trade.cancel_all_after_rejected',
    });
    expect(await rowCount()).toBe(0);
  });

  it('refuses without trade:write and when the credential would lapse before the deadline', async () => {
    await expect(caa().armCancelAllAfter(principalFor(ALICE, ['trade:read']), 10, PUBLISHED)).rejects.toBeInstanceOf(Error);
    await expect(caa().armCancelAllAfter(principal(ALICE, 5_000), 10, PUBLISHED)).rejects.toMatchObject({
      code: 'trade.cancel_all_after_rejected',
    });
    await expect(caa().armCancelAllAfter({ ...principalFor(ALICE), expiresAt: undefined } as never, 10, PUBLISHED)).rejects.toMatchObject({
      code: 'trade.cancel_all_after_rejected',
    });
    expect(await rowCount()).toBe(0);
  });

  it('a pass that could not finish keeps the countdown and the next pass completes it', async () => {
    const a1 = await rest(ALICE, 'a-1');
    await caa().armCancelAllAfter(principal(ALICE), 10, PUBLISHED);
    tick(10_000);
    const realCancel = matching.cancel.bind(matching);
    matching.cancel = async () => {
      throw new Error('cancel transport timed out');
    };
    const first = await caa().sweepCancelAllAfter();
    expect(first.fired).toBe(0);
    expect(first.failed).toBe(1);
    expect(await rowCount()).toBe(1);
    // An unresolved cancel releases nothing: the funds stay held until the engine's answer is known.
    expect(await statusOf(a1.id)).not.toBe('cancelled');
    expect(await avail(ALICE, 'USDT')).toBe('900');
    matching.cancel = realCancel;
    expect(await caa().sweepCancelAllAfter()).toMatchObject({ fired: 1, failed: 0 });
    expect(await statusOf(a1.id)).toBe('cancelled');
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it('a re-arm that lands during the cancel pass is not erased by it', async () => {
    await rest(ALICE, 'a-1');
    await caa().armCancelAllAfter(principal(ALICE), 10, PUBLISHED);
    tick(10_000);
    // The pass reads the due row, then the trader re-arms before it finishes.
    const realCancel = matching.cancel.bind(matching);
    matching.cancel = async (...args: Parameters<typeof matching.cancel>) => {
      await caa().armCancelAllAfter(principal(ALICE), 60, PUBLISHED);
      return realCancel(...args);
    };
    await caa().sweepCancelAllAfter();
    matching.cancel = realCancel;
    expect(await rowCount()).toBe(1);
  });

  it('counts a countdown whose stored authority has lapsed, cancels nothing, and stops retrying it', async () => {
    const a1 = await rest(ALICE, 'a-1');
    await caa().armCancelAllAfter(principal(ALICE, 10_000), 10, PUBLISHED);
    tick(11_000);
    const swept = await caa().sweepCancelAllAfter();
    expect(swept).toMatchObject({ fired: 0, unavailable: 1 });
    expect(await statusOf(a1.id)).toBe('open');
    expect(await rowCount()).toBe(0);
  });
});

describe('cancel-all-after error shapes', () => {
  it('uses TradeError so the REST layer maps it', () => {
    expect(new TradeError('x', 'trade.cancel_all_after_rejected').code).toBe('trade.cancel_all_after_rejected');
  });
});
