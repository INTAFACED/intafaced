/**
 * CARD F3 money proof — dated futures settlement job (PTX-M10-R03).
 *
 * Hitch: runDatedFuturesSettlementJob wraps runDatedFuturesExpiryTick + planClose.
 * Owner decimal fixing posts existing ledger-client recipes (futuresRealizeProfit /
 * futuresRealizeLoss / futuresMarginRelease). Blank fixing refuses
 * trade.dated_futures_settlement_price_unset with zero posts. Never last trade / mark.
 * Listing still refuses blank TRADE_FUTURES_SETTLEMENT_FIXING. router.ts not recut.
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
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { TradeError } from '../spot/types.js';
import { DATED_FUTURES_FIXING_UNCONFIGURED, resolveDatedFuturesListing } from './dated-futures.js';
import { DATED_FUTURES_SETTLEMENT_PRICE_UNSET, datedSettlementIdFor, runDatedFuturesSettlementJob } from './dated-futures-settlement.js';

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
      `H8a: svc-trade dated-futures-settlement is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const POS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXPIRY = new Date('2026-12-26T08:00:00.000Z');
const AFTER = new Date('2026-12-26T08:00:01.000Z');

function longPosition() {
  return {
    positionId: POS,
    userId: ALICE,
    side: 'long' as const,
    size: amt('1'),
    entryPrice: amt('100'),
    margin: amt('20'),
    marginAsset: 'USDT',
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

describe('dated futures settlement hitch (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('router.ts not recut; mill never last-trade exitPrice; listing refuse kept', () => {
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(routerSrc).not.toMatch(/runDatedFuturesSettlementJob/);
    expect(routerSrc).not.toMatch(/dated-futures-settlement/);
    const mill = readFileSync(join(here, 'dated-futures-settlement.ts'), 'utf8');
    expect(mill).toMatch(/void input\.lastTradePrice/);
    expect(mill).toMatch(/void input\.markPrice/);
    expect(mill).toMatch(/runDatedFuturesExpiryTick/);
    expect(mill).toMatch(/planClose/);
    expect(mill).toMatch(/dated-settle:/);
    expect(mill).toMatch(/source: 'owner_fixing'/);
    expect(mill).not.toMatch(/exitPrice:\s*input\.lastTradePrice/);
    expect(mill).not.toMatch(/settlementPrice.*=.*lastTrade/);
    expect(mill).not.toMatch(/settlementPrice.*=.*markPrice/);
    const dated = readFileSync(join(here, 'dated-futures.ts'), 'utf8');
    expect(dated).toMatch(/TRADE_FUTURES_SETTLEMENT_FIXING/);
    expect(dated).toMatch(/dated_futures_fixing_unconfigured/);
    try {
      resolveDatedFuturesListing({
        kind: 'futures',
        futuresContractStyle: 'dated',
        expiryAt: EXPIRY,
        settlementFixingConfigured: '',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TradeError);
      expect((err as TradeError).code).toBe(DATED_FUTURES_FIXING_UNCONFIGURED);
      expect((err as Error).message).toContain('TRADE_FUTURES_SETTLEMENT_FIXING');
    }
  });
});

describe('dated futures settlement mill (hermetic)', () => {
  it('owner decimal fixing settles; posts balanced planClose recipes; never last trade 1 or mark 2', async () => {
    const ledger = new MemoryLedger();
    await seedMarginAndProfitPot(ledger);
    const before = ledger.journal().length;
    const result = await runDatedFuturesSettlementJob({
      style: 'dated',
      expiryAt: EXPIRY,
      now: AFTER,
      ownerSettlementPrice: '110',
      lastTradePrice: '1',
      markPrice: '2',
      positions: [longPosition()],
      ledger,
    });
    expect(result).toMatchObject({
      status: 'settled',
      settlementPrice: '110',
      source: 'owner_fixing',
      settlementIds: [datedSettlementIdFor(POS)],
    });
    expect(result.posts.map((p) => p.reason)).toEqual(['futures.profit.realized', 'futures.margin.release']);
    expect(result.posts[0]!.idempotencyKey).toBe(`futures.profit:${datedSettlementIdFor(POS)}:profit`);
    expect(ledger.journal().length).toBe(before + 2);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', POS))).amount)).toBe('0');
    // 1000 - 20 lock + 10 profit + 20 release = 1010. Clearing pot 50 - 10 = 40.
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('1010');
    expect(formatAmount((await ledger.balance(futuresLossSink('USDT'))).amount)).toBe('40');
    // House trade fees never pay a winner.
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('blank ownerSettlementPrice refuses dated_futures_settlement_price_unset; posts empty', async () => {
    const ledger = new MemoryLedger();
    await seedMarginAndProfitPot(ledger);
    const before = ledger.journal().length;
    const result = await runDatedFuturesSettlementJob({
      style: 'dated',
      expiryAt: EXPIRY,
      now: AFTER,
      ownerSettlementPrice: '',
      lastTradePrice: '1',
      markPrice: '2',
      positions: [longPosition()],
      ledger,
    });
    expect(result).toEqual({
      status: 'refused',
      reason: 'settlement_price_unset',
      code: DATED_FUTURES_SETTLEMENT_PRICE_UNSET,
      posts: [],
    });
    expect(ledger.journal()).toHaveLength(before);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', POS))).amount)).toBe('20');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});

describe('svc-trade dated futures settlement F3 money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

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

  it('schema CHECK still refuses dated listing with blank futures_settlement_fixing', async () => {
    await expect(
      sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at,
          futures_contract_style, futures_expiry_at, futures_settlement_fixing
        ) VALUES (
          ${MARKET}, 'BTC/USDT:USDT-251226', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1',
          10, 20, 'active', 'BTC dated', now(),
          'dated', ${EXPIRY}, ''
        )
      `,
    ).rejects.toThrow();
  });
});
