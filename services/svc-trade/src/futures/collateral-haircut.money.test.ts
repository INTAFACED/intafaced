import { PositionService } from '../controls/test-admission.js';
/**
 * CARD F8 money proof — collateral haircuts (PTX-M08-R03 PTX-M08-R11).
 *
 * Hitch: installCollateralHaircut wraps open before futuresMarginLock.
 * Haircuts are OWNER. Yield/staked refuse. Posted margin is not a loan.
 * Not a redo of F7/#3767 or F1/#3727. router.ts / margin-mode.ts not recut.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { memoryMarkBook } from './mark-source.js';
import { type OpenPositionInput } from './position-service.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import {
  HAIRCUT_UNSET,
  MARGIN_IS_NOT_A_LOAN,
  UNSUPPORTED_COLLATERAL_CLASS,
  checkPostedMarginCollateral,
  installCollateralHaircut,
} from './collateral-haircut.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-03T00:00:00.000Z');
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));
const CREDIT_KEYS = ['TRADE_MAX_ORDER', 'TRADE_MAX_POSITION', 'TRADE_MAX_LOSS'] as const;
const H8A_IMAGE = 'postgres:16-alpine';

function setCreditEnv(): void {
  process.env.TRADE_MAX_ORDER = '3';
  process.env.TRADE_MAX_POSITION = '5';
  process.env.TRADE_MAX_LOSS = '8';
}

function clearHaircutEnv(): void {
  delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
}

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
      `H8a: svc-trade collateral-haircut is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

installCollateralHaircut();

describe('collateral haircut hitch (source) — no invented bps, not a loan', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('collateral-haircut.ts has no default 0/10 and does not lend IM', () => {
    const mill = readFileSync(join(here, 'collateral-haircut.ts'), 'utf8');
    expect(mill).toMatch(/checkPostedMarginCollateral/);
    expect(mill).toMatch(/checkCollateralClassForMargin/);
    expect(mill).toMatch(/origOpen\.call/);
    expect(mill).toMatch(/refuse rather than invent a haircut/);
    expect(mill).toMatch(/posted margin is not a loan/);
    expect(mill).not.toMatch(/haircutBps\s*=\s*0/);
    expect(mill).not.toMatch(/haircutBps\s*=\s*10/);
    expect(mill).not.toMatch(/\?\?\s*0/);
    expect(mill).not.toMatch(/\?\?\s*10/);
  });

  it('router.ts / margin-mode.ts / position-service.ts not recut', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    const marginSrc = readFileSync(join(here, 'margin-mode.ts'), 'utf8');
    const posSrc = readFileSync(join(here, 'position-service.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/collateral-haircut/);
    expect(routerSrc).not.toMatch(/haircut_unset/);
    expect(posSrc).not.toMatch(/collateral-haircut/);
    expect(marginSrc).toMatch(/unsupported_collateral_class/);
    expect(marginSrc).not.toMatch(/TRADE_COLLATERAL_HAIRCUT_BPS/);
  });
});

describe('collateral haircut mill (hermetic)', () => {
  it('yield / staked / lending-idle refuse as IM', () => {
    expect(checkPostedMarginCollateral({ collateralClass: 'yield_bearing' })).toMatchObject({
      ok: false,
      code: UNSUPPORTED_COLLATERAL_CLASS,
    });
    expect(checkPostedMarginCollateral({ collateralClass: 'staked' })).toMatchObject({
      ok: false,
      code: UNSUPPORTED_COLLATERAL_CLASS,
    });
    expect(checkPostedMarginCollateral({ collateralClass: 'lending_idle' })).toMatchObject({
      ok: false,
      code: UNSUPPORTED_COLLATERAL_CLASS,
    });
  });

  it('asLoan refuses — posted margin is not a loan', () => {
    expect(checkPostedMarginCollateral({ asLoan: true })).toMatchObject({
      ok: false,
      code: MARGIN_IS_NOT_A_LOAN,
    });
  });

  it('unset/invalid haircut refuses; cash without a supplied haircut does not invent 0', () => {
    expect(checkPostedMarginCollateral({ haircutBps: '' })).toMatchObject({ ok: true, haircutBps: null });
    expect(checkPostedMarginCollateral({ haircutBps: 'abc' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
    expect(checkPostedMarginCollateral({ haircutBps: '-1' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
    expect(checkPostedMarginCollateral({ collateralClass: 'cash' })).toMatchObject({ ok: true, haircutBps: null });
    expect(checkPostedMarginCollateral({ haircutBps: '0' })).toMatchObject({ ok: true, haircutBps: 0 });
  });
});

describe('svc-trade collateral haircut F8 money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bus: MemoryEventBus;
  let positions: PositionService;
  let marks: ReturnType<typeof memoryMarkBook>;

  const lockPosts = () => ledger.journal().filter((tx) => tx.reason === 'futures.margin.lock');
  const avail = async () => formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);

  async function open(extra: Record<string, unknown> = {}) {
    const input = {
      clientOpenId: String(extra.clientOpenId ?? 'f8-open'),
      userId: ALICE,
      symbol: 'BTC/USDT-PERP',
      side: 'long' as const,
      size: amt('1'),
      leverage: amt('10'),
      positionMode: 'one_way',
      ...extra,
    };
    return positions.open(input as OpenPositionInput);
  }

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    clearHaircutEnv();
    setCreditEnv();
    for (const key of CREDIT_KEYS) expect(process.env[key]).toBeTruthy();
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bus = new MemoryEventBus('svc-trade');
    marks = memoryMarkBook();
    positions = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus,
      now: () => NOW,
    });
    marks.set({ marketId: MARKET, price: '50000', quality: 'mid', asOfMs: NOW.getTime() });
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
        railRef: `f8-${Math.random()}`,
      }),
    );
  });

  afterAll(async () => {
    clearHaircutEnv();
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('staked collateral refuses open before futuresMarginLock; zero lock posts', async () => {
    await expect(open({ clientOpenId: 'f8-staked', collateralClass: 'staked' })).rejects.toMatchObject({
      name: 'FuturesError',
      code: UNSUPPORTED_COLLATERAL_CLASS,
      status: 400,
    });
    expect(lockPosts()).toHaveLength(0);
    expect(await sql`SELECT id FROM trade.positions`).toHaveLength(0);
    expect(await avail()).toBe('100000');
  });

  it('asLoan refuses; zero lock posts', async () => {
    await expect(open({ clientOpenId: 'f8-loan', asLoan: true })).rejects.toMatchObject({
      name: 'FuturesError',
      code: MARGIN_IS_NOT_A_LOAN,
    });
    expect(lockPosts()).toHaveLength(0);
  });

  it('invalid haircut refuses; cash without invented haircut admits', async () => {
    await expect(open({ clientOpenId: 'f8-bad-cut', haircutBps: 'nope' })).rejects.toMatchObject({
      name: 'FuturesError',
      code: HAIRCUT_UNSET,
    });
    expect(lockPosts()).toHaveLength(0);
    const pos = await open({ clientOpenId: 'f8-cash', collateralClass: 'cash' });
    expect(pos.side).toBe('long');
    expect(lockPosts()).toHaveLength(1);
  });
});
