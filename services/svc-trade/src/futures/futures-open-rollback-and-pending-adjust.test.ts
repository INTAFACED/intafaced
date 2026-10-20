/**
 * Two ledger/row gaps in the futures position service, against real migrations and a MemoryLedger.
 *
 * 1. A failed open posts the margin release, but the lock is keyed on the position id alone. A retry of the
 *    same open re-posts the lock, which the ledger dedupes as already done, and the row is then written with
 *    no margin held.
 * 2. A margin adjustment that posted to the ledger and crashed before the row update leaves the row at the
 *    old margin. A close in that state released the wrong amount.
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

describe('futures open rollback and pending margin adjustment (Postgres)', () => {
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

  it('a retry of an open whose row insert failed and was rolled back never opens an unfunded position', async () => {
    feed('50000');
    const first = await open('first-long');
    expect(await available()).toBe('95000');

    // Same user, market, side and mode: the open-unique index refuses the row, the margin is released.
    await expect(open('second-long')).rejects.toBeTruthy();
    expect(await available()).toBe('95000');

    // The first position goes away, so the same open would now fit.
    await service.close(ALICE, first.id!);
    expect(await available()).toBe('100000');

    // Retry of the SAME open: it must either fund its margin or refuse. It must not open with nothing held.
    const retried = await open('second-long').catch((e: unknown) => e);
    if (retried instanceof Error) {
      expect(await available()).toBe('100000');
      expect((retried as { code?: string }).code).toBe('trade.open_rolled_back');
    } else {
      expect(await available()).toBe('95000');
    }
    const rows = await sql<{ id: string }[]>`SELECT id FROM trade.positions WHERE status = 'open'`;
    for (const r of rows) expect(await pot(r.id)).not.toBe('0');
  });

  it('a close refuses while a margin adjustment has posted but not finalized, and succeeds once it is resumed', async () => {
    feed('50000');
    const pos = await open('adjust-then-close');
    crashAfterPost = true;
    await expect(service.setLeverage({ userId: ALICE, symbol: SYMBOL, positionId: pos.id!, leverage: amt('5') })).rejects.toThrow(
      'simulated crash after ledger post',
    );
    // Ledger holds 10000 (leverage 5); the row still says 5000 / leverage 10.
    expect(await pot(pos.id!)).toBe('10000');

    await expect(service.close(ALICE, pos.id!)).rejects.toMatchObject({ code: 'trade.margin_adjustment_in_progress', status: 409 });
    await expect(service.closeQuantity(ALICE, pos.id!, { quantity: amt('0.5'), clientCloseId: 'half' })).rejects.toMatchObject({
      code: 'trade.margin_adjustment_in_progress',
    });
    expect(await pot(pos.id!)).toBe('10000');

    const resumed = await service.setLeverage({ userId: ALICE, symbol: SYMBOL, positionId: pos.id!, leverage: amt('5') });
    expect(resumed.collateral).toBe('10000');
    const closed = await service.close(ALICE, pos.id!);
    expect(closed.status).toBe('closed');
    expect(await pot(pos.id!)).toBe('0');
    expect(await available()).toBe('100000');
  });
});
