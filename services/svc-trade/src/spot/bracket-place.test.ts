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
import {
  bindBracket,
  entryRefuse,
  installBracketPlace,
  stashBracketFromBody,
  stopLossRefuse,
  takeProfitRefuse,
  wantsBracket,
} from './bracket-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import { TradeError, type Market } from './types.js';

installBracketPlace(TradeService);

function thrownTrade(fn: () => void): TradeError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TradeError) return err;
    throw err;
  }
  throw new Error('expected TradeError');
}

describe('bracket place helpers', () => {
  it('gates only on bracket and refuses missing legs — no invented trigger', () => {
    expect(wantsBracket({})).toBe(false);
    expect(wantsBracket({ bracket: true })).toBe(true);
    expect(entryRefuse({ type: 'market' })).toBeNull();
    expect(entryRefuse({ type: 'limit' })?.code).toBe('trade.missing_price');
    expect(entryRefuse({ type: 'limit' })?.message).toContain('invent a trigger');
    expect(takeProfitRefuse(null)?.code).toBe('trade.missing_stop_price');
    expect(takeProfitRefuse(null)?.message).toContain('take-profit');
    expect(stopLossRefuse(null)?.code).toBe('trade.missing_stop_price');
    expect(stopLossRefuse(null)?.message).toContain('stop-loss');
    expect(takeProfitRefuse(amt('110'))).toBeNull();
    expect(stopLossRefuse(amt('90'))).toBeNull();
  });

  it('refuses a JSON number stopPrice — IEEE 0.1 is not a decimal string', () => {
    const err = thrownTrade(() => stashBracketFromBody({ bracket: true, takeProfit: 0.1, stopLoss: '90', clientOrderId: 'brkt-ieee' }));
    expect(err.code).toBe('trade.ieee_money');
    expect(err.message).toMatch(/JSON number/);
  });

  it('refuses a JSON number nested stopPrice', () => {
    const err = thrownTrade(() =>
      stashBracketFromBody({
        bracket: true,
        takeProfit: { stopPrice: 0.1 },
        stopLoss: { stopPrice: '90' },
        clientOrderId: 'brkt-ieee-nested',
      }),
    );
    expect(err.code).toBe('trade.ieee_money');
  });

  it('refuses bracket when clientOrderId is missing — does not strip-and-place', () => {
    const rec: Record<string, unknown> = { bracket: true, takeProfit: '110', stopLoss: '90' };
    const err = thrownTrade(() => stashBracketFromBody(rec));
    expect(err.code).toBe('trade.client_order_id_required');
    expect(rec.bracket).toBe(true);
    expect(rec.takeProfit).toBe('110');
    expect(rec.stopLoss).toBe('90');
  });

  it('does not String() a JSON number into a stopPrice', () => {
    const src = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.ts$/, '.ts'), 'utf8');
    expect(src).not.toMatch(/typeof raw === 'string' \|\| typeof raw === 'number'/);
    expect(src).not.toMatch(/String\(raw\)/);
  });

  it('stashes a decimal-string 0.1 and bindBracket restores it', () => {
    stashBracketFromBody({ bracket: true, takeProfit: '0.1', stopLoss: '90', clientOrderId: 'brkt-str-01' });
    const bound = bindBracket({
      clientOrderId: 'brkt-str-01',
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
    } as PlaceOrderInput);
    expect(bound.bracket).toBe(true);
    expect(bound.takeProfit).toEqual({ stopPrice: '0.1' });
    expect(bound.stopLoss).toEqual({ stopPrice: '90' });
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
      `H8a: svc-trade bracket-place is PG-hard (no skip-green). ` +
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

describe('svc-trade bracket-place (H8a PG-hard)', () => {
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

  describe('linked bracket through matching', () => {
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

    it('places one linked bracket through matching — no invented trigger', async () => {
      await fund(ALICE, 'USDT', '200');
      const placed = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'brkt-1',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
      } as Parameters<TradeService['placeOrder']>[1]);
      expect(placed.status).toBe('open');
      expect(matching.submitted).toHaveLength(1);
      const req = matching.submitted[0]?.request as {
        bracket?: boolean;
        oco?: boolean;
        takeProfit?: string | null;
        stopLoss?: string | null;
      };
      expect(req?.bracket).toBe(true);
      expect(req?.oco).toBeUndefined();
      expect(req?.takeProfit).toBe('110');
      expect(req?.stopLoss).toBe('90');
      expect(await heldFor(ALICE, 'USDT', placed.id)).toBe('100');
      expect(await avail(ALICE, 'USDT')).toBe('100');
    });

    it('refuses a missing take-profit — no invented trigger', async () => {
      await fund(ALICE, 'USDT', '200');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'brkt-miss-tp',
          bracket: true,
          stopLoss: '90',
        } as Parameters<TradeService['placeOrder']>[1]),
      ).rejects.toMatchObject({ code: 'trade.missing_stop_price' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('200');
    });

    it('refuses a missing stop-loss — no invented trigger', async () => {
      await fund(ALICE, 'USDT', '200');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'brkt-miss-sl',
          bracket: true,
          takeProfit: '110',
        } as Parameters<TradeService['placeOrder']>[1]),
      ).rejects.toMatchObject({ code: 'trade.missing_stop_price' });
      expect(matching.submitted).toHaveLength(0);
    });

    it('refuses a missing entry — last is not a trigger', async () => {
      await fund(ALICE, 'USDT', '200');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          clientOrderId: 'brkt-miss-entry',
          bracket: true,
          takeProfit: '110',
          stopLoss: '90',
        } as Parameters<TradeService['placeOrder']>[1]),
      ).rejects.toMatchObject({ code: 'trade.missing_price' });
      expect(matching.submitted).toHaveLength(0);
    });

    it('plain GTC never sets a bracket', async () => {
      await fund(ALICE, 'USDT', '500');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'gtc-plain-brkt',
      });
      expect(order.status).toBe('open');
      expect(matching.submitted).toHaveLength(1);
      const req = matching.submitted[0]?.request as {
        bracket?: boolean;
        takeProfit?: string | null;
        stopLoss?: string | null;
      };
      expect(req?.bracket).toBeUndefined();
      expect(req?.takeProfit).toBeUndefined();
      expect(req?.stopLoss).toBeUndefined();
    });
  });
});
