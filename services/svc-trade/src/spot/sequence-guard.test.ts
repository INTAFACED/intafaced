import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkEngineSequences, describeRegressions } from './sequence-guard.js';
import { StubMatching, StubPerks, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';

import type { Market } from './types.js';

/**
 * THE ENGINE FORGOT, AND THE PROBE SAYS SO.
 *
 * `insertFillLeg` (#899) already refuses a reused sequence at settlement, so
 * nothing is mis-settled either way. What this guard changes is WHO FINDS OUT:
 * a load balancer reading `/ready`, or the first user whose order is refused.
 *
 * The assertions are therefore about the three answers that are easy to get
 * wrong — behind, ahead, and cannot tell — and specifically about not
 * collapsing the third into either of the others.
 */

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
      `H8a: svc-trade sequence-guard is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade sequence-guard (H8a PG-hard)', () => {
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

  let trade: TradeService;
  let btcusdt: Market;

  beforeEach(async () => {
    await sql`TRUNCATE trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    trade = new TradeService(sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
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

    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `a-${Math.random()}` }),
    );
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'BTC', amount: amt('10'), rail: 'test', railRef: `b-${Math.random()}` }));
  });

  /** Record a settled fill at a chosen sequence, without going through the engine. */
  async function recordFillAt(sequence: number): Promise<void> {
    const orderId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    await sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, side, type, price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps
      ) VALUES (
        ${orderId}, ${BOB}, ${btcusdt.id}, 'sell', 'limit', ${'100'}::numeric, ${'1'}::numeric,
        'open', 'GTC', 'BTC', ${'1'}::numeric, 0
      )
    `;
    await sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${orderId}, ${orderId}, ${orderId}, ${btcusdt.id}, ${BOB}, 'sell', 'maker',
        ${'100'}::numeric, ${'1'}::numeric, ${'100'}::numeric, 'USDT', ${'0'}::numeric, 0, ${sequence}
      )
    `;
  }

  const guard = (engineSequence: (marketId: string) => Promise<number | null>) =>
    checkEngineSequences({ sql, markets: () => trade.markets(50), engineSequence });

  it('REPORTS a counter that is behind what we already settled', async () => {
    await recordFillAt(500);

    // The engine came back with an empty journal and restarted at 3.
    const result = await guard(async () => 3);

    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]?.engineSequence).toBe(3);
    expect(result.regressions[0]?.recordedSequence).toBe(500);
    expect(result.regressions[0]?.symbol).toBe('BTC/USDT');
    expect(result.checked).toBe(1);
  });

  it('is quiet when the engine is ahead, which is the healthy shape', async () => {
    await recordFillAt(500);

    // Always ahead in a healthy system: the engine spends a sequence on every
    // accept and cancel too, not only on fills.
    const result = await guard(async () => 812);

    expect(result.regressions).toHaveLength(0);
    expect(result.checked).toBe(1);
  });

  it('treats EQUAL as healthy — the last operation was the last recorded fill', async () => {
    await recordFillAt(42);
    const result = await guard(async () => 42);
    expect(result.regressions).toHaveLength(0);
  });

  it('does not judge a market that has never traded', async () => {
    // No fills: there is nothing to be behind of, and a fresh engine at 0 is
    // correct rather than corrupt.
    const result = await guard(async () => 0);

    expect(result.regressions).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.unjudged).toBe(1);
  });

  it('does not judge a market the engine holds no book for', async () => {
    await recordFillAt(500);

    // An idle or unlisted market legitimately has no book. Calling that
    // corruption would make the alarm noise, and an alarm that cries wolf is
    // one somebody switches off.
    const result = await guard(async () => null);

    expect(result.regressions).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.unjudged).toBe(1);
  });

  it('counts unjudged separately from healthy, so a probe cannot round up', async () => {
    await recordFillAt(500);
    const result = await guard(async () => null);

    // `checked: 0, unjudged: 1` and `checked: 1, unjudged: 0` are different
    // facts. A boolean would render both as ready.
    expect(result.checked).not.toBe(result.unjudged);
  });

  it('names the market and both numbers, because a count cannot be acted on', () => {
    const message = describeRegressions([{ marketId: 'm-1', symbol: 'BTC/USDT', engineSequence: 3, recordedSequence: 500 }]);

    expect(message).toContain('BTC/USDT');
    expect(message).toContain('3');
    expect(message).toContain('500');
    expect(message).toContain('journal');
  });
});
