import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TradeService } from '../controls/test-admission.js';
import { presentTicker } from '../public-rest.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import { buildSparkline, createTickerStatsReader, queryTickerStats, TICKER_WINDOW_MS } from './ticker-stats.js';
import type { Market } from './types.js';

/**
 * ROLLING 24 h TICKER + HOURLY SPARKLINE, FROM REAL FILLS (PG-hard).
 *
 * The public `/tickers` row used to hard-code null for open/high/low/vwap/
 * change/percentage/volumes. These tests pin the numbers against a real
 * Postgres: empty market, a market younger than 24 h, a full window, several
 * markets in one statement, seeded/maker rows excluded, and exact decimals.
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
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade ticker-stats is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SESSION = '99999999-9999-4999-8999-999999999999';
const HOUR = 3_600_000;
/** 12:30 UTC — mid-hour, so the current (partial) hour is 12:00. */
const NOW = Date.parse('2026-10-13T12:30:00.000Z');

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('buildSparkline (pure)', () => {
  const p = (s: string) => amt(s);
  const currentHour = Math.floor(NOW / HOUR);

  it('no trades ever → empty, never padded', () => {
    expect(buildSparkline({ nowMs: NOW, carryIn: null, closesByHour: new Map() })).toEqual([]);
  });

  it('carry-in only → a flat 24-point line at the last real price', () => {
    const line = buildSparkline({ nowMs: NOW, carryIn: p('5'), closesByHour: new Map() });
    expect(line).toHaveLength(24);
    expect(new Set(line.map(formatAmount))).toEqual(new Set(['5']));
  });
});

