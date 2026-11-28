import { PositionService, layeredPositionService } from '../controls/test-admission.js';
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
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { memoryMarkBook } from './mark-source.js';
import { type OpenPositionInput } from './position-service.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import {
  HAIRCUT_UNSET,
  MARGIN_IS_NOT_A_LOAN,
  UNSUPPORTED_COLLATERAL_CLASS,
  checkPostedMarginCollateral,
  readOwnerHaircutBps,
  withCollateralHaircutOpen,
} from './collateral-haircut.js';
import { COLLATERAL_CLASSES, checkCollateralClassForMargin } from './margin-mode.js';

// The layers this file used to get installed on import, applied here in the same order (garden/no-runtime-swap).
const LayeredPositionService = layeredPositionService(withCollateralHaircutOpen);

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
  // Whole quote units (#4725 compares them): roomy enough for a 1 BTC open at 50,000.
  process.env.TRADE_MAX_ORDER = '1000000';
  process.env.TRADE_MAX_POSITION = '5000000';
  process.env.TRADE_MAX_LOSS = '100000';
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
    const container = await testPostgres(H8A_IMAGE)
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

describe('collateral haircut hitch (source) — no invented bps, not a loan', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('collateral-haircut.ts has no default 0/10 and does not lend IM', async () => {
    // Every path of the check, with no haircut named anywhere: each one refuses, none is a 0 or 10 of its own.
    delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    expect(readOwnerHaircutBps()).toBeUndefined();
    for (const collateralClass of [undefined, null, '', 'cash', ...COLLATERAL_CLASSES, 'unknown']) {
      for (const haircutBps of [undefined, null, '', '  ']) {
        const check = checkPostedMarginCollateral({ collateralClass, haircutBps });
        expect(check.ok, `${String(collateralClass)} ${String(haircutBps)}`).toBe(false);
        expect([HAIRCUT_UNSET, UNSUPPORTED_COLLATERAL_CLASS], String(collateralClass)).toContain((check as { code: string }).code);
      }
      // A loan refuses first, whatever else is named.
      expect(checkPostedMarginCollateral({ collateralClass, haircutBps: '1000', asLoan: true })).toMatchObject({
        ok: false,
        code: MARGIN_IS_NOT_A_LOAN,
      });
    }
    // A named haircut is used exactly, from the input or from the owner's env; the input wins.
    expect(checkPostedMarginCollateral({ haircutBps: '1000' })).toEqual({ ok: true, haircutBps: 1000 });
    process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '250';
    expect(checkPostedMarginCollateral({})).toEqual({ ok: true, haircutBps: 250 });
    expect(checkPostedMarginCollateral({ collateralClass: 'cash', haircutBps: '1000' })).toEqual({ ok: true, haircutBps: 1000 });
    expect(checkPostedMarginCollateral({ collateralClass: 'staked' })).toMatchObject({ ok: false, code: UNSUPPORTED_COLLATERAL_CLASS });
    delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    // The open layer refuses before the base open on a refused check, and hands every passing open to the base unchanged.
    const seen: unknown[] = [];
    class Base {
      async open(input: unknown) {
        seen.push(input);
        return { opened: true };
      }
    }
    const Layered = withCollateralHaircutOpen(Base as never) as unknown as new () => Base;
    await expect(new Layered().open({ clientOpenId: 'x' })).rejects.toMatchObject({
      name: 'FuturesError',
      code: HAIRCUT_UNSET,
      status: 400,
    });
    await expect(new Layered().open({ clientOpenId: 'y', asLoan: true, haircutBps: '1000' })).rejects.toMatchObject({
      code: MARGIN_IS_NOT_A_LOAN,
    });
    expect(seen).toEqual([]);
    const passing = { clientOpenId: 'z', haircutBps: '1000', collateralClass: 'cash' };
    await expect(new Layered().open(passing)).resolves.toEqual({ opened: true });
    expect(seen).toEqual([passing]);
  });

  it('router.ts / margin-mode.ts / position-service.ts not recut', async () => {
    // The router and the position service never load this mill (futures-module-reach.test.ts). margin-mode.ts names
    // the collateral refusal and never reads the haircut: every export is driven with the env read through a recorder.
    expect(checkCollateralClassForMargin('yield_bearing')).toMatchObject({ ok: false, code: 'trade.unsupported_collateral_class' });
    const reads = new Set<string>();
    const realEnv = process.env;
    process.env = new Proxy(realEnv, {
      get: (target, key) => {
        if (typeof key === 'string') reads.add(key);
        return Reflect.get(target, key);
      },
    });
    const driven: string[] = [];
    try {
      vi.resetModules();
      const mode = await import('./margin-mode.js');
      void process.env.TRADE_HAIRCUT_PROBE;
      const fakeSql = Object.assign(() => Promise.resolve([]), { unsafe: () => Promise.resolve([]) });
      for (const [name, value] of Object.entries(mode)) {
        if (typeof value !== 'function') continue;
        driven.push(name);
        for (const arg of [undefined, 'cash', 'isolated', 'cross', 'portfolio', 'staked', {}, fakeSql]) {
          try {
            await (value as (...a: unknown[]) => unknown)(arg, mode.memoryMarginModeSwitchAudit());
          } catch {
            // A refusal is an answer; only the env reads matter here.
          }
        }
      }
    } finally {
      process.env = realEnv;
      vi.resetModules();
    }
    expect(driven.length).toBeGreaterThan(5);
    // The recorder sees a read made through it (the probe above), so an empty list means none was made.
    expect(reads.has('TRADE_HAIRCUT_PROBE')).toBe(true);
    expect([...reads].filter((k) => /HAIRCUT/.test(k) && k !== 'TRADE_HAIRCUT_PROBE')).toEqual([]);
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

  it('blank haircut refuses and does not invent 0 or 10; a published 0 is the owner zero', () => {
    delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    expect(checkPostedMarginCollateral({ haircutBps: '' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
    expect(checkPostedMarginCollateral({ haircutBps: 'abc' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
    expect(checkPostedMarginCollateral({ haircutBps: '-1' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
    expect(checkPostedMarginCollateral({ collateralClass: 'cash' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
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
    positions = new LayeredPositionService(sql, ledger, {
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

  it('invalid or blank haircut refuses before futuresMarginLock', async () => {
    await expect(open({ clientOpenId: 'f8-bad-cut', haircutBps: 'nope' })).rejects.toMatchObject({
      name: 'FuturesError',
      code: HAIRCUT_UNSET,
    });
    await expect(open({ clientOpenId: 'f8-blank', collateralClass: 'cash' })).rejects.toMatchObject({
      name: 'FuturesError',
      code: HAIRCUT_UNSET,
    });
    expect(lockPosts()).toHaveLength(0);
    expect(await sql`SELECT id FROM trade.positions`).toHaveLength(0);
  });

  describe('open credit counts the ledger collateral pot, not the margin mirror', () => {
    // 10% haircut. Alice has 100,000 USDT; a 1 BTC open at 50,000 and 10x locks 5,000 into that position's pot.
    beforeEach(() => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';
    });

    async function firstPosition() {
      await open({ clientOpenId: 'mirror-1' });
      expect(await avail()).toBe('95000');
      const [row] = await sql<{ id: string }[]>`SELECT id FROM trade.positions`;
      return row!.id;
    }

    it('a mirror that claims more margin than the pot holds does not buy credit', async () => {
      await firstPosition();
      await sql`UPDATE trade.positions SET margin_current = '1000000'`;
      // 18 BTC needs 90,000 more; credit is 0.9 x (95,000 free + 5,000 in the pot) = 90,000 against 95,000 required.
      await expect(open({ clientOpenId: 'mirror-2', size: amt('18') })).rejects.toMatchObject({
        name: 'FuturesError',
        code: 'trade.haircut_credit_short',
      });
      expect(lockPosts()).toHaveLength(1);
      expect(await avail()).toBe('95000');
    });

    it('a mirror that claims less margin than the pot holds does not refuse an open the ledger covers', async () => {
      await firstPosition();
      await sql`UPDATE trade.positions SET margin_current = '0'`;
      // A second market (one open position per market): 17 units at 50,000 need 85,000 more, so required 90,000 against
      // credit 90,000 (ledger truth).
      const second = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      await sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at
        ) VALUES (${second}, 'ETH/USDT-PERP', 'ETH', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'ETH perpetual', now())
      `;
      marks.set({ marketId: second, price: '50000', quality: 'mid', asOfMs: NOW.getTime() });
      await open({ clientOpenId: 'mirror-3', symbol: 'ETH/USDT-PERP', size: amt('17') });
      expect(lockPosts()).toHaveLength(2);
    });
  });
});
