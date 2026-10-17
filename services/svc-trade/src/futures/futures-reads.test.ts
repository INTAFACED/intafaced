/**
 * Futures desk reads that do not need Postgres: the TEST seed refuses to
 * invent a listing, the public board hides it until the flag is on, and a
 * blank production leverage cap still refuses an open.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, userAvailable } from '@intafaced/ledger-client';
import { parseAmount } from '@intafaced/ledger-client';
import { registerPublicRest, fakeMarket, type PublicRestDeps } from '../public-rest.js';
import { PositionService } from './position-service.js';
import { parseConfiguredMaxLeverage } from './initial-margin.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { memoryMarkBook } from './mark-source.js';

interface FuturesTestSeed {
  SeedRefusal: new (message: string) => Error;
  databaseLooksLocalOrTest(name: string): boolean;
  evaluateSeedRequest(input: {
    env: Record<string, string | undefined>;
    fixturePath?: string | null;
    fixtureText?: string | null;
    cli?: Record<string, string | undefined>;
  }): { listing: { displayName: string; leverageCap: string; markFeed: string; liquidationPolicy: string } };
}

async function loadFuturesTestSeed(): Promise<FuturesTestSeed> {
  // The script is plain JS outside this package root. The cast is the contract these tests call.
  // @ts-expect-error no declaration file for the local seed script
  return import('../../../../tooling/scripts/seed-futures-test-listing.mjs');
}

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', '..', '..', '..', 'tooling/scripts/seed-futures-test-listing.mjs');
const fixturePath = join(here, '..', '..', 'fixtures/btc-usdt-swap.TEST.json');
const fixtureText = readFileSync(fixturePath, 'utf8');

const testSwap = {
  ...fakeMarket({ symbol: 'BTC/USDT:USDT', kind: 'futures' }),
  test: true,
  displayName: 'BTC/USDT:USDT TEST',
  testFixture: {
    leverageCap: '5',
    markFeed: 'TEST-mark-feed',
    liquidationPolicy: 'TEST-liquidation-policy',
  },
};

function publicDeps(markets: PublicRestDeps['markets']): PublicRestDeps {
  return {
    markets,
    marketBySymbol: async () => null,
    depth: async () => ({ bids: [], asks: [], sequence: 0 }),
    publicTape: async () => [],
    candles: async () => [],
  };
}

describe('TEST futures seed', () => {
  it('exits non-zero when the explicit values are missing', async () => {
    const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/refusing/);

    const { evaluateSeedRequest, SeedRefusal } = await loadFuturesTestSeed();
    expect(() => evaluateSeedRequest({ env: { TRADE_DATABASE_URL: 'postgres://127.0.0.1/intafaced_test' }, cli: {} })).toThrow(SeedRefusal);
    expect(() =>
      evaluateSeedRequest({
        env: { TRADE_DATABASE_URL: 'postgres://127.0.0.1/intafaced_test', NODE_ENV: 'test' },
        fixturePath: 'listing.json',
        fixtureText,
      }),
    ).toThrow(/marked TEST/);
  });

  it('refuses a database whose name is not local or test', async () => {
    const { databaseLooksLocalOrTest } = await loadFuturesTestSeed();
    expect(databaseLooksLocalOrTest('intafaced')).toBe(false);
    expect(databaseLooksLocalOrTest('intafaced_test')).toBe(true);
    expect(databaseLooksLocalOrTest('test')).toBe(true);
    const refused = spawnSync(process.execPath, [script, '--fixture', fixturePath], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', TRADE_DATABASE_URL: 'postgres://127.0.0.1:1/intafaced' },
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/does not look like a local or test database/);
    expect(refused.stderr).not.toMatch(/ECONNREFUSED|connect/i);
  });

  it('accepts the TEST fixture without touching the production leverage cap', async () => {
    const { evaluateSeedRequest } = await loadFuturesTestSeed();
    const decision = evaluateSeedRequest({
      env: { TRADE_DATABASE_URL: 'postgres://127.0.0.1/local_stack_test', NODE_ENV: 'test' },
      fixturePath,
      fixtureText,
    });
    expect(decision.listing.displayName).toContain('TEST');
    expect(decision.listing.leverageCap).toBe('5');
    expect(decision.listing.markFeed).toBe('TEST-mark-feed');
    expect(decision.listing.liquidationPolicy).toBe('TEST-liquidation-policy');
    expect(parseConfiguredMaxLeverage('')).toBeNull();
    const envSrc = readFileSync(join(here, '..', 'env.ts'), 'utf8');
    expect(envSrc).toMatch(/TRADE_FUTURES_MAX_LEVERAGE:\s*z\.string\(\)\.default\(''\)/);
    expect(envSrc).toMatch(/TRADE_FUTURES_TEST_SEED:[\s\S]*?\.default\(false\)/);
    expect(envSrc).toMatch(/TRADE_FUTURES_ENABLED:[\s\S]*?\.default\(false\)/);
    const seedSrc = readFileSync(script, 'utf8');
    expect(seedSrc).not.toMatch(/TRADE_FUTURES_ENABLED\s*=/);
    expect(seedSrc).not.toMatch(/TRADE_FUTURES_MAX_LEVERAGE\s*=/);
  });
});

describe('GET /api/v1/markets TEST listing', () => {
  it('hides the futures market until the seed flag is on, then labels it TEST', async () => {
    const markets = async () => [fakeMarket({ symbol: 'BTC/USDT' }), testSwap];
    const off = Fastify();
    registerPublicRest(off, publicDeps(markets));
    const hidden = await off.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().some((row: { swap?: boolean }) => row.swap === true)).toBe(false);
    expect(JSON.stringify(hidden.json())).not.toContain('TEST');

    const on = Fastify();
    registerPublicRest(on, { ...publicDeps(markets), futuresTestSeed: true });
    const shown = await on.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(shown.statusCode).toBe(200);
    const swap = shown.json().find((row: { symbol: string }) => row.symbol === 'BTC/USDT:USDT');
    expect(swap.test).toBe(true);
    expect(swap.displayName).toContain('TEST');
    expect(swap.limits.leverage.max).toBe('5');
    expect(swap.markFeed).toBe('TEST-mark-feed');
    expect(swap.liquidationPolicy).toBe('TEST-liquidation-policy');
    expect(swap.orderable).toBe(false);
    expect(shown.json().some((row: { symbol: string }) => row.symbol === 'BTC/USDT')).toBe(true);
    await off.close();
    await on.close();
  });
});

describe('open with a blank leverage cap', () => {
  it('refuses trade.leverage_cap_unset and does not read a balance', async () => {
    const sql = (async (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('FROM trade.markets')) {
        return [
          {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            symbol: 'BTC/USDT:USDT',
            kind: 'futures',
            status: 'active',
            quote_asset: 'USDT',
            futures_contract_style: 'perpetual',
            futures_expiry_at: null,
            futures_settlement_fixing: null,
          },
        ];
      }
      throw new Error(`unexpected sql ${text}`);
    }) as unknown as ConstructorParameters<typeof PositionService>[0];
    const ledger = new MemoryLedger();
    const positions = new PositionService(sql, ledger, {
      marks: memoryMarkBook().source(),
      profitSource: profitSourceFromConfig(formatAccountRef(recipeProfitFundingAccount('USDT'))),
      now: () => new Date('2026-08-06T12:00:00.000Z'),
    });
    await expect(
      positions.open({
        clientOpenId: 'blank-cap',
        userId: '11111111-1111-4111-8111-111111111111',
        symbol: 'BTC/USDT:USDT',
        side: 'long',
        size: parseAmount('1'),
        leverage: parseAmount('5'),
      }),
    ).rejects.toMatchObject({ code: 'trade.leverage_cap_unset', status: 503 });
    expect((await ledger.balance(userAvailable('11111111-1111-4111-8111-111111111111', 'USDT'))).amount).toBe(0n);
  });
});
