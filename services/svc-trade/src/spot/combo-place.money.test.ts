import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';
import { type PlaceOrderInput } from './trade-service.js';
import { installComboPlace } from './combo-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

/**
 * H4 trade half money proof — combo take/fill posts one hold/fill pair.
 * PG-hard: no postgresAvailable skip-green. CI uses TEST_DATABASE_URL.
 * Local without that env starts Testcontainers postgres:16-alpine.
 */

installComboPlace(TradeService);

const EXPIRY = '2026-12-31T00:00:00.000Z';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const PG_IMAGE = 'postgres:16-alpine';

function namedLegs(over: Record<string, unknown>[] = []) {
  const base = [
    { name: 'call', ratio: amt('1'), strike: amt('100'), expiry: EXPIRY },
    { name: 'put', ratio: amt('-1'), strike: amt('100'), expiry: EXPIRY },
  ];
  return base.map((leg, i) => ({ ...leg, ...(over[i] ?? {}) }));
}

type ComboInput = PlaceOrderInput & {
  combo?: boolean | null;
  legs?: ReturnType<typeof namedLegs> | null;
};

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openComboAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }
  try {
    const container = await new PostgreSqlContainer(PG_IMAGE)
      .withDatabase('intafaced_combo_h4_test')
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
      `H4 combo hold/fill is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${PG_IMAGE}: ${msg}`,
    );
  }
}

describe('combo hold/fill through ledger-client — one pair, not per-leg', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
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

  beforeAll(async () => {
    const admin = await openComboAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

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

  it('place combo — one order.hold, matching gets combo+legs as decimal strings', async () => {
    await fund(ALICE, 'USDT', '2000');
    const order = await trade.placeOrder(principalFor(ALICE), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('10'),
      price: amt('99'),
      clientOrderId: 'cmb-rest',
      combo: true,
      legs: namedLegs(),
    } as ComboInput);
    expect(order.status).toBe('open');
    expect(matching.submitted).toHaveLength(1);
    expect(matching.submitted[0]?.request.combo).toBe(true);
    expect(matching.submitted[0]?.request.legs).toEqual([
      { name: 'call', ratio: '1', strike: '100', expiry: EXPIRY },
      { name: 'put', ratio: '-1', strike: '100', expiry: EXPIRY },
    ]);
    expect(typeof matching.submitted[0]?.request.qty).toBe('string');
    expect(typeof matching.submitted[0]?.request.price).toBe('string');
    expect(typeof matching.submitted[0]?.request.legs?.[1]?.ratio).toBe('string');
    expect(await heldFor(ALICE, 'USDT', order.id)).toBe('990');
    expect(postsWithReason('order.hold')).toHaveLength(1);
    expect(postsWithReason('trade.fill')).toHaveLength(0);
  });

  it('combo without legs throws trade.missing_combo_legs — no submit, no hold', async () => {
    await fund(ALICE, 'USDT', '2000');
    await expect(
      trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('99'),
        clientOrderId: 'cmb-miss-legs',
        combo: true,
      } as ComboInput),
    ).rejects.toMatchObject({ code: 'trade.missing_combo_legs' });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('2000');
    expect(postsWithReason('order.hold')).toHaveLength(0);
  });

  it('combo legs with per-leg qty throws trade.combo_double_hold — no second hold invented', async () => {
    await fund(ALICE, 'USDT', '2000');
    await expect(
      trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('99'),
        clientOrderId: 'cmb-double',
        combo: true,
        legs: namedLegs([{ qty: amt('10') }]),
      } as ComboInput),
    ).rejects.toMatchObject({ code: 'trade.combo_double_hold' });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('2000');
    expect(postsWithReason('order.hold')).toHaveLength(0);
  });

  it('combo take/fill posts one trade.fill pair — not per-leg invented money', async () => {
    await fund(BOB, 'BTC', '20');
    await fund(ALICE, 'USDT', '2000');

    const maker = await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      qty: amt('10'),
      price: amt('99'),
      clientOrderId: 'cmb-maker',
      combo: true,
      legs: namedLegs(),
    } as ComboInput);
    expect(maker.status).toBe('open');
    expect(postsWithReason('order.hold')).toHaveLength(1);

    matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: BOB, price: '99', qty: '10' }]);

    const taker = await trade.placeOrder(principalFor(ALICE), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('10'),
      price: amt('99'),
      clientOrderId: 'cmb-taker',
      combo: true,
      legs: namedLegs(),
    } as ComboInput);

    expect(taker.status).toBe('filled');
    expect(matching.submitted).toHaveLength(2);
    expect(matching.submitted[1]?.request.combo).toBe(true);
    expect(matching.submitted[1]?.request.legs).toHaveLength(2);
    expect(postsWithReason('order.hold')).toHaveLength(2);
    expect(postsWithReason('trade.fill')).toHaveLength(1);
    expect(await heldFor(ALICE, 'USDT', taker.id)).toBe('0');
    expect(await heldFor(BOB, 'BTC', maker.id)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('plain GTC does not set combo or legs on the request', async () => {
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
    expect(matching.submitted[0]?.request.combo).toBeUndefined();
    expect(matching.submitted[0]?.request.legs).toBeUndefined();
  });

  it('matching combo_disagrees rejects — hold released, no fill', async () => {
    await fund(ALICE, 'USDT', '2000');
    matching.scriptRejection('combo_disagrees', 'a combo takes a resting combo');
    await expect(
      trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('99'),
        clientOrderId: 'cmb-disagree',
        combo: true,
        legs: namedLegs(),
      } as ComboInput),
    ).rejects.toMatchObject({ code: 'trade.combo_disagrees' });
    expect(postsWithReason('trade.fill')).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('2000');
  });
});
