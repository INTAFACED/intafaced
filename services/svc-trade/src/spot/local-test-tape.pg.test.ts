/**
 * LOCAL TEST tape retime against real Postgres: only `fills.ts` moves, only on a tape-only market, only into the past.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queryCandlesFromFills } from './candles.js';
import { LocalTestTapeError, retimeLocalTestTape } from './local-test-tape.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const MARKET = '22222222-2222-4222-8222-222222222222';
const MAKER = '33333333-3333-4333-8333-333333333333';
const TAKER = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-23T00:00:00.000Z');
const STEP = 15 * 60 * 1000;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_local_test_tape_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const hex = (n: number, width = 12) => n.toString(16).padStart(width, '0');

describe('LOCAL TEST tape retime (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    await db.sql`
      INSERT INTO trade.markets (id, symbol, display_name, base_asset, quote_asset, tick_size, lot_size, min_qty, max_qty, min_notional, maker_bps, taker_bps)
      VALUES (${MARKET}, 'BTC/USDT', 'BTC/USDT', 'BTC', 'USDT', '0.01', '0.0001', '0.0001', '1000', '1', 10, 20)`;
  });

  async function order(n: number, user: string, clientOrderId: string | null, seeded = false): Promise<string> {
    const id = `55555555-5555-4555-8555-${hex(n)}`;
    await db.sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, hold_asset, hold_amount, seeded)
      VALUES (${id}, ${user}, ${MARKET}, ${clientOrderId}, ${user === MAKER ? 'sell' : 'buy'}, 'limit', '100', '1', '1', 'filled', 'USDT', '100', ${seeded})`;
    return id;
  }

  /** One match: a maker and a taker leg sharing the engine sequence, both written "now" as the real path does. */
  async function match(sequence: number, opts: { makerClient?: string | null; takerClient?: string | null; seeded?: boolean } = {}) {
    const makerOrder = await order(sequence * 2, MAKER, opts.makerClient === undefined ? `LTEST-TAPE-r1-m${sequence}` : opts.makerClient);
    const takerOrder = await order(
      sequence * 2 + 1,
      TAKER,
      opts.takerClient === undefined ? `LTEST-TAPE-r1-t${sequence}` : opts.takerClient,
      opts.seeded ?? false,
    );
    for (const [leg, own, other, user] of [
      ['maker', makerOrder, takerOrder, MAKER],
      ['taker', takerOrder, makerOrder, TAKER],
    ] as const) {
      await db.sql`
        INSERT INTO trade.fills (id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount,
                                 fee_asset, fee_amount, fee_bps, sequence, ts)
        VALUES (${`66666666-6666-4666-8666-${hex(sequence * 2 + (leg === 'taker' ? 1 : 0))}`}, ${own}, ${other}, ${MARKET}, ${user},
                ${leg === 'maker' ? 'sell' : 'buy'}, ${leg}, '100', '1', '100', 'USDT', '0.1', 10, ${sequence}, ${NOW.toISOString()})`;
    }
  }

  const fillRows = () =>
    db.sql<Array<{ sequence: number; liquidity: string; ts: Date; price: string; qty: string; fee_amount: string }>>`
      SELECT sequence, liquidity, ts, price::text, qty::text, fee_amount::text FROM trade.fills ORDER BY sequence, liquidity`;

  const code = async (p: Promise<unknown>) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LocalTestTapeError);
    return (error as LocalTestTapeError).code;
  };

  it('moves both legs of each match to start + i * step, in sequence order, and nothing else', async () => {
    for (const seq of [3, 7, 9]) await match(seq);
    const before = await fillRows();
    const startMs = NOW.getTime() - 3 * STEP;
    const result = await retimeLocalTestTape(db.sql, { marketId: MARKET, startMs, stepMs: STEP }, NOW);
    expect(result).toEqual({
      marketId: MARKET,
      trades: 3,
      fills: 6,
      firstTs: new Date(startMs).toISOString(),
      lastTs: new Date(startMs + 2 * STEP).toISOString(),
    });
    const after = await fillRows();
    expect(after.map((r) => [r.sequence, r.liquidity, r.ts.getTime()])).toEqual([
      [3, 'maker', startMs],
      [3, 'taker', startMs],
      [7, 'maker', startMs + STEP],
      [7, 'taker', startMs + STEP],
      [9, 'maker', startMs + 2 * STEP],
      [9, 'taker', startMs + 2 * STEP],
    ]);
    expect(after.map(({ ts: _ts, ...rest }) => rest)).toEqual(before.map(({ ts: _ts, ...rest }) => rest));
    // The candles route now serves one past bucket per trade.
    const candles = await queryCandlesFromFills(db.sql, { marketId: MARKET, timeframe: '15m', limit: 10 });
    expect(candles.map((c) => c.openTimeMs)).toEqual([startMs, startMs + STEP, startMs + 2 * STEP]);
    // The same input again writes the same times.
    await retimeLocalTestTape(db.sql, { marketId: MARKET, startMs, stepMs: STEP }, NOW);
    expect((await fillRows()).map((r) => r.ts.getTime())).toEqual(after.map((r) => r.ts.getTime()));
  });

  it('refuses a market with any fill that is not a tape trade, and moves nothing', async () => {
    await match(1);
    await match(2, { takerClient: 'customer-order-1' });
    const startMs = NOW.getTime() - 4 * STEP;
    expect(await code(retimeLocalTestTape(db.sql, { marketId: MARKET, startMs, stepMs: STEP }, NOW))).toBe(
      'trade.local_test_tape_not_tape_only',
    );
    expect((await fillRows()).every((r) => r.ts.getTime() === NOW.getTime())).toBe(true);
  });

  it.each([
    ['a maker without a client id', { makerClient: null }],
    ['a seeded tape order', { seeded: true }],
    ['a lowercase prefix', { makerClient: 'ltest-tape-r1-m1' }],
  ])('refuses %s', async (_label, opts) => {
    await match(1, opts);
    expect(await code(retimeLocalTestTape(db.sql, { marketId: MARKET, startMs: NOW.getTime() - STEP, stepMs: STEP }, NOW))).toBe(
      'trade.local_test_tape_not_tape_only',
    );
  });

  it('refuses an empty or unknown market', async () => {
    const input = { startMs: NOW.getTime() - STEP, stepMs: STEP };
    expect(await code(retimeLocalTestTape(db.sql, { marketId: MARKET, ...input }, NOW))).toBe('trade.local_test_tape_empty');
    expect(await code(retimeLocalTestTape(db.sql, { marketId: '77777777-7777-4777-8777-777777777777', ...input }, NOW))).toBe(
      'trade.local_test_tape_market_unknown',
    );
  });

  it('refuses times that reach now or the future, or start more than 31 days back', async () => {
    await match(1);
    await match(2);
    // Last trade would land exactly on now.
    expect(await code(retimeLocalTestTape(db.sql, { marketId: MARKET, startMs: NOW.getTime() - STEP, stepMs: STEP }, NOW))).toBe(
      'trade.local_test_tape_window_invalid',
    );
    const tooOld = NOW.getTime() - 32 * 24 * 60 * 60 * 1000;
    expect(await code(retimeLocalTestTape(db.sql, { marketId: MARKET, startMs: tooOld, stepMs: STEP }, NOW))).toBe(
      'trade.local_test_tape_window_invalid',
    );
    expect((await fillRows()).every((r) => r.ts.getTime() === NOW.getTime())).toBe(true);
  });
});
