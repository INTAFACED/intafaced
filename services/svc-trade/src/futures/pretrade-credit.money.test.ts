import { PositionService, TradeService } from '../controls/test-admission.js';
/**
 * CARD F5 money proof — pre-trade credit dimensions refuse unset (PTX-M09-R10).
 *
 * Hitch: `installPreTradeCredit` wraps place/open so the mill runs BEFORE
 * `recipes.orderHold` / `recipes.futuresMarginLock`. Live boot: index.ts imports
 * ledger-client.ts which loads the mill. Mill has no default numbers and does
 * not flatten. Not a redo of F4/#3737. router.ts / trade-service.ts /
 * position-service.ts / index.ts not recut.
 *
 * Owner-published integers below are TEST FIXTURES only — never product law.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { memoryMarkBook } from './mark-source.js';
import { FuturesError, type OpenPositionInput } from './position-service.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import {
  MAX_LOSS_UNSET,
  MAX_ORDER_UNSET,
  MAX_POSITION_UNSET,
  checkPreTradeCreditDimensions,
  installPreTradeCredit,
  readOwnerPreTradeCredit,
} from './pretrade-credit.js';

import { TradeError } from '../spot/types.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';

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
      `H8a: svc-trade pretrade-credit is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-03T00:00:00.000Z');
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));
const CREDIT_KEYS = ['TRADE_MAX_ORDER', 'TRADE_MAX_POSITION', 'TRADE_MAX_LOSS'] as const;

/** Owner-published F5 fixtures — test labels only, never product law. Never copy into jobs/index. */
const OWNER_PUBLISHED_F5 = { maxOrder: '3', maxPosition: '5', maxLoss: '8' } as const;

function clearCreditEnv(): void {
  for (const key of CREDIT_KEYS) delete process.env[key];
}

function setCreditEnv(dims: { maxOrder?: string; maxPosition?: string; maxLoss?: string }): void {
  clearCreditEnv();
  if (dims.maxOrder !== undefined) process.env.TRADE_MAX_ORDER = dims.maxOrder;
  if (dims.maxPosition !== undefined) process.env.TRADE_MAX_POSITION = dims.maxPosition;
  if (dims.maxLoss !== undefined) process.env.TRADE_MAX_LOSS = dims.maxLoss;
}

installPreTradeCredit();

describe('pre-trade credit hitch (source) — no invented caps, no flatten', () => {
  it('pretrade-credit.ts has no default numbers and does not flatten', () => {
    const mill = readFileSync(join(here, 'pretrade-credit.ts'), 'utf8');
    expect(mill).toMatch(/checkPreTradeCreditDimensions/);
    expect(mill).toMatch(/origPlace\.call/);
    expect(mill).toMatch(/origOpen\.call/);
    expect(mill).toMatch(/TRADE_MAX_ORDER is unset/);
    expect(mill).toMatch(/0 is published, not a default/);
    expect(mill).not.toMatch(/flatten/i);
    expect(mill).not.toMatch(/planClose/);
    expect(mill).not.toMatch(/closeAll/);
    expect(mill).not.toMatch(/maxOrder\s*=\s*\d/);
    expect(mill).not.toMatch(/maxPosition\s*=\s*\d/);
    expect(mill).not.toMatch(/maxLoss\s*=\s*\d/);
    expect(mill).not.toMatch(/\?\?\s*0/);
    expect(mill).not.toMatch(/n\s*<=\s*0/);
    expect(mill).not.toMatch(/TRADE_MAX_ORDER.{0,80}default/i);
    const placeStart = mill.indexOf('export function installPreTradeCreditPlace');
    const openStart = mill.indexOf('export function installPreTradeCreditOpen');
    expect(placeStart).toBeGreaterThan(-1);
    expect(openStart).toBeGreaterThan(placeStart);
    const placeFn = mill.slice(placeStart, openStart);
    expect(placeFn.indexOf('checkPreTradeCreditDimensions')).toBeGreaterThan(-1);
    expect(placeFn.indexOf('checkPreTradeCreditDimensions')).toBeLessThan(placeFn.indexOf('origPlace.call'));
    const openFn = mill.slice(openStart);
    expect(openFn.indexOf('checkPreTradeCreditDimensions')).toBeGreaterThan(-1);
    expect(openFn.indexOf('checkPreTradeCreditDimensions')).toBeLessThan(openFn.indexOf('origOpen.call'));
  });

  it('router.ts / trade-service.ts / position-service.ts / index.ts not recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    const tradeSrc = readFileSync(join(here, '..', 'spot', 'trade-service.ts'), 'utf8');
    const posSrc = readFileSync(join(here, 'position-service.ts'), 'utf8');
    const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/pretrade-credit/);
    expect(routerSrc).not.toMatch(/max_order_unset/);
    expect(routerSrc).not.toMatch(/TRADE_MAX_ORDER/);
    expect(tradeSrc).not.toMatch(/pretrade-credit/);
    expect(tradeSrc).not.toMatch(/max_order_unset/);
    expect(tradeSrc).not.toMatch(/TRADE_MAX_ORDER/);
    expect(posSrc).not.toMatch(/pretrade-credit/);
    expect(posSrc).not.toMatch(/max_order_unset/);
    expect(posSrc).not.toMatch(/TRADE_MAX_ORDER/);
    expect(indexSrc).not.toMatch(/pretrade-credit/);
    expect(indexSrc).not.toMatch(/installPreTradeCredit/);
  });

  it('live boot loads mill; jobs/index do not copy owner fixtures', () => {
    const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    const boot = readFileSync(join(here, '..', 'ledger-client.ts'), 'utf8');
    const jobs = readFileSync(join(here, 'futures-jobs.ts'), 'utf8');
    expect(indexSrc).toMatch(/ledger-client/);
    expect(indexSrc).not.toMatch(/OWNER_PUBLISHED_F5/);
    expect(boot).toMatch(/installPreTradeCredit/);
    expect(boot).toMatch(/pretrade-credit/);
    expect(jobs).not.toMatch(/TRADE_MAX_ORDER/);
    expect(jobs).not.toMatch(/TRADE_MAX_POSITION/);
    expect(jobs).not.toMatch(/TRADE_MAX_LOSS/);
    expect(jobs).not.toMatch(/OWNER_PUBLISHED_F5/);
    expect(jobs).not.toMatch(/pretrade-credit/);
  });
});

