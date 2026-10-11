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
import { bindOco, installOcoPlace, stashOcoFromBody } from './oco-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import { TradeError, type Market } from './types.js';

installOcoPlace(TradeService);

function thrownTrade(fn: () => void): TradeError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TradeError) return err;
    throw err;
  }
  throw new Error('expected TradeError');
}

describe('oco stash — IEEE and clientOrderId', () => {
  it('refuses a JSON number stopPrice — IEEE 0.1 is not a decimal string', () => {
    const err = thrownTrade(() => stashOcoFromBody({ oco: true, takeProfit: 0.1, stopLoss: '90', clientOrderId: 'oco-ieee' }));
    expect(err.code).toBe('trade.ieee_money');
    expect(err.message).toMatch(/JSON number/);
  });

  it('refuses a JSON number nested stopPrice', () => {
    const err = thrownTrade(() =>
      stashOcoFromBody({
        oco: true,
        takeProfit: { stopPrice: 0.1 },
        stopLoss: { stopPrice: '90' },
        clientOrderId: 'oco-ieee-nested',
      }),
    );
    expect(err.code).toBe('trade.ieee_money');
  });

  it('refuses OCO when clientOrderId is missing — does not strip-and-place', () => {
    const rec: Record<string, unknown> = { oco: true, takeProfit: '110', stopLoss: '90' };
    const err = thrownTrade(() => stashOcoFromBody(rec));
    expect(err.code).toBe('trade.client_order_id_required');
    expect(rec.oco).toBe(true);
    expect(rec.takeProfit).toBe('110');
    expect(rec.stopLoss).toBe('90');
  });

  it('does not String() a JSON number into a stopPrice', () => {
    const src = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.ts$/, '.ts'), 'utf8');
    expect(src).not.toMatch(/typeof raw === 'string' \|\| typeof raw === 'number'/);
    expect(src).not.toMatch(/String\(raw\)/);
  });

  it('stashes a decimal-string 0.1 and bindOco restores it', () => {
    stashOcoFromBody({ oco: true, takeProfit: '0.1', stopLoss: '90', clientOrderId: 'oco-str-01' });
    const bound = bindOco({
      clientOrderId: 'oco-str-01',
      side: 'sell',
      type: 'limit',
      qty: amt('1'),
    } as PlaceOrderInput);
    expect(bound.oco).toBe(true);
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
      `H8a: svc-trade oco-place is PG-hard (no skip-green). ` +
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

describe('svc-trade oco-place (H8a PG-hard)', () => {
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

  describe('linked TP+SL (OCO) through matching', () => {
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

    it('places one linked OCO through matching — no invented trigger', async () => {
      await fund(ALICE, 'BTC', '2');
      const placed = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('110'),
        clientOrderId: 'oco-1',
        takeProfit: { price: '110', stopPrice: '110' },
        stopLoss: { stopPrice: '90' },
      } as Parameters<TradeService['placeOrder']>[1]);
      expect(placed.status).toBe('open');
      expect(matching.submitted).toHaveLength(1);
      const req = matching.submitted[0]?.request as {
        oco?: boolean;
        takeProfit?: string | null;
        stopLoss?: string | null;
      };
      expect(req?.oco).toBe(true);
      expect(req?.takeProfit).toBe('110');
      expect(req?.stopLoss).toBe('90');
      expect(await heldFor(ALICE, 'BTC', placed.id)).toBe('1');
      expect(await avail(ALICE, 'BTC')).toBe('1');
    });

    it('refuses a missing take-profit — no invented trigger', async () => {
      await fund(ALICE, 'BTC', '2');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'sell',
          type: 'limit',
          qty: amt('1'),
          price: amt('110'),
          clientOrderId: 'oco-miss-tp',
          oco: true,
          stopLoss: { stopPrice: '90' },
        } as Parameters<TradeService['placeOrder']>[1]),
      ).rejects.toMatchObject({ code: 'trade.missing_oco_trigger' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'BTC')).toBe('2');
    });

    it('refuses a missing stop-loss — no invented trigger', async () => {
      await fund(ALICE, 'BTC', '2');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'sell',
          type: 'limit',
          qty: amt('1'),
          price: amt('110'),
          clientOrderId: 'oco-miss-sl',
          takeProfit: { price: '110', stopPrice: '110' },
          stopLoss: { stopPrice: '' },
        } as Parameters<TradeService['placeOrder']>[1]),
      ).rejects.toMatchObject({ code: 'trade.missing_oco_trigger' });
      expect(matching.submitted).toHaveLength(0);
    });

    it('GTC never sets oco takeProfit or stopLoss', async () => {
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
      expect(matching.submitted).toHaveLength(1);
      const req = matching.submitted[0]?.request as {
        oco?: boolean;
        takeProfit?: string | null;
        stopLoss?: string | null;
      };
      expect(req?.oco).toBeUndefined();
      expect(req?.takeProfit).toBeUndefined();
      expect(req?.stopLoss).toBeUndefined();
    });
  });
});
