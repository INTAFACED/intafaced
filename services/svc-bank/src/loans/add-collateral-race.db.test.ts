/**
 * Two collateral top-ups that race on one loan. The same eventId sent twice at once must give one row and
 * one ledger lock, and both callers the same answer, never 23505 on loan_collateral_events_seq_idx. Two different
 * top-ups at once must each take their own sequence, and both must lock.
 * Harness from loan-interest-corrections.db.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';

const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const ROUNDS = 25;
const WIDTH = 6;

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

async function fund(ledger: MemoryLedger, userId: string, assetId: string, value: string) {
  await ledger.post(
    recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${randomUUID()}` }),
  );
}

describe('collateral top-ups that race on one loan', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.loan_adjustments, bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
               bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
               bank.loan_reserve_fundings
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  async function seed() {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        originationFeeBps: '0',
        priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW),
        payoffFee: '0',
        payoffWindowMinutes: '15',
        statementSecret: 'bank-add-collateral-race-secret',
      },
    });
    await fund(ledger, PAYER, 'USDT', '100000');
    await bank.loans.fundReserve({
      debtAssetId: 'USDT',
      fundingId: `f:${randomUUID()}`,
      amount: amt('100000'),
      from: userAvailable(PAYER, 'USDT'),
    });
    await fund(ledger, BORROWER, 'BTC', '1000');
    const product = await bank.loans.createProduct({
      name: 'BTC-backed USDT',
      debtAssetId: 'USDT',
      collateralAssetId: 'BTC',
      quoteAssetId: 'USDT',
      aprBps: 500,
      maxLtvBps: 5_000,
      minPrincipal: amt('1'),
      policy: DEFAULT_LIQUIDATION_POLICY,
    });
    const opened = await bank.loans.open({
      productId: product.id,
      userId: BORROWER,
      collateralAmount: amt('1'),
      principal: amt('100'),
      now: NOW,
    });
    return { bank, loan: opened.loan };
  }

  it('the same eventId sent at once: no 23505, one row, one ledger lock, the same answer to every caller', async () => {
    const { bank, loan } = await seed();
    const before = await bank.loans.collateralOf(loan);
    for (let round = 0; round < ROUNDS; round++) {
      const eventId = randomUUID();
      const settled = await Promise.allSettled(
        Array.from({ length: WIDTH }, () => bank.loans.addCollateral({ loanId: loan.id, eventId, amount: amt('0.01'), now: NOW })),
      );
      const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => String(s.reason));
      expect(failed).toEqual([]);
      const answers = new Set(settled.map((s) => JSON.stringify((s as PromiseFulfilledResult<unknown>).value)));
      expect(answers.size).toBe(1);
      const rows = await sql`SELECT 1 FROM bank.loan_collateral_events WHERE id = ${eventId}`;
      expect(rows).toHaveLength(1);
    }
    // Money invariant: the ledger locked exactly ROUNDS × 0.01 more, once per event.
    expect(await bank.loans.collateralOf(loan)).toBe(before + amt('0.01') * BigInt(ROUNDS));
    const locks =
      await sql`SELECT count(*)::int AS n FROM bank.loan_collateral_events WHERE loan_id = ${loan.id} AND direction = 'lock' AND status = 'settled'`;
    expect(locks[0]!.n).toBeGreaterThanOrEqual(ROUNDS);
  }, 60_000);

  it('different top-ups at once: each takes its own sequence and every one locks', async () => {
    const { bank, loan } = await seed();
    const before = await bank.loans.collateralOf(loan);
    for (let round = 0; round < ROUNDS; round++) {
      const settled = await Promise.allSettled(
        Array.from({ length: WIDTH }, () =>
          bank.loans.addCollateral({ loanId: loan.id, eventId: randomUUID(), amount: amt('0.01'), now: NOW }),
        ),
      );
      const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => String(s.reason));
      expect(failed).toEqual([]);
      const seqs = settled.map((s) => (s as PromiseFulfilledResult<{ sequence: number }>).value.sequence);
      expect(new Set(seqs).size).toBe(WIDTH);
    }
    expect(await bank.loans.collateralOf(loan)).toBe(before + amt('0.01') * BigInt(ROUNDS * WIDTH));
    const pending =
      await sql`SELECT count(*)::int AS n FROM bank.loan_collateral_events WHERE loan_id = ${loan.id} AND status <> 'settled'`;
    expect(pending[0]!.n).toBe(0);
  }, 60_000);
});