describe('svc-trade ticker-stats (H8a PG-hard)', () => {
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
  let btc: Market;
  let eth: Market;
  let sol: Market;
  let seq = 0;

  async function list(symbol: string, base: string): Promise<Market> {
    return trade.listMarket({
      symbol,
      baseAsset: base,
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
  }

  beforeEach(async () => {
    await sql`TRUNCATE trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    seq = 0;
    trade = new TradeService(sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    btc = await list('BTC/USDT', 'BTC');
    eth = await list('ETH/USDT', 'ETH');
    sol = await list('SOL/USDT', 'SOL');
  });

  async function order(marketId: string, seeded: boolean): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, side, type, price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, session_id, seeded
      ) VALUES (
        ${id}, ${BOB}, ${marketId}, 'sell', 'limit', ${'1'}::numeric, ${'1'}::numeric,
        'filled', 'GTC', 'BTC', ${'0'}::numeric, 0, ${SESSION}, ${seeded}
      )`;
    return id;
  }

  /** One real match: a taker leg (what the tape/candles read) and a maker leg. */
  async function trade_(
    market: Market,
    price: string,
    qty: string,
    ts: number,
    opts: { seeded?: boolean; liquidity?: 'taker' | 'maker' } = {},
  ): Promise<void> {
    const a = await order(market.id, opts.seeded === true);
    const b = await order(market.id, false);
    seq += 1;
    const quote = (amt(price) * amt(qty)) / 10n ** 18n;
    await sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence, ts
      ) VALUES (
        ${randomUUID()}, ${a}, ${b}, ${market.id}, ${BOB}, 'sell', ${opts.liquidity ?? 'taker'},
        ${price}::numeric, ${qty}::numeric, ${formatAmount(quote)}::numeric, 'USDT', ${'0'}::numeric, 0, ${seq}, ${new Date(ts)}
      )`;
  }

  const ago = (ms: number) => NOW - ms;

  it('empty market: entry exists, every rollup null, no sparkline, no windowStart', async () => {
    const stats = (await queryTickerStats(sql, [btc.id], NOW)).get(btc.id)!;
    expect(stats).toMatchObject({ open: null, high: null, low: null, vwap: null, baseVolume: null, quoteVolume: null, windowStart: null });
    expect(stats.sparkline).toEqual([]);

    const wire = presentTicker('BTC/USDT', { bids: [], asks: [], sequence: 0 }, null, NOW, stats, { sparkline: true });
    expect(wire.open).toBeNull();
    expect(wire.change).toBeNull();
    expect(wire.percentage).toBeNull();
    expect(wire.windowStart).toBeNull();
    expect(wire.sparkline).toEqual([]);
  });

  it('partial window (market is 3 h old): stats cover only what exists, windowStart is the first trade', async () => {
    const first = ago(3 * HOUR + 10 * 60_000); // 09:20
    await trade_(btc, '100', '1', first);
    await trade_(btc, '110', '2', ago(2 * HOUR)); // 10:30
    await trade_(btc, '90', '1', ago(30 * 60_000)); // 12:00 sharp: current hour
    const stats = (await queryTickerStats(sql, [btc.id], NOW)).get(btc.id)!;

    expect(formatAmount(stats.open!)).toBe('100');
    expect(formatAmount(stats.high!)).toBe('110');
    expect(formatAmount(stats.low!)).toBe('90');
    expect(formatAmount(stats.baseVolume!)).toBe('4');
    expect(formatAmount(stats.quoteVolume!)).toBe('410'); // 100 + 220 + 90
    expect(formatAmount(stats.vwap!)).toBe('102.5');
    expect(stats.windowStart).toBe(first); // < 24 h of history → UI says "since 09:20"
    expect(stats.windowStart!).toBeGreaterThan(NOW - TICKER_WINDOW_MS);

    // Hours 09,10,11,12 — 11:00 was silent and repeats 10:00's close.
    expect(stats.sparkline.map(formatAmount)).toEqual(['100', '110', '110', '90']);
  });

  it('full window: open is the first trade AT OR AFTER now-24h; the older print is only carried into the sparkline', async () => {
    await trade_(btc, '80', '5', ago(30 * HOUR));
    await trade_(btc, '100', '1', ago(24 * HOUR)); // exactly on the boundary: counts as in-window
    await trade_(btc, '120', '1', ago(HOUR + 5 * 60_000)); // 11:25
    const stats = (await queryTickerStats(sql, [btc.id], NOW)).get(btc.id)!;

    expect(formatAmount(stats.open!)).toBe('100'); // not 80
    expect(formatAmount(stats.low!)).toBe('100'); // the 30 h-old 80 is out of the window
    expect(formatAmount(stats.high!)).toBe('120');
    expect(formatAmount(stats.baseVolume!)).toBe('2');
    expect(stats.windowStart).toBe(NOW - TICKER_WINDOW_MS);

    expect(stats.sparkline).toHaveLength(24);
    const line = stats.sparkline.map(formatAmount);
    // Slot 0 is 13:00 yesterday (now=12:30 → hours 13:00 … 12:00). The boundary fill
    // at 12:30 yesterday lands in the 12:00 hour, which is BEFORE slot 0, so slot 0
    // repeats it (100). The 11:25 print closes the 11:00 slot.
    expect(line[0]).toBe('100');
    expect(line[22]).toBe('120'); // 11:00 today
    expect(line[23]).toBe('120'); // silent current hour repeats
    expect(line.every((v) => v !== '' && v !== 'null')).toBe(true);
  });

  it('only trades older than 24 h: rollups null (honest), sparkline is a flat line of the last real price', async () => {
    await trade_(btc, '80', '5', ago(40 * HOUR));
    await trade_(btc, '82', '5', ago(30 * HOUR));
    const stats = (await queryTickerStats(sql, [btc.id], NOW)).get(btc.id)!;
    expect(stats.open).toBeNull();
    expect(stats.baseVolume).toBeNull();
    expect(stats.windowStart).toBe(NOW - TICKER_WINDOW_MS);
    expect(stats.sparkline).toHaveLength(24);
    expect(new Set(stats.sparkline.map(formatAmount))).toEqual(new Set(['82']));
  });

  it('many markets in one call, kept apart; seeded and maker rows never count', async () => {
    await trade_(btc, '100', '1', ago(5 * HOUR));
    await trade_(btc, '104', '1', ago(HOUR));
    await trade_(eth, '10', '3', ago(2 * HOUR));
    await trade_(eth, '9999', '1', ago(HOUR), { seeded: true }); // seeded: ignored
    await trade_(eth, '8888', '1', ago(HOUR), { liquidity: 'maker' }); // maker leg: ignored
    // sol: nothing
    const all = await queryTickerStats(sql, [btc.id, eth.id, sol.id, btc.id], NOW);

    expect(all.size).toBe(3);
    expect(formatAmount(all.get(btc.id)!.high!)).toBe('104');
    expect(formatAmount(all.get(eth.id)!.high!)).toBe('10');
    expect(formatAmount(all.get(eth.id)!.baseVolume!)).toBe('3');
    expect(all.get(sol.id)!.open).toBeNull();
    expect(all.get(sol.id)!.sparkline).toEqual([]);
  });

  it('decimals stay exact: 0.1 -> 0.3 is +200 %, a third is not a float, 18-place dust survives', async () => {
    await trade_(btc, '0.1', '3', ago(2 * HOUR));
    await trade_(btc, '0.3', '3', ago(HOUR));
    await trade_(eth, '0.000000000000000001', '1', ago(HOUR));
    const all = await queryTickerStats(sql, [btc.id, eth.id], NOW);

    const b = all.get(btc.id)!;
    expect(formatAmount(b.quoteVolume!)).toBe('1.2'); // 0.3 + 0.9, no 1.2000000000000002
    expect(formatAmount(b.vwap!)).toBe('0.2');
    const last = {
      id: 't',
      side: 'buy' as const,
      price: amt('0.3'),
      qty: amt('3'),
      quoteAmount: amt('0.9'),
      sequence: 2,
      ts: new Date(ago(HOUR)),
    };
    const wire = presentTicker('BTC/USDT', { bids: [], asks: [], sequence: 0 }, last, NOW, b, { sparkline: true });
    expect(wire.open).toBe('0.1');
    expect(wire.change).toBe('0.2');
    expect(wire.percentage).toBe('200');
    expect((wire.sparkline ?? []).every((s) => typeof s === 'string')).toBe(true);

    expect(formatAmount(all.get(eth.id)!.high!)).toBe('0.000000000000000001');
  });

  it('reader: a warm cache serves without the database, an expired entry is refreshed', async () => {
    const read = createTickerStatsReader(sql, { ttlMs: 3000 });
    await trade_(btc, '100', '1', ago(HOUR));
    const first = (await read([btc.id], NOW)).get(btc.id)!;
    expect(formatAmount(first.high!)).toBe('100');

    await trade_(btc, '200', '1', ago(60_000));
    const warm = (await read([btc.id], NOW + 2000)).get(btc.id)!;
    expect(formatAmount(warm.high!)).toBe('100'); // cached: no query ran

    const cold = (await read([btc.id], NOW + 3000)).get(btc.id)!;
    expect(formatAmount(cold.high!)).toBe('200'); // TTL passed: refreshed
  });
});
