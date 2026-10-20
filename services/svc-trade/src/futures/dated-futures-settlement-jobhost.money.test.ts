/**
 * H6 money proof — dated futures settlement JobHost + PG.
 *
 * PG-hard: never `describe.skip` / `postgresAvailable`. CI uses TEST_DATABASE_URL.
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 *
 * JobHost tick loads expired dated rows from SQL, posts ledger-client recipes
 * on an owner decimal, refuses blank TRADE_FUTURES_SETTLEMENT_FIXING, never
 * last trade / mark as settlement. Listing CHECK still refuses blank fixing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  futuresLossSink,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
  houseFees,
} from '@intafaced/ledger-client';
import { DATED_FUTURES_SETTLEMENT_PRICE_UNSET } from './dated-futures-settlement.js';
import { startFuturesJobs } from './futures-jobs.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const POS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXPIRY = new Date('2026-12-26T08:00:00.000Z');
const AFTER = new Date('2026-12-26T08:00:01.000Z');

const H6_IMAGE = 'postgres:16-alpine';

async function openH6Admin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }
  try {
    const container = await new PostgreSqlContainer(H6_IMAGE)
      .withDatabase('intafaced_h6_test')
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
      `H6: dated settlement JobHost is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H6_IMAGE}: ${msg}`,
    );
  }
}

function captureIntervals() {
  const timers: Array<{ id: number; fn: () => unknown; ms: number }> = [];
  let nextId = 1;
  return {
    timers,
    setIntervalFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: ((id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    }) as typeof clearInterval,
  };
}

/**
 * Alice locks 20 of a 1000 deposit. Bob is the loser on the other side: his
 * 50 deposit, margin lock and realised loss fill the clearing pot
 * (`futuresLossSink`), the account losers pay into and `futuresRealizeProfit`
 * pays winners from.
 */
async function seedMarginAndProfitPot(ledger: MemoryLedger) {
  await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'alice-usdt' }));
  await ledger.post(recipes.futuresMarginLock({ positionId: POS, userId: ALICE, assetId: 'USDT', amount: amt('20') }));
  await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: amt('50'), rail: 'test', railRef: 'bob-loser-seed' }));
  await ledger.post(recipes.futuresMarginLock({ positionId: 'loser-pot-seed', userId: BOB, assetId: 'USDT', amount: amt('50') }));
  await ledger.post(
    recipes.futuresRealizeLoss({
      positionId: 'loser-pot-seed',
      userId: BOB,
      assetId: 'USDT',
      fromMargin: amt('50'),
      fromInsurance: 0n,
      lossId: 'pot-seed',
    }),
  );
}

describe('H6 JobHost money hitch (source)', () => {
  it('H6 money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('router.ts not recut; live host does not invent a fixing price', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/runDatedFuturesSettlementJob/);
    expect(routerSrc).not.toMatch(/dated-futures-settlement/);
    const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/settlementFixing:\s*env\.TRADE_FUTURES_SETTLEMENT_FIXING/);
    expect(indexSrc).not.toMatch(/ownerSettlementPriceFor/);
  });
});

describe('svc-trade dated futures settlement H6 JobHost money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH6Admin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at,
        futures_contract_style, futures_expiry_at, futures_settlement_fixing
      ) VALUES (
        ${MARKET}, 'BTC/USDT:USDT-251226', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1',
        10, 20, 'active', 'BTC dated', now(),
        'dated', ${EXPIRY}, 'owner-stamp'
      )
    `;
    await sql`
      INSERT INTO trade.positions (
        id, user_id, market_id, side, status, margin_mode, size, entry_price, leverage,
        margin_initial, margin_current, margin_asset, opened_at
      ) VALUES (
        ${POS}, ${ALICE}, ${MARKET}, 'long', 'open', 'isolated', '1', '100', '5',
        '20', '20', 'USDT', now()
      )
    `;
  });

  it('schema CHECK still refuses dated listing with blank futures_settlement_fixing', async () => {
    await expect(
      sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at,
          futures_contract_style, futures_expiry_at, futures_settlement_fixing
        ) VALUES (
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'ETH/USDT:USDT-251226', 'ETH', 'USDT', 'futures',
          '0.01', '0.0001', '0.0001', '1',
          10, 20, 'active', 'ETH dated', now(),
          'dated', ${EXPIRY}, ''
        )
      `,
    ).rejects.toThrow();
  });

  it('JobHost tick loads PG rows and posts owner decimal recipes; never last trade', async () => {
    const ledger = new MemoryLedger();
    await seedMarginAndProfitPot(ledger);
    const before = ledger.journal().length;
    const clock = captureIntervals();
    const handle = startFuturesJobs({
      sql,
      ledger,
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 0 }) } as never,
      bus: null,
      now: () => AFTER,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      lastTradePrice: '1',
      markPrice: '2',
      ownerSettlementPriceFor: () => '110',
      config: {
        enabled: true,
        liqIntervalMs: 15_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
        settlementFixing: 'owner-stamp',
      },
    });
    expect(handle.host.list()).toContain('futures.dated_settlement');
    await clock.timers[0]!.fn();
    expect(ledger.journal().length).toBe(before + 2);
    expect(
      ledger
        .journal()
        .slice(before)
        .map((p) => p.reason),
    ).toEqual(['futures.profit.realized', 'futures.margin.release']);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', POS))).amount)).toBe('0');
    // 1000 - 20 lock + 10 profit + 20 release = 1010. Clearing pot 50 - 10 = 40.
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('1010');
    expect(formatAmount((await ledger.balance(futuresLossSink('USDT'))).amount)).toBe('40');
    // House trade fees never pay a winner.
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
    const [row] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE id = ${POS}`;
    expect(row?.status).toBe('closed');
    handle.stop();
  });

  it('blank fixing on JobHost refuses; PG position stays open; last trade unused', async () => {
    const ledger = new MemoryLedger();
    await seedMarginAndProfitPot(ledger);
    const before = ledger.journal().length;
    const clock = captureIntervals();
    const handle = startFuturesJobs({
      sql,
      ledger,
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 0 }) } as never,
      bus: null,
      now: () => AFTER,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      lastTradePrice: '1',
      markPrice: '2',
      ownerSettlementPriceFor: () => '999',
      config: {
        enabled: true,
        liqIntervalMs: 15_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
        settlementFixing: '',
      },
    });
    await clock.timers[0]!.fn();
    expect(ledger.journal()).toHaveLength(before);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', POS))).amount)).toBe('20');
    expect(ledger.reconcile()).toEqual({ ok: true });
    const [row] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE id = ${POS}`;
    expect(row?.status).toBe('open');
    expect(DATED_FUTURES_SETTLEMENT_PRICE_UNSET).toBe('trade.dated_futures_settlement_price_unset');
    handle.stop();
  });
});
