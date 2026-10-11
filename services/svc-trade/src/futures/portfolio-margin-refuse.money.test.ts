import { PositionService } from '../controls/test-admission.js';
/**
 * CARD F1 money proof — portfolio / cross refuse before IM hold.
 *
 * Hitch (`checkMarginModeForFuturesOpen` before `recipes.futuresMarginLock`) is
 * already on origin/main `position-service.ts`. This file does not recut that
 * host, `router.ts`, `trade-service.ts`, or `types.ts`. Mill string codes stay
 * mill string codes — FuturesError carries them without a TradeErrorCode add.
 *
 * Isolated remains the live IM product. Cross / multi-collateral / PM stay
 * named refuses. Owner portfolio scenarios stay unset even given an env blob.
 * ORE is not this card.
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
import {
  CROSS_MARGIN_UNSUPPORTED,
  MARGIN_PRODUCTS_2X2,
  PORTFOLIO_MARGIN_UNSET,
  checkMarginModeForFuturesOpen,
  ownerPortfolioScenarioSet,
} from './margin-mode.js';
import { memoryMarkBook } from './mark-source.js';
import { FuturesError, type OpenPositionInput } from './position-service.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';

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
      `H8a: svc-trade portfolio-margin-refuse is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-06T12:00:00.000Z');
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));

describe('portfolio-margin refuse hitch (source)', () => {
  it('open path calls checkMarginModeForFuturesOpen before futuresMarginLock', () => {
    const src = readFileSync(join(here, 'position-service.ts'), 'utf8');
    const openStart = src.indexOf('async open(input: OpenPositionInput, principal?: Principal)');
    expect(openStart).toBeGreaterThan(-1);
    const open = src.slice(openStart);
    const hitch = open.indexOf('checkMarginModeForFuturesOpen(input.marginMode)');
    const lock = open.indexOf('recipes.futuresMarginLock({');
    expect(hitch).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(hitch).toBeLessThan(lock);
  });

  it('router.ts has no margin-mode recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/margin-mode/);
    expect(routerSrc).not.toMatch(/checkMarginModeForFuturesOpen/);
    expect(routerSrc).not.toMatch(/portfolio_margin/);
    expect(routerSrc).not.toMatch(/MARGIN_PRODUCTS_2X2/);
  });

  it('POST /positions/margin-mode stays 501 — isolated-at-open only', () => {
    const privateRest = readFileSync(join(here, '..', 'private-rest.ts'), 'utf8');
    expect(privateRest).toMatch(/app\.post\('\/api\/v1\/positions\/margin-mode'/);
    expect(privateRest).toMatch(/setMarginModeArm\.httpStatus !== 501/);
  });

  it('names all four segregation × calculation combinations', () => {
    expect(MARGIN_PRODUCTS_2X2).toHaveLength(4);
    const cells = MARGIN_PRODUCTS_2X2.map((p) => `${p.segregation}×${p.calculation}`).sort();
    expect(cells).toEqual(['cross_collateral×portfolio', 'cross_collateral×standard', 'segregated×portfolio', 'segregated×standard']);
    expect(MARGIN_PRODUCTS_2X2.find((p) => p.segregation === 'segregated' && p.calculation === 'standard')?.namedMode).toBe('isolated');
    expect(MARGIN_PRODUCTS_2X2.find((p) => p.segregation === 'cross_collateral' && p.calculation === 'standard')?.namedMode).toBe('cross');
    expect(MARGIN_PRODUCTS_2X2.filter((p) => p.calculation === 'portfolio').map((p) => p.namedMode)).toEqual(['portfolio', 'portfolio']);
  });

  it('ownerPortfolioScenarioSet stays false even with a fake env blob', () => {
    expect(ownerPortfolioScenarioSet()).toBe(false);
    expect(
      ownerPortfolioScenarioSet({
        TRADE_FUTURES_PORTFOLIO_SCENARIO: '{"shocks":[{"spot":"-0.15"}]}',
        TRADE_FUTURES_PORTFOLIO_ENABLED: 'true',
      }),
    ).toBe(false);
    expect(checkMarginModeForFuturesOpen('isolated')).toEqual({ ok: true });
    expect(checkMarginModeForFuturesOpen(undefined)).toEqual({ ok: true });
    expect(checkMarginModeForFuturesOpen('cross')).toMatchObject({ ok: false, code: CROSS_MARGIN_UNSUPPORTED });
    expect(checkMarginModeForFuturesOpen('portfolio')).toMatchObject({ ok: false, code: PORTFOLIO_MARGIN_UNSET });
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

describe('svc-trade portfolio-margin-refuse (H8a PG-hard)', () => {
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

  describe('svc-trade portfolio-margin F1 money', () => {
    let ledger: MemoryLedger;
    let bus: MemoryEventBus;
    let positions: PositionService;
    let marks: ReturnType<typeof memoryMarkBook>;

    function feed(price: string, quality: 'index' | 'mid' | 'last' = 'mid', at: Date = NOW) {
      marks.set({ marketId: MARKET, price, quality, asOfMs: at.getTime() });
    }

    function build() {
      return new PositionService(sql, ledger, {
        marks: marks.source(),
        profitSource: profitSourceFromConfig(PROFIT_SOURCE),
        maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
        bus,
        now: () => NOW,
      });
    }

    const lockPosts = () => ledger.journal().filter((tx) => tx.reason === 'futures.margin.lock');
    const avail = async () => formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);

    async function open(marginMode?: string, clientOpenId = `f1-${marginMode ?? 'omit'}`) {
      const input = {
        clientOpenId,
        userId: ALICE,
        symbol: 'BTC/USDT-PERP',
        side: 'long' as const,
        size: amt('1'),
        leverage: amt('10'),
        ...(marginMode !== undefined ? { marginMode } : {}),
      };
      return positions.open(input as OpenPositionInput);
    }

    beforeEach(async () => {
      await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      bus = new MemoryEventBus('svc-trade');
      marks = memoryMarkBook();
      positions = build();
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
          railRef: `f1-${Math.random()}`,
        }),
      );
    });

    it('isolated open is admitted and posts futures.margin.lock', async () => {
      const pos = await open('isolated', 'f1-isolated-ok');
      expect(pos.contracts).toBe('1');
      expect(pos.side).toBe('long');
      expect(lockPosts()).toHaveLength(1);
      expect(await sql`SELECT id FROM trade.positions`).toHaveLength(1);
      expect(await avail()).not.toBe('100000');
    });

    it('omitted marginMode is isolated-at-open and still locks', async () => {
      const pos = await open(undefined, 'f1-omit-ok');
      expect(pos.contracts).toBe('1');
      expect(lockPosts()).toHaveLength(1);
    });

    it('cross refuses trade.cross_margin_unsupported with zero lock posts', async () => {
      await expect(open('cross', 'f1-cross-refuse')).rejects.toMatchObject({
        name: 'FuturesError',
        code: CROSS_MARGIN_UNSUPPORTED,
        status: 400,
      });
      expect(lockPosts()).toHaveLength(0);
      expect(await sql`SELECT id FROM trade.positions`).toHaveLength(0);
      expect(await avail()).toBe('100000');
      expect(ledger.journal().every((tx) => tx.reason !== 'futures.margin.lock')).toBe(true);
    });

    it('portfolio refuses trade.portfolio_margin_unset with zero lock posts', async () => {
      await expect(open('portfolio', 'f1-portfolio-refuse')).rejects.toMatchObject({
        name: 'FuturesError',
        code: PORTFOLIO_MARGIN_UNSET,
        status: 400,
      });
      expect(lockPosts()).toHaveLength(0);
      expect(await sql`SELECT id FROM trade.positions`).toHaveLength(0);
      expect(await avail()).toBe('100000');
    });

    it('FuturesError carries mill string codes — no TradeErrorCode add', () => {
      const err = new FuturesError('portfolio unset', PORTFOLIO_MARGIN_UNSET, 400);
      expect(err.code).toBe('trade.portfolio_margin_unset');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
