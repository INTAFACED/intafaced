/**
 * The margin adjustment sequence is the ledger post key and is unique per position (migration 0075).
 * A leverage request equal to the current leverage posts nothing, but it still takes a sequence; the next
 * real adjustment must not reuse it. Also: 0075 refuses, deleting nothing, over pre-existing duplicates.
 *
 * H8a PG-hard: never skip-green when Postgres is down.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import { PositionService } from '../controls/test-admission.js';
import { memoryMarkBook } from './mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SYMBOL = 'BTC/USDT-PERP';
const NOW = new Date('2026-08-08T12:00:00.000Z');
const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));

describe('margin adjustment sequence (Postgres)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let marks: ReturnType<typeof memoryMarkBook>;
  let crashAfterPost = false;
  let service: PositionService;

  const feed = (price: string) => marks.set({ marketId: MARKET, price, quality: 'mid', asOfMs: NOW.getTime() });
  const available = async () => formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
  const pot = async (id: string) => formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', id))).amount);
  const open = (clientOpenId: string, side: 'long' | 'short' = 'long') =>
    service.open({ clientOpenId, userId: ALICE, symbol: SYMBOL, side, size: amt('1'), leverage: amt('10') });

  beforeAll(async () => {
    let url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) {
      const c = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = c.getConnectionUri();
      stop = async () => {
        await c.stop();
      };
    }
    db = await createTestDatabase({ service: 'trade', url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    marks = memoryMarkBook();
    crashAfterPost = false;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, ${SYMBOL}, 'BTC', 'USDT', 'futures',
        '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now()
      )
    `;
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${randomUUID()}` }),
    );
    service = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: null,
      now: () => NOW,
      afterMarginLedgerPost: async () => {
        if (crashAfterPost) {
          crashAfterPost = false;
          throw new Error('simulated crash after ledger post');
        }
      },
    });
  });

  it('a no-op leverage request followed by a real adjustment succeeds and posts under a fresh sequence', async () => {
    feed('50000');
    const pos = await open('noop-then-real');
    const noop = await service.setLeverage({ userId: ALICE, symbol: SYMBOL, positionId: pos.id!, leverage: amt('10') });
    expect(noop.leverage).toBe('10');
    expect(await pot(pos.id!)).toBe('5000');

    const real = await service.setLeverage({ userId: ALICE, symbol: SYMBOL, positionId: pos.id!, leverage: amt('5') });
    expect(real.leverage).toBe('5');
    expect(await pot(pos.id!)).toBe('10000');
    const seqs = await sql<{ sequence: number }[]>`
      SELECT sequence FROM trade.position_margin_adjustments WHERE position_id = ${pos.id!} ORDER BY sequence`;
    expect(seqs.map((r) => r.sequence)).toEqual([2, 3]);
  });
});

describe('migration 0075 over existing duplicates (Postgres)', () => {
  it('refuses with a clear error and deletes nothing', async () => {
    let url = process.env.TEST_DATABASE_URL?.trim();
    let stopC: () => Promise<void> = async () => undefined;
    if (!url) {
      const c = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = c.getConnectionUri();
      stopC = async () => {
        await c.stop();
      };
    }
    const names = readdirSync(drizzle)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();
    const idx = names.findIndex((f) => f.startsWith('0075_'));
    const before = names.slice(0, idx).map((f) => readFileSync(join(drizzle, f), 'utf8'));
    const db2 = await createTestDatabase({ service: 'trade', url, migrations: before });
    try {
      const s = db2.sql;
      await s`INSERT INTO trade.markets (id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at)
        VALUES (${MARKET}, ${SYMBOL}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now())`;
      const [p] = await s<{ id: string }[]>`
        INSERT INTO trade.positions (user_id, market_id, side, status, margin_mode, size, entry_price, leverage,
          margin_initial, margin_current, margin_asset, funding_paid)
        VALUES (${ALICE}, ${MARKET}, 'long', 'open', 'isolated', '1', '50000', '10', '5000', '5000', 'USDT', '0') RETURNING id`;
      for (const id of ['a1', 'a2'])
        await s`INSERT INTO trade.position_margin_adjustments (position_id, client_adjustment_id, request_fingerprint, sequence, status, result, completed_at)
          VALUES (${p!.id}, ${id}, ${id}, 2, 'completed', '{}'::jsonb, now())`;
      await expect(s.unsafe(readFileSync(join(drizzle, names[idx]!), 'utf8'))).rejects.toThrow(/sharing one \(position_id, sequence\)/);
      expect(await s`SELECT 1 FROM trade.position_margin_adjustments`).toHaveLength(2);
    } finally {
      await db2.drop();
      await stopC();
    }
  }, 120_000);
});

describe('migration 0075 over a lagging counter (Postgres)', () => {
  it('moves the counter up, so the next real adjustment succeeds', async () => {
    let url = process.env.TEST_DATABASE_URL?.trim();
    let stopC: () => Promise<void> = async () => undefined;
    if (!url) {
      const c = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = c.getConnectionUri();
      stopC = async () => {
        await c.stop();
      };
    }
    const names = readdirSync(drizzle)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();
    const idx = names.findIndex((f) => f.startsWith('0075_'));
    const before = names.slice(0, idx).map((f) => readFileSync(join(drizzle, f), 'utf8'));
    const db3 = await createTestDatabase({ service: 'trade', url, migrations: before });
    try {
      const s = db3.sql;
      await s`INSERT INTO trade.markets (id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at)
        VALUES (${MARKET}, ${SYMBOL}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now())`;
      const [p] = await s<{ id: string }[]>`
        INSERT INTO trade.positions (user_id, market_id, side, status, margin_mode, size, entry_price, leverage,
          margin_initial, margin_current, margin_asset, funding_paid)
        VALUES (${ALICE}, ${MARKET}, 'long', 'open', 'isolated', '1', '50000', '10', '5000', '5000', 'USDT', '0') RETURNING id`;
      // A no-op leverage request completed at sequence 2 under the old code; the counter stayed at 1.
      await s`INSERT INTO trade.position_margin_adjustments (position_id, client_adjustment_id, request_fingerprint, sequence, status, result, completed_at)
        VALUES (${p!.id}, 'noop', 'leverage:10', 2, 'completed', '{}'::jsonb, now())`;
      await s.unsafe(readFileSync(join(drizzle, names[idx]!), 'utf8'));
      const [pos] = await s<{ margin_adjust_seq: number }[]>`SELECT margin_adjust_seq FROM trade.positions WHERE id = ${p!.id}`;
      expect(pos!.margin_adjust_seq).toBe(2);

      const ledger = new MemoryLedger();
      await ledger.post(
        recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${randomUUID()}` }),
      );
      const svc = new PositionService(s, ledger, {
        marks: memoryMarkBook().source(),
        profitSource: profitSourceFromConfig(PROFIT_SOURCE),
        maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
        bus: null,
        now: () => NOW,
      });
      const real = await svc.setLeverage({ userId: ALICE, symbol: SYMBOL, positionId: p!.id, leverage: amt('5') });
      expect(real.leverage).toBe('5');
      const seqs = await s<{ sequence: number }[]>`
        SELECT sequence FROM trade.position_margin_adjustments WHERE position_id = ${p!.id} ORDER BY sequence`;
      expect(seqs.map((r) => r.sequence)).toEqual([2, 3]);
    } finally {
      await db3.drop();
      await stopC();
    }
  }, 120_000);
});
