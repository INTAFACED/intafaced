/**
 * The queue fill estimate's volume (J-charts-desk-14 #8), on real Postgres: taker prints at or through a resting order's
 * price, on the side that would fill it, inside the window, one row per match, seeded makers included (the queue the
 * volume is set against counts seeded orders too).
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { tradedThrough } from './trade-service/reads.js';
import type { TradeServiceInternal } from './trade-service.js';

const raw = process.env.TEST_DATABASE_URL?.trim();
if (!raw) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const adminUrl = (() => {
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
})();
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const db: TestDatabase = await createTestDatabase({ service: 'trade', url: adminUrl, migrations });
afterAll(async () => {
  await db.drop();
}, 60_000);
const svc = { sql: db.sql } as unknown as TradeServiceInternal;
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-09T00:00:00.000Z');

async function market(): Promise<string> {
  const symbol = `Q/${randomUUID().slice(0, 8)}`;
  const rows = await db.sql<{ id: string }[]>`
    INSERT INTO trade.markets (symbol, display_name, base_asset, quote_asset, tick_size, lot_size, min_qty, min_notional, maker_bps, taker_bps)
    VALUES (${symbol}, ${symbol}, 'BTC', 'USDT', '0.01', '0.0001', '0.0001', '1', 10, 20)
    RETURNING id`;
  return rows[0]!.id;
}

async function order(marketId: string, side: 'buy' | 'sell', seeded = false): Promise<string> {
  const id = randomUUID();
  await db.sql`INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, seeded
    ) VALUES (${id}, ${USER}, ${marketId}, ${`q-${id.slice(0, 8)}`}, ${side}, 'limit', 100, 1, 'filled', 'GTC', 'USDT', 100, ${seeded})`;
  return id;
}

let seq = 0;
/** One match: the taker leg on `takerSide` and the maker leg, at `price` for `qty`, `agoMs` before NOW. */
async function print(marketId: string, takerSide: 'buy' | 'sell', price: string, qty: string, agoMs: number, seededMaker = false) {
  const taker = await order(marketId, takerSide);
  const maker = await order(marketId, takerSide === 'buy' ? 'sell' : 'buy', seededMaker);
  const ts = new Date(NOW - agoMs);
  seq += 1;
  const quote = (parseAmount(price) * parseAmount(qty)) / 10n ** 18n;
  for (const [own, counter, side, liquidity] of [
    [taker, maker, takerSide, 'taker'],
    [maker, taker, takerSide === 'buy' ? 'sell' : 'buy', 'maker'],
  ] as const) {
    await db.sql`INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence, ts
      ) VALUES (
        ${randomUUID()}, ${own}, ${counter}, ${marketId}, ${USER}, ${side}, ${liquidity}, ${price}, ${qty},
        ${formatAmount(quote)}, 'USDT', 0, 0, ${seq}, ${ts}
      )`;
  }
}

describe('tradedThrough', () => {
  it('a resting buy at 100 counts taker sells at or below 100 inside the window, once per match', async () => {
    const m = await market();
    await print(m, 'sell', '100', '0.25', 10_000); // at my price: counts
    await print(m, 'sell', '99.5', '0.5', 20_000); // through my price: counts
    await print(m, 'sell', '100.5', '7', 5_000); // above my bid: a sell there never reaches me
    await print(m, 'buy', '99', '3', 5_000); // a taker buy does not fill a resting buy
    await print(m, 'sell', '100', '9', 400_000); // outside a 300 s window
    await print(m, 'sell', '100', '4', 1_000, true); // a seeded maker: counted, as the queue counts seeded orders
    expect(await tradedThrough(svc, m, 'buy', parseAmount('100'), NOW - 300_000)).toBe(parseAmount('4.75'));
  });

  it('a resting sell at 100 counts taker buys at or above 100', async () => {
    const m = await market();
    await print(m, 'buy', '100', '1', 1_000);
    await print(m, 'buy', '101', '2', 1_000);
    await print(m, 'buy', '99.99', '5', 1_000);
    await print(m, 'sell', '100', '6', 1_000);
    expect(await tradedThrough(svc, m, 'sell', parseAmount('100'), NOW - 300_000)).toBe(parseAmount('3'));
  });

  it('nothing printed is zero, not null', async () => {
    const m = await market();
    expect(await tradedThrough(svc, m, 'buy', parseAmount('100'), NOW - 300_000)).toBe(0n);
  });
});
