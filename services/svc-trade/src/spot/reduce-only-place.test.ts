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
import { bindReduceOnly, installReduceOnlyPlace } from './reduce-only-place.js';
import { carryPlacementBody } from './placement-extras.js';
import { bindBracket, readBracketFromBody } from './bracket-place.js';
import { bindOco, readOcoFromBody } from './oco-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';

installReduceOnlyPlace(TradeService);

describe('a request carries its bracket and OCO legs to the order', () => {
  it('a bracket body restores its legs through bindBracket and is not also read as an OCO', () => {
    const body: Record<string, unknown> = {
      bracket: true,
      takeProfit: '110',
      stopLoss: '90',
      clientOrderId: 'brkt-hitch',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '100',
    };
    const carried = carryPlacementBody({ clientOrderId: 'brkt-hitch', side: 'buy', type: 'limit', qty: amt('1') } as PlaceOrderInput, body);
    const bound = bindBracket(carried);
    expect(bound.bracket).toBe(true);
    expect(bound.takeProfit).toEqual({ stopPrice: '110' });
    expect(bound.stopLoss).toEqual({ stopPrice: '90' });
    expect(readOcoFromBody(body)).toBeNull();
    expect(bindOco(carried).oco).toBeUndefined();
  });

  it('refuses IEEE 0.1 on a bracket body instead of placing GTC', () => {
    const body: Record<string, unknown> = { bracket: true, takeProfit: 0.1, stopLoss: '90', clientOrderId: 'brkt-hitch-ieee' };
    expect(() => readBracketFromBody(body)).toThrow(expect.objectContaining({ code: 'trade.ieee_money' }));
    expect(body.bracket).toBe(true);
  });

  it('an OCO body restores its legs through bindOco', () => {
    const body: Record<string, unknown> = { oco: true, takeProfit: '110', stopLoss: '90', clientOrderId: 'oco-hitch' };
    expect(readBracketFromBody(body)).toBeNull();
    const bound = bindOco(
      carryPlacementBody({ clientOrderId: 'oco-hitch', side: 'sell', type: 'limit', qty: amt('1') } as PlaceOrderInput, body),
    );
    expect(bound.oco).toBe(true);
    expect(bound.takeProfit).toEqual({ stopPrice: '110' });
  });

  it('a reduce-only body reaches bindReduceOnly and nothing else does', () => {
    const input = { clientOrderId: 'ro-1', side: 'sell', type: 'limit', qty: amt('1') } as PlaceOrderInput;
    expect(bindReduceOnly(carryPlacementBody(input, { reduceOnly: true, clientOrderId: 'ro-1' })).reduceOnly).toBe(true);
    expect(bindReduceOnly(carryPlacementBody(input, { clientOrderId: 'ro-1' })).reduceOnly).toBeUndefined();
    expect(bindReduceOnly(input).reduceOnly).toBeUndefined();
  });
});

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
      `H8a: svc-trade reduce-only-place is PG-hard (no skip-green). ` +
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

describe('svc-trade reduce-only-place (H8a PG-hard)', () => {
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

  describe('reduce-only place through matching', () => {
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

    it('forwards reduceOnly to matching — no invented mark', async () => {
      await fund(ALICE, 'BTC', '2');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'ro-rest',
        reduceOnly: true,
      } as Parameters<TradeService['placeOrder']>[1] & { reduceOnly: boolean });
      expect(order.status).toBe('open');
      expect(matching.submitted).toHaveLength(1);
      expect(matching.submitted[0]?.request.reduceOnly).toBe(true);
      expect(await heldFor(ALICE, 'BTC', order.id)).toBe('1');
      expect(await avail(ALICE, 'BTC')).toBe('1');
    });

    it('refuses would_increase_position from matching and releases the hold — no invented mark', async () => {
      await fund(ALICE, 'USDT', '500');
      matching.script1(() => ({
        accepted: false,
        sequence: null,
        fills: [],
        resting: null,
        rejected: { code: 'would_increase_position', message: 'reduce-only would increase the position' },
        cancellations: [],
        triggered: [],
      }));
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'ro-increase',
        reduceOnly: true,
      } as Parameters<TradeService['placeOrder']>[1] & { reduceOnly: boolean });
      expect(order.status).toBe('rejected');
      expect(order.rejectCode).toBe('would_increase_position');
      expect(matching.submitted[0]?.request.reduceOnly).toBe(true);
      expect(await heldFor(ALICE, 'USDT', order.id)).toBe('0');
      expect(await avail(ALICE, 'USDT')).toBe('500');
      expect(postsWithReason('order.hold.released')).toHaveLength(1);
    });

    it('GTC never grows a reduceOnly flag', async () => {
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
      expect(matching.submitted[0]?.request.reduceOnly).toBeUndefined();
    });
  });
});