describe('pre-trade credit mill (hermetic)', () => {
  it('unset / null / blank / non-integer each dimension refuse by name', () => {
    expect(checkPreTradeCreditDimensions({})).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
    expect(checkPreTradeCreditDimensions({ maxOrder: null })).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
    expect(checkPreTradeCreditDimensions({ maxOrder: '' })).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
    expect(checkPreTradeCreditDimensions({ maxOrder: '  ' })).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
    expect(checkPreTradeCreditDimensions({ maxOrder: 'abc' })).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
    expect(checkPreTradeCreditDimensions({ maxOrder: '10.5' })).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
    expect(checkPreTradeCreditDimensions({ maxOrder: '3' })).toMatchObject({ ok: false, code: MAX_POSITION_UNSET });
    expect(checkPreTradeCreditDimensions({ maxOrder: '3', maxPosition: '5' })).toMatchObject({
      ok: false,
      code: MAX_LOSS_UNSET,
    });
  });

  it('published owner integers including 0 pass through — mill does not flatten or default', () => {
    const admitted = checkPreTradeCreditDimensions(OWNER_PUBLISHED_F5);
    expect(admitted).toEqual({ ok: true, maxOrder: 3, maxPosition: 5, maxLoss: 8 });
    expect(checkPreTradeCreditDimensions({ maxOrder: '0', maxPosition: '5', maxLoss: '8' })).toEqual({
      ok: true,
      maxOrder: 0,
      maxPosition: 5,
      maxLoss: 8,
    });
  });

  it('readOwnerPreTradeCredit does not invent env defaults', () => {
    clearCreditEnv();
    expect(readOwnerPreTradeCredit()).toEqual({
      maxOrder: undefined,
      maxPosition: undefined,
      maxLoss: undefined,
    });
    expect(checkPreTradeCreditDimensions(readOwnerPreTradeCredit())).toMatchObject({ ok: false, code: MAX_ORDER_UNSET });
  });
});

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade pretrade-credit (H8a PG-hard)', () => {
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
    clearCreditEnv();
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('svc-trade pre-trade credit F5 money', () => {
    let ledger: MemoryLedger;
    let bus: MemoryEventBus;
    let matching: StubMatching;
    let perks: StubPerks;
    let trade: TradeService;
    let positions: PositionService;
    let marks: ReturnType<typeof memoryMarkBook>;

    function feed(price: string, quality: 'index' | 'mid' | 'last' = 'mid', at: Date = NOW) {
      marks.set({ marketId: MARKET, price, quality, asOfMs: at.getTime() });
    }

    const lockPosts = () => ledger.journal().filter((tx) => tx.reason === 'futures.margin.lock');
    const holdPosts = () => ledger.journal().filter((tx) => tx.reason === 'order.hold');
    const avail = async () => formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);

    async function open(clientOpenId = 'f5-open') {
      const input = {
        clientOpenId,
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long' as const,
        size: amt('1'),
        leverage: amt('10'),
      };
      return positions.open(input as OpenPositionInput);
    }

    beforeEach(async () => {
      clearCreditEnv();
      await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      bus = new MemoryEventBus('svc-trade');
      matching = new StubMatching();
      perks = new StubPerks();
      marks = memoryMarkBook();
      trade = new TradeService(sql, ledger, matching, perks, bus, {
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 150,
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      });
      positions = new PositionService(sql, ledger, {
        marks: marks.source(),
        profitSource: profitSourceFromConfig(PROFIT_SOURCE),
        maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
        bus,
        now: () => NOW,
      });
      feed('50000');
      await sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at
        ) VALUES (
          ${MARKET},
          'BTC/USDT-PERP',
          'BTC',
          'USDT',
          'futures',
          '0.01',
          '0.0001',
          '0.0001',
          '1',
          10,
          20,
          'active',
          'BTC perpetual',
          now()
        )
      `;
      await ledger.post(
        recipes.deposit({
          userId: ALICE,
          assetId: 'USDT',
          amount: amt('100000'),
          rail: 'test',
          railRef: `f5-${Math.random()}`,
        }),
      );
    });

    it('unset max-order refuses place before orderHold; zero ledger posts', async () => {
      const spot = await trade.listMarket({
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
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: spot.id,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
          clientOrderId: 'alice-credit-unset-f5',
        }),
      ).rejects.toMatchObject({ name: 'TradeError', code: MAX_ORDER_UNSET });
      expect(await sql`SELECT id FROM trade.orders`).toHaveLength(0);
      expect(matching.submitted).toHaveLength(0);
      expect(holdPosts()).toHaveLength(0);
      expect(await avail()).toBe('100000');
    });

    it('unset max-order refuses open before futuresMarginLock; zero lock posts', async () => {
      await expect(open('f5-unset-all')).rejects.toMatchObject({
        name: 'FuturesError',
        code: MAX_ORDER_UNSET,
        status: 400,
      });
      expect(lockPosts()).toHaveLength(0);
      expect(await sql`SELECT id FROM trade.positions`).toHaveLength(0);
      expect(await avail()).toBe('100000');
    });

    it('unset max-position / max-loss refuse new risk with zero lock posts', async () => {
      setCreditEnv({ maxOrder: OWNER_PUBLISHED_F5.maxOrder });
      await expect(open('f5-unset-position')).rejects.toMatchObject({
        name: 'FuturesError',
        code: MAX_POSITION_UNSET,
      });
      setCreditEnv({ maxOrder: OWNER_PUBLISHED_F5.maxOrder, maxPosition: OWNER_PUBLISHED_F5.maxPosition });
      await expect(open('f5-unset-loss')).rejects.toMatchObject({
        name: 'FuturesError',
        code: MAX_LOSS_UNSET,
      });
      expect(lockPosts()).toHaveLength(0);
      expect(holdPosts()).toHaveLength(0);
      expect(await sql`SELECT id FROM trade.positions`).toHaveLength(0);
      expect(await avail()).toBe('100000');
    });

    it('published owner integers (test fixtures) admit open — no flatten', async () => {
      setCreditEnv(OWNER_PUBLISHED_F5);
      const pos = await open('f5-published-admit');
      expect(pos.contracts).toBe('1');
      expect(pos.side).toBe('long');
      expect(lockPosts()).toHaveLength(1);
      expect(await sql`SELECT id FROM trade.positions`).toHaveLength(1);
    });

    it('FuturesError / TradeError carry mill string codes', () => {
      const ferr = new FuturesError('max-order unset', MAX_ORDER_UNSET, 400);
      expect(ferr.code).toBe('trade.max_order_unset');
      const terr = new TradeError('max-position unset', MAX_POSITION_UNSET as 'trade.slippage_cap_unset');
      expect(terr.code).toBe('trade.max_position_unset');
    });
  });
});
