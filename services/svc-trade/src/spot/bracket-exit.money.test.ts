import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';
import './oco-place.js';
// The inner installers run after the bracket wrapper in production (index.ts), so they load first here.
import './post-only-place.js';
import './iceberg-place.js';
import './stop-limit-place.js';
import './bracket-place.js';
import './oco-cancel.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import { type Market } from './types.js';
import { carryPlacementBody } from './placement-extras.js';

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
      `H8a: svc-trade bracket-exit is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const tpOf = (id: string) => `${id}:tp`;
const slOf = (id: string) => `${id}:sl`;

describe('svc-trade bracket: entry, then one sell OCO for what was received (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let trade: TradeService;
  let btcusdt: Market;

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

  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: `${userId}:${assetId}:${amount}:${Math.random()}` }),
    );
  }
  const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  const heldFor = async (userId: string, assetId: string, orderId: string) =>
    formatAmount((await ledger.balance(orderHoldAccount(userId, assetId, orderId))).amount);

  beforeEach(async () => {
    await sql`TRUNCATE trade.order_bracket_intent, trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
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
      makerBps: 0,
      takerBps: 0,
    });
  });

  /** Bob rests a sell of 1 BTC at 100; Alice has quote to buy it. */
  async function setup() {
    await fund(BOB, 'BTC', '1');
    await fund(ALICE, 'USDT', '1000');
    const bob = await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'bob-sell-1',
    });
    return { bob };
  }

  const bracketReq = (extra: Record<string, unknown> = {}) =>
    ({
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      tif: 'IOC',
      clientOrderId: 'br-1',
      bracket: true,
      takeProfit: { stopPrice: '110' },
      stopLoss: { stopPrice: '90' },
      ...extra,
    }) as Parameters<TradeService['placeOrder']>[1];

  const exitSubmits = () => matching.submitted.filter((s) => (s.request as { oco?: boolean }).oco === true);

  it('places the sell OCO for the base actually received, once, after the entry fills', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    const entry = await trade.placeOrder(principalFor(ALICE), bracketReq());
    expect(entry.status).toBe('filled');
    const exits = exitSubmits();
    expect(exits).toHaveLength(1);
    const req = exits[0]!.request as { qty: string; takeProfit?: string; stopLoss?: string; side: string };
    expect(req.side).toBe('sell');
    expect(req.takeProfit).toBe('110');
    expect(req.stopLoss).toBe('90');
    // received = filled qty minus the base-side fee; never more than the account actually holds
    expect(Number(req.qty)).toBeLessThanOrEqual(1);
    expect(Number(req.qty)).toBeGreaterThan(0.99);
    const held = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE user_id = ${ALICE} AND side = 'sell'`;
    expect(held).toHaveLength(1);
    expect(await heldFor(ALICE, 'BTC', held[0]!.id)).toBe(req.qty);
  });

  it('a retry of the same request completes nothing twice: one entry, one exit', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    expect(exitSubmits()).toHaveLength(1);
    const buys = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE user_id = ${ALICE} AND side = 'buy'`;
    expect(buys).toHaveLength(1);
  });

  it('a partial fill sizes the exit to the received part only', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '0.4' }], { cancelRemainder: '0.6' });
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    const exits = exitSubmits();
    expect(exits).toHaveLength(1);
    expect(Number((exits[0]!.request as { qty: string }).qty)).toBeLessThanOrEqual(0.4);
    expect(Number((exits[0]!.request as { qty: string }).qty)).toBeGreaterThan(0.39);
  });

  it('an entry that fills nothing places no exit', async () => {
    await fund(ALICE, 'USDT', '1000');
    matching.script1((request, next) => ({
      accepted: true,
      sequence: next(),
      fills: [],
      resting: null,
      rejected: null,
      cancellations: [{ orderId: request.orderId, accountId: ALICE, remainingQty: '1', sequence: next(), reason: 'ioc_remainder' }],
      triggered: [],
    }));
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    expect(exitSubmits()).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it('refuses a resting entry: its exit could not be placed later without a stored grant', async () => {
    await fund(ALICE, 'USDT', '1000');
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq({ tif: 'GTC' }))).rejects.toMatchObject({
      code: 'trade.order_type_unsupported',
    });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it.each([
    ['a stop-limit entry', { type: 'stop_limit', stopPx: amt('90'), tif: 'IOC' }],
    ['an entry with a stop trigger', { stopPx: amt('90'), tif: 'IOC' }],
    ['an iceberg entry', { icebergQty: amt('0.1'), tif: 'IOC' }],
    ['a post-only entry', { postOnly: true, tif: 'IOC' }],
    ['a trailing-stop entry', { type: 'trailing_stop', tif: 'IOC' }],
  ])('refuses %s: it can sit dormant or rest, so its exit could not be placed on the fill', async (_name, extra) => {
    await fund(ALICE, 'USDT', '1000');
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq(extra as Record<string, unknown>))).rejects.toMatchObject({
      code: 'trade.order_type_unsupported',
    });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it.each([
    ['a stop trigger', { stopPx: '90' }],
    ['an iceberg', { iceberg: true, displayQty: '0.1' }],
    ['reduce-only', { reduceOnly: true }],
    ['a post-only flag', { postOnly: true }],
    ['an expiry', { expireAt: '2099-01-01T00:00:00Z' }],
  ])('refuses %s that only the request body carries: the inner installers would re-read it', async (_name, carried) => {
    await fund(ALICE, 'USDT', '1000');
    const input = carryPlacementBody(bracketReq() as never, { ...bracketReq(), ...carried }) as never;
    await expect(trade.placeOrder(principalFor(ALICE), input)).rejects.toMatchObject({
      code: 'trade.order_type_unsupported',
    });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it('a carried tif alias cannot turn the entry into a resting post-only order', async () => {
    await fund(ALICE, 'USDT', '1000');
    const input = carryPlacementBody(bracketReq() as never, { ...bracketReq(), timeInForce: 'IOC', tif: 'PO' }) as never;
    await trade.placeOrder(principalFor(ALICE), input);
    expect(matching.submitted[0]?.request).toMatchObject({ tif: 'IOC' });
  });

  it('refuses a sell-side entry', async () => {
    await fund(ALICE, 'BTC', '1');
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq({ side: 'sell' }))).rejects.toMatchObject({
      code: 'trade.order_type_unsupported',
    });
    expect(matching.submitted).toHaveLength(0);
  });

  it('a failed exit leaves the filled entry intact and a retry places the exit once', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    const realSubmit = matching.submit.bind(matching);
    let failExit = true;
    matching.submit = async (marketId, request) => {
      if ((request as { oco?: boolean }).oco === true && failExit) {
        failExit = false;
        throw new Error('svc-matching is unreachable');
      }
      return realSubmit(marketId, request);
    };
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq())).rejects.toBeDefined();
    const retried = await trade.placeOrder(principalFor(ALICE), bracketReq());
    expect(retried.status).toBe('filled');
    const sells = await sql<
      Array<{ id: string; status: string }>
    >`SELECT id, status FROM trade.orders WHERE user_id = ${ALICE} AND side = 'sell'`;
    // the failed submit leaves the exit in the existing recovery state; the retry must not open a second one
    expect(sells).toHaveLength(1);
    expect(await heldFor(ALICE, 'BTC', sells[0]!.id)).not.toBe('0');
    const intent = await sql<Array<{ exit_order_id: string | null }>>`SELECT exit_order_id FROM trade.order_bracket_intent`;
    expect(intent[0]?.exit_order_id).toBe(sells[0]!.id);
    const buys = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE user_id = ${ALICE} AND side = 'buy'`;
    expect(buys).toHaveLength(1);
  });

  it('the same client order id with different exit prices is refused', async () => {
    const { bob } = await setup();
    matching.scriptFills([{ makerOrderId: bob.id, makerAccountId: BOB, price: '100', qty: '1' }]);
    await trade.placeOrder(principalFor(ALICE), bracketReq());
    await expect(trade.placeOrder(principalFor(ALICE), bracketReq({ takeProfit: { stopPrice: '120' } }))).rejects.toBeDefined();
    expect(exitSubmits()).toHaveLength(1);
  });
});
