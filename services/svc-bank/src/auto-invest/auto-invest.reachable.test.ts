import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable, formatAmount } from '@intafaced/ledger-client';
import { createBankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { BankError } from '../errors.js';
import type { ConvertPort } from './auto-invest-service.js';
import { tradeConvertPort } from './trade-convert-port.js';

/**
 * CAN INDEX WIRE CONVERT? (bank.auto-invest — same missing-wiring shape as cards)
 *
 * auto-invest.test.ts injects ConvertPort on createBankServices. That cannot
 * prove index.ts passes `autoInvest.convert`. Before this pin, convert lived
 * only in tests; production always refused rate_unset.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..', '..');
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER_A = '11111111-1111-4111-8111-111111111111';
const EDGE = 'a-bank-auto-invest-convert-edge-secret-32ch';

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
      `H8a: svc-bank auto-invest.reachable is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('index.ts boot-wires autoInvest.convert (cards/ramps shape)', () => {
  const indexSrc = readFileSync(join(ROOT, 'services/svc-bank/src/index.ts'), 'utf8');

  it('passes convert into createBankServices autoInvest when TRADE_URL is usable', () => {
    expect(indexSrc).toMatch(/tradeConvertPort/);
    expect(indexSrc).toMatch(/usableTradeConvertUrl\(env\.TRADE_URL\)/);
    expect(indexSrc).toMatch(/convert:\s*tradeConvertPort\(/);
    expect(indexSrc).toMatch(/marketsLimit:\s*env\.CONVERT_MARKETS_LIMIT/);
    expect(indexSrc).not.toMatch(/marketsLimit:\s*50/);
    expect(indexSrc).toMatch(/autoInvest:\s*\{/);
  });

  it('would go red if convert were dropped from the autoInvest boot object', () => {
    const autoBlock = indexSrc.slice(indexSrc.indexOf('autoInvest: {'));
    const slice = autoBlock.slice(0, 900);
    expect(slice).toMatch(/convert:\s*tradeConvertPort/);
    expect(indexSrc).not.toMatch(/autoInvest:\s*\{\s*enabled:\s*env\.AUTO_INVEST_ENABLED\s*\}/);
  });

  it('live job path is tradeConvertPort convert.quote — not a bank mid', () => {
    const serviceSrc = readFileSync(join(here, 'auto-invest-service.ts'), 'utf8');
    const portSrc = readFileSync(join(here, 'trade-convert-port.ts'), 'utf8');
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(indexSrc).toMatch(/\/internal\/jobs\/run-auto-invest/);
    expect(indexSrc).toMatch(/bank\.autoInvest\.runDue/);
    expect(routerSrc).toMatch(/runAutoInvest:/);
    expect(routerSrc).toMatch(/autoInvest\.runDue/);
    expect(serviceSrc).toMatch(/this\.convert\.convert\(/);
    expect(portSrc).toMatch(/\/trpc\/standing\.quote/);
    expect(portSrc).toMatch(/\/trpc\/standing\.execute/);
    expect(portSrc).toMatch(/query:\s*\{\s*limit:\s*String\(page\)\s*\}/);
    expect(portSrc).toMatch(/assertConvertMarketsListLimit/);
    expect(portSrc).not.toMatch(/path:\s*'\/api\/v1\/markets'\s*\}/);
  });
});

describe('auto-invest.reachable (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('boot-shaped createBankServices convert wiring', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.auto_invest_runs, bank.auto_invest_rules,
               bank.interest_accruals, bank.earn_positions, bank.earn_pools,
               bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  async function fund(userId: string, assetId: string, value: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId,
        amount: amt(value),
        rail: 'test',
        railRef: `${userId}:${assetId}:${randomUUID()}`,
      }),
    );
  }

  const fakeConvert = (book: MemoryLedger): ConvertPort => ({
    async convert(input) {
      await book.post(
        recipes.withdrawHold({
          userId: input.userId,
          assetId: input.fromAsset,
          amount: input.fromAmount,
          rail: 'test-convert',
          withdrawalId: input.clientConvertId,
        }),
      );
      await book.post(
        recipes.withdrawSettle({
          userId: input.userId,
          assetId: input.fromAsset,
          amount: input.fromAmount,
          rail: 'test-convert',
          withdrawalId: input.clientConvertId,
        }),
      );
      await book.post(
        recipes.deposit({
          userId: input.userId,
          assetId: input.toAsset,
          amount: input.fromAmount,
          rail: 'test-convert',
          railRef: `${input.clientConvertId}:in`,
        }),
      );
      return { toAmount: input.fromAmount, ledgerTxId: `tx:${input.clientConvertId}` };
    },
  });

  it('boot-shaped wiring with a fake convert settles DCA', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      autoInvest: { enabled: true, convert: fakeConvert(ledger) },
    });
    await fund(USER_A, 'USDT', '500');
    const rule = await bank.autoInvest.createDca({
      userId: USER_A,
      spendAssetId: 'USDT',
      buyAssetId: 'BTC',
      amount: amt('100'),
      cadence: 'daily',
      startsAt: new Date('2026-08-01T00:00:00Z'),
    });
    const report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T00:00:00Z'), limit: 200 });
    expect(report.settled).toBe(1);
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'USDT'))).amount)).toBe('400');
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'BTC'))).amount)).toBe('100');
    expect(rule.kind).toBe('dca');
  });

  it('no convert → named refuse', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      autoInvest: { enabled: true },
    });
    await expect(
      bank.autoInvest.createDca({
        userId: USER_A,
        spendAssetId: 'USDT',
        buyAssetId: 'BTC',
        amount: amt('100'),
        cadence: 'daily',
        startsAt: new Date('2026-08-09T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
  });

  it('runDue through tradeConvertPort hits convert.quote — no bank mid', async () => {
    const seen: string[] = [];
    const convert = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      serviceSecret: EDGE,
      marketsLimit: 50,
      fetchImpl: async (input) => {
        const url = String(input);
        seen.push(url);
        if (url.includes('/api/v1/markets')) {
          return jsonResponse(200, [
            {
              symbol: 'BTC/USDT',
              base: 'BTC',
              quote: 'USDT',
              spot: true,
              active: true,
              limits: { amount: { min: '0.001' } },
            },
          ]);
        }
        if (url.includes('/trpc/standing.quote')) {
          return jsonResponse(200, {
            result: {
              data: {
                quoteId: 'q-1',
                symbol: 'BTC/USDT',
                side: 'buy',
                requestedQty: '0.002',
                filledQty: '0.002',
                userNotional: '100',
                avgPrice: '50000',
                fullyFilled: true,
              },
            },
          });
        }
        if (url.includes('/trpc/standing.execute')) {
          return jsonResponse(200, {
            result: {
              data: {
                quoteId: 'q-1',
                fillId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                inAmount: '100',
                outAmount: '0.002',
              },
            },
          });
        }
        return jsonResponse(404, { error: { message: 'unexpected' } });
      },
    });
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      autoInvest: { enabled: true, convert },
    });
    await fund(USER_A, 'USDT', '500');
    const rule = await bank.autoInvest.createDca({
      userId: USER_A,
      spendAssetId: 'USDT',
      buyAssetId: 'BTC',
      amount: amt('100'),
      cadence: 'daily',
      startsAt: new Date('2026-08-01T00:00:00Z'),
    });
    const report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T00:00:00Z'), limit: 200 });
    expect(seen).toContain('http://svc-trade:4004/api/v1/markets?limit=50');
    expect(seen.some((u) => u.includes('/trpc/standing.quote'))).toBe(true);
    expect(seen.some((u) => u.includes('/trpc/standing.execute'))).toBe(true);
    expect(report.settled).toBe(1);
    const runs = await bank.autoInvest.runsOf(rule.id);
    expect(runs[0]?.ledgerTxId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    // HTTP mock is trade's fill — bank does not post a mid or move USDT itself.
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'USDT'))).amount)).toBe('500');
  });

  it('runDue through tradeConvertPort names rate_unset when convert.quote fails', async () => {
    const convert = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      serviceSecret: EDGE,
      marketsLimit: 50,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/api/v1/markets')) {
          return jsonResponse(200, [
            { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } },
          ]);
        }
        return jsonResponse(400, {
          error: { message: 'insufficient book depth', data: { intafacedCode: 'trade.convert_insufficient_depth' } },
        });
      },
    });
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      autoInvest: { enabled: true, convert },
    });
    await fund(USER_A, 'USDT', '500');
    await bank.autoInvest.createDca({
      userId: USER_A,
      spendAssetId: 'USDT',
      buyAssetId: 'BTC',
      amount: amt('100'),
      cadence: 'daily',
      startsAt: new Date('2026-08-01T00:00:00Z'),
    });
    const report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T00:00:00Z'), limit: 200 });
    expect(report.settled).toBe(0);
    expect(report.rejected).toBe(1);
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'USDT'))).amount)).toBe('500');
  });

  it('an execute that times out leaves the run pending, never rejected', async () => {
    const convert = tradeConvertPort({
      baseUrl: 'http://svc-trade:4004',
      serviceSecret: EDGE,
      marketsLimit: 50,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/api/v1/markets')) {
          return jsonResponse(200, [
            { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true, limits: { amount: { min: '0.001' } } },
          ]);
        }
        if (url.includes('/trpc/standing.quote')) {
          return jsonResponse(200, {
            result: {
              data: {
                quoteId: 'q-1',
                symbol: 'BTC/USDT',
                side: 'buy',
                requestedQty: '0.002',
                filledQty: '0.002',
                userNotional: '100',
                avgPrice: '50000',
                fullyFilled: true,
              },
            },
          });
        }
        throw new Error('socket hang up');
      },
    });
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      autoInvest: { enabled: true, convert },
    });
    await fund(USER_A, 'USDT', '500');
    const rule = await bank.autoInvest.createDca({
      userId: USER_A,
      spendAssetId: 'USDT',
      buyAssetId: 'BTC',
      amount: amt('100'),
      cadence: 'daily',
      startsAt: new Date('2026-08-01T00:00:00Z'),
    });
    await bank.autoInvest.runDue({ now: new Date('2026-08-09T00:00:00Z'), limit: 200 }).catch(() => undefined);
    const runs = await bank.autoInvest.runsOf(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('pending');
  });

  it('convert failure does not invent a price', async () => {
    let converted = 0;
    const failing: ConvertPort = {
      async convert() {
        converted += 1;
        throw new BankError('trade.convert_no_liquidity', 'bank.auto_invest_rate_unset');
      },
    };
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      autoInvest: { enabled: true, convert: failing },
    });
    await fund(USER_A, 'USDT', '500');
    await bank.autoInvest.createDca({
      userId: USER_A,
      spendAssetId: 'USDT',
      buyAssetId: 'BTC',
      amount: amt('100'),
      cadence: 'daily',
      startsAt: new Date('2026-08-01T00:00:00Z'),
    });
    const report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T00:00:00Z'), limit: 200 });
    expect(converted).toBe(1);
    expect(report.settled).toBe(0);
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'USDT'))).amount)).toBe('500');
    expect(formatAmount((await ledger.balance(userAvailable(USER_A, 'BTC'))).amount)).toBe('0');
  });
});
