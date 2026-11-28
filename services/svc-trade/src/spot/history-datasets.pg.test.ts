/**
 * RC-cex-spot-05 (J-cex-spot-15 #10) — historical tick, book and trade data downloads (real PostgreSQL):
 *   - 98/100 trades produces completeness 98.00% with gap 51..52 and sha256 matching downloaded gzip bytes
 *   - append-only correction keeps original file untouched and links superseding file in manifest
 *   - blank TRADE_HISTORY_BOOK_INTERVAL_MS refuses trade.history_book_interval_unset and creates no book dataset
 *   - rerunning build for the same day targets history:<market>:<kind>:<day> with identical id and sha256
 *   - unknown dataset id returns null (404 at REST door)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { TRADE_HISTORY_BOOK_INTERVAL_UNSET } from '@intafaced/contracts/trade-history';
import { SqlHistoryDatasets } from './history-datasets.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is required (runs/test-db.env). This suite does not start Docker.');
  const url = new URL(raw);
  if (url.pathname === '/test') url.pathname = '/intafaced_test';
  return url.toString();
}

const MARKET_ID = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';
const ORDER_TAKER = '44444444-4444-4444-8444-444444444444';
const ORDER_MAKER = '55555555-5555-4555-8555-555555555555';
const DAY = '2026-11-24';

describe('SqlHistoryDatasets (real PostgreSQL, RC-cex-spot-05)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
  }, 180_000);

  afterAll(async () => {
    if (db) await db.drop();
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.history_corrections, trade.history_datasets, trade.history_book_snapshots, trade.fills, trade.orders, trade.markets CASCADE`;
    await db.sql`
      INSERT INTO trade.markets (id, symbol, base_asset, quote_asset, tick_size, lot_size, min_qty, min_notional, maker_bps, taker_bps, status, kind, paper, display_name, listed_at)
      VALUES (${MARKET_ID}, 'BTC/USDT', 'BTC', 'USDT', 0.01, 0.0001, 0.0001, 1, 8, 10, 'active', 'spot', false, 'BTC/USDT', now())
    `;
    await db.sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, seeded)
      VALUES
        (${ORDER_TAKER}, ${USER_A}, ${MARKET_ID}, 'TEST-taker-1', 'buy', 'limit', 65000, 10, 'open', 'GTC', 'USDT', 0, false),
        (${ORDER_MAKER}, ${USER_B}, ${MARKET_ID}, 'TEST-maker-1', 'sell', 'limit', 65000, 10, 'open', 'GTC', 'BTC', 0, false)
    `;
  });

  it('builds a 98% trades dataset with gap 51..52, matching sha256, idempotent rerun, and append-only correction', async () => {
    for (let seq = 1; seq <= 100; seq += 1) {
      if (seq === 51 || seq === 52) continue;
      const fillId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      const ts = new Date(`2026-11-24T00:00:${String(seq % 60).padStart(2, '0')}.000Z`);
      await db.sql`
        INSERT INTO trade.fills (id, order_id, counter_order_id, market_id, user_id, side, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, liquidity, sequence, ts)
        VALUES (${fillId}, ${ORDER_TAKER}, ${ORDER_MAKER}, ${MARKET_ID}, ${USER_A}, 'buy', 65000, 0.01, 650, 'BTC', 0, 0, 'taker', ${seq}, ${ts})
      `;
    }

    const store = new SqlHistoryDatasets(db.sql, { bookIntervalMs: 5000 });
    const market = { id: MARKET_ID, symbol: 'BTC/USDT' };

    const first = await store.buildTradesDataset(market, DAY);
    expect(first).not.toBeNull();
    expect(first!.key).toBe('history:BTC/USDT:trades:2026-11-24');
    expect(first!.rowCount).toBe(98);
    expect(first!.firstSequence).toBe(1);
    expect(first!.lastSequence).toBe(100);
    expect(first!.completenessPct).toBe('98.00');
    expect(first!.gaps).toEqual([{ fromSequence: 51, toSequence: 52 }]);
    expect(first!.provenance).toBe("this venue's own matching sequence");

    // Download bytes match manifest sha256 and carry no user or order id.
    const dl = await store.downloadDataset(first!.id);
    expect(dl).not.toBeNull();
    expect(createHash('sha256').update(dl!.payloadGzip).digest('hex')).toBe(first!.sha256);
    const lines = gunzipSync(dl!.payloadGzip)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(98);
    expect(lines[0]).not.toHaveProperty('userId');
    expect(lines[0]).not.toHaveProperty('orderId');

    // Rerunning for the same day returns the same dataset row and identical sha256.
    const rerun = await store.buildTradesDataset(market, DAY);
    expect(rerun!.id).toBe(first!.id);
    expect(rerun!.sha256).toBe(first!.sha256);
    expect(rerun!.generatedAt).toBe(first!.generatedAt);

    // Append-only correction keeps original file untouched and links superseding file.
    const correctedRows = [
      ...lines,
      {
        schemaVersion: '1',
        symbol: 'BTC/USDT',
        id: '51',
        sequence: 51,
        side: 'buy',
        price: '65000',
        qty: '0.01',
        quoteAmount: '650',
        ts: '2026-11-24T00:00:51.000Z',
      },
      {
        schemaVersion: '1',
        symbol: 'BTC/USDT',
        id: '52',
        sequence: 52,
        side: 'buy',
        price: '65000',
        qty: '0.01',
        quoteAmount: '650',
        ts: '2026-11-24T00:00:52.000Z',
      },
    ];
    const { original, superseding } = await store.recordCorrection({
      datasetId: first!.id,
      sequenceFrom: 51,
      sequenceTo: 52,
      reason: 'TEST backfill sequences 51..52',
      correctionTag: 'seq51-52',
      rows: correctedRows,
      sequences: correctedRows.map((r) => Number(r.sequence)),
      contiguous: true,
    });
    expect(original.id).toBe(first!.id);
    expect(original.sha256).toBe(first!.sha256);
    expect(original.supersededBy).toBe(superseding.id);
    expect(original.corrections).toHaveLength(1);
    expect(original.corrections[0]).toMatchObject({
      sequenceFrom: 51,
      sequenceTo: 52,
      reason: 'TEST backfill sequences 51..52',
      supersedingDatasetId: superseding.id,
      supersedingSha256: superseding.sha256,
    });
    expect(superseding.completenessPct).toBe('100.00');
    expect(superseding.gaps).toEqual([]);

    // Original file bytes are still downloadable and unchanged.
    const originalAgain = await store.downloadDataset(first!.id);
    expect(originalAgain!.sha256).toBe(first!.sha256);

    // Unknown dataset id returns null.
    expect(await store.downloadDataset('99999999-9999-4999-8999-999999999999')).toBeNull();
    expect(await store.downloadDataset('not-a-uuid')).toBeNull();
  });

  it('keeps the file first published for a window still open, so a manifest read then a download agree; rebuilds it once closed', async () => {
    const store = new SqlHistoryDatasets(db.sql, { bookIntervalMs: 5000 });
    const market = { id: MARKET_ID, symbol: 'BTC/USDT' };
    const today = new Date().toISOString().slice(0, 10);
    const fill = async (seq: number) => {
      const fillId = `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`;
      await db.sql`
        INSERT INTO trade.fills (id, order_id, counter_order_id, market_id, user_id, side, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, liquidity, sequence, ts)
        VALUES (${fillId}, ${ORDER_TAKER}, ${ORDER_MAKER}, ${MARKET_ID}, ${USER_A}, 'buy', 65000, 0.01, 650, 'BTC', 0, 0, 'taker', ${seq}, now())
      `;
    };

    await fill(1);
    const published = await store.buildTradesDataset(market, today);
    expect(published!.rowCount).toBe(1);

    // A print lands and the job runs again while the day is open: the published file and its checksum stay.
    await fill(2);
    const again = await store.buildTradesDataset(market, today);
    expect(again!.id).toBe(published!.id);
    expect(again!.sha256).toBe(published!.sha256);
    expect(again!.rowCount).toBe(1);
    const dl = await store.downloadDataset(published!.id);
    expect(dl!.sha256).toBe(published!.sha256);
    expect(createHash('sha256').update(dl!.payloadGzip).digest('hex')).toBe(published!.sha256);

    // Once the window has closed, the next build publishes the whole day.
    await db.sql`UPDATE trade.history_datasets SET window_end = now() - interval '1 second' WHERE id = ${published!.id}`;
    const closed = await store.buildTradesDataset(market, today);
    expect(closed!.id).toBe(published!.id);
    expect(closed!.rowCount).toBe(2);
    expect(closed!.sha256).not.toBe(published!.sha256);
    const final = await store.downloadDataset(published!.id);
    expect(createHash('sha256').update(final!.payloadGzip).digest('hex')).toBe(closed!.sha256);
  });

  it('#11240: reads 100.00% with no gaps when every trade is in the file, though the engine numbers accepts, makers and seeded fills too', async () => {
    // The engine gives every accept, fill and cancel of a market its own number (testing.ts FakeEngine): two accepts
    // then a fill, so trades land on every third number. Each trade has a maker row on the same number, and one trade
    // in four crosses a seeded order, which the file leaves out by policy.
    const SEEDED = '66666666-6666-4666-8666-666666666666';
    await db.sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, seeded)
      VALUES (${SEEDED}, ${USER_B}, ${MARKET_ID}, 'TEST-seeded-1', 'sell', 'limit', 65000, 10, 'open', 'GTC', 'BTC', 0, true)
    `;
    let published = 0;
    for (let trade = 1; trade <= 40; trade += 1) {
      const seq = 1120 + trade * 3;
      const seeded = trade % 4 === 0;
      const maker = seeded ? SEEDED : ORDER_MAKER;
      const ts = new Date(`2026-11-24T01:${String(trade % 60).padStart(2, '0')}:00.000Z`);
      const hex = String(seq).padStart(12, '0');
      await db.sql`
        INSERT INTO trade.fills (id, order_id, counter_order_id, market_id, user_id, side, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, liquidity, sequence, ts)
        VALUES
          (${`00000000-0000-4000-a000-${hex}`}, ${ORDER_TAKER}, ${maker}, ${MARKET_ID}, ${USER_A}, 'buy', 65000, 0.01, 650, 'BTC', 0, 0, 'taker', ${seq}, ${ts}),
          (${`00000000-0000-4000-b000-${hex}`}, ${maker}, ${ORDER_TAKER}, ${MARKET_ID}, ${USER_B}, 'sell', 65000, 0.01, 650, 'USDT', 0, 0, 'maker', ${seq}, ${ts})
      `;
      if (!seeded) published += 1;
    }

    const store = new SqlHistoryDatasets(db.sql, { bookIntervalMs: 5000 });
    const file = await store.buildTradesDataset({ id: MARKET_ID, symbol: 'BTC/USDT' }, DAY);
    expect(file!.rowCount).toBe(published);
    expect(file!.rowCount).toBe(30);
    expect(file!.completenessPct).toBe('100.00');
    expect(file!.gaps).toEqual([]);
  });

  it('refuses book snapshot capture and build when bookIntervalMs is blank, and succeeds when set', async () => {
    const market = { id: MARKET_ID, symbol: 'BTC/USDT' };
    const blank = new SqlHistoryDatasets(db.sql, { bookIntervalMs: null });
    await expect(
      blank.captureBookSnapshot(market, { bids: [['65000', '1']], asks: [['65010', '1']], sequence: 1 }, new Date(`${DAY}T00:00:00Z`)),
    ).rejects.toMatchObject({ code: TRADE_HISTORY_BOOK_INTERVAL_UNSET });
    await expect(blank.buildBookSnapshotsDataset(market, DAY)).rejects.toMatchObject({ code: TRADE_HISTORY_BOOK_INTERVAL_UNSET });

    const configured = new SqlHistoryDatasets(db.sql, { bookIntervalMs: 5000 });
    await configured.captureBookSnapshot(
      market,
      { bids: [['65000', '1']], asks: [['65010', '1']], sequence: 10 },
      new Date(`${DAY}T00:00:05Z`),
    );
    await configured.captureBookSnapshot(
      market,
      { bids: [['65005', '2']], asks: [['65015', '1']], sequence: 15 },
      new Date(`${DAY}T00:00:10Z`),
    );
    const book = await configured.buildBookSnapshotsDataset(market, DAY);
    expect(book).not.toBeNull();
    expect(book!.kind).toBe('book_snapshots');
    expect(book!.rowCount).toBe(2);
    expect(book!.firstSequence).toBe(10);
    expect(book!.lastSequence).toBe(15);
  });
});
