/**
 * BK-pots-03 (J-bank-07 #5): the interest view of instant-access savings. A position earning for three days shows three
 * rows, newest first, each the day's rate and this person's payout, and they sum to what the ledger credited them from
 * the pool. Another person's payouts and a day planned but not posted stay out.
 *
 * Postgres (TEST_DATABASE_URL) and a MemoryLedger.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';

const USER = '51111111-1111-4111-8111-111111111111';
const OTHER = '52222222-2222-4222-8222-222222222222';
const PAYER = '59999999-9999-4999-8999-999999999999';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

let ledger: MemoryLedger;

beforeEach(async () => {
  await sql`TRUNCATE bank.interest_accruals, bank.earn_positions, bank.earn_pools RESTART IDENTITY CASCADE`;
  ledger = new MemoryLedger();
});

function services() {
  return createBankServices(sql, ledger, memoryLedgerHistory(ledger));
}

async function fund(userId: string, amount: string) {
  await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: randomUUID() }));
}

const main = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);

/** A TEST instant-access pool at 36.5% (0.1% a day on a 365-day year, exact), its reserve funded from bank fees. */
async function instantAccess(bank: ReturnType<typeof services>) {
  const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Instant access TEST', aprBps: 3650 });
  await fund(PAYER, '10000');
  await ledger.post(
    recipes.feeCharge({
      chargeId: `bank:${randomUUID()}`,
      userId: PAYER,
      module: 'bank',
      mode: 'asset',
      assetId: 'USDT',
      amount: amt('10000'),
    }),
  );
  await bank.earn.fundPool({ poolId: pool.id, fundingId: 'seed-1', amount: amt('10000') });
  return pool;
}

const OPENED = new Date('2026-03-01T09:00:00Z');
const day = (n: number) => new Date(Date.UTC(2026, 2, 1 + n, 12));

describe('earn.interestHistory', () => {
  it('lists each paid day with its rate and this person’s payout, and the days sum to what the ledger paid them', async () => {
    const bank = services();
    const pool = await instantAccess(bank);
    await fund(USER, '1000');
    await fund(OTHER, '500');
    await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER, amount: amt('1000'), now: OPENED });
    await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: OTHER, amount: amt('500'), now: OPENED });
    expect(await main(USER)).toBe('0');

    for (const n of [1, 2, 3]) await bank.earn.accrue({ poolId: pool.id, at: day(n) });
    // A second run of a day pays nothing more and adds no row.
    await bank.earn.accrue({ poolId: pool.id, at: day(3) });

    const history = await bank.earn.interestHistory(USER, pool.id, 50);
    expect(history.days.map((d) => d.date)).toEqual(['2026-03-04', '2026-03-03', '2026-03-02']);
    expect(history.days.map((d) => [d.rateBps, formatAmount(d.amount), typeof d.ledgerTxId])).toEqual(Array(3).fill([3650, '1', 'string']));
    expect(formatAmount(history.total)).toBe('3');
    expect(await main(USER)).toBe(formatAmount(history.total));

    const theirs = await bank.earn.interestHistory(OTHER, pool.id, 50);
    expect(theirs.days.map((d) => formatAmount(d.amount))).toEqual(['0.5', '0.5', '0.5']);
    expect(formatAmount(theirs.total)).toBe('1.5');

    // A page is a page; the total is every paid day.
    const one = await bank.earn.interestHistory(USER, pool.id, 1);
    expect(one.days.map((d) => d.date)).toEqual(['2026-03-04']);
    expect(formatAmount(one.total)).toBe('3');
  });

  it('a day planned but not yet posted is not shown as paid', async () => {
    const bank = services();
    const pool = await instantAccess(bank);
    await fund(USER, '1000');
    await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER, amount: amt('1000'), now: OPENED });
    await bank.earn.accrue({ poolId: pool.id, at: day(1) });
    // The run that planned 3 March died before the ledger post.
    await sql`
      INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients, planned_payouts)
      VALUES (${pool.id}, '2026-03-03', 3650, 0, 0, ${sql.json([{ userId: USER, amount: '1' }] as never)})
    `;
    const history = await bank.earn.interestHistory(USER, pool.id, 50);
    expect(history.days.map((d) => d.date)).toEqual(['2026-03-02']);
    expect(formatAmount(history.total)).toBe('1');
    expect(await main(USER)).toBe('1');
  });

  it('refuses a blank page size and an unknown pool, and someone with no position sees no days', async () => {
    const bank = services();
    const pool = await instantAccess(bank);
    await expect(bank.earn.interestHistory(USER, pool.id)).rejects.toMatchObject({ code: 'bank.earn_interest_list_limit_unset' });
    await expect(bank.earn.interestHistory(USER, randomUUID(), 50)).rejects.toMatchObject({ code: 'bank.pool_not_found' });
    expect(await bank.earn.interestHistory(USER, pool.id, 50)).toEqual({ days: [], total: 0n });
  });
});
