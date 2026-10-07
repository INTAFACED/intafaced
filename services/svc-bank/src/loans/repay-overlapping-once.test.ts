/**
 * Unit card — overlapping repayments pay the outstanding once
 *
 * 1. Promise: two repay calls in flight, different event ids, each offering the
 *    full debt, move that debt once. The loan row is locked and the debt is
 *    read again before the split is posted.
 * 2. Break: each caller splits principal and interest from its own outstanding()
 *    read, then posts that split. Neither waits for the other, so both pay the
 *    full balance.
 * 3. Done bar: one loan.repaid for the outstanding, the other call refuses
 *    bank.loan_closed, collateral releases once, and a retry of the posted
 *    event id does not post the repayment again. The borrower is funded for
 *    both, so a second post is not an insufficient-balance accident.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts (repay)
 * 6. RED: both callers fulfill and the journal has two loan.repaid
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable, type PostRequest } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';

const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-06-01T12:00:00.000Z');

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
    recipes.deposit({
      userId,
      assetId,
      amount: amt(value),
      rail: 'test',
      railRef: `${userId}:${assetId}:${randomUUID()}`,
    }),
  );
}

async function seedOpenLoan(bank: ReturnType<typeof createBankServices>, ledger: MemoryLedger) {
  await fund(ledger, PAYER, 'USDT', '100000');
  await bank.loans.fundReserve({
    debtAssetId: 'USDT',
    fundingId: `f:${randomUUID()}`,
    amount: amt('100000'),
    from: userAvailable(PAYER, 'USDT'),
  });
  await fund(ledger, BORROWER, 'BTC', '1');
  const product = await bank.loans.createProduct({
    name: 'BTC-backed USDT',
    debtAssetId: 'USDT',
    collateralAssetId: 'BTC',
    quoteAssetId: 'USDT',
    aprBps: 1_000,
    maxLtvBps: 5_000,
    policy: DEFAULT_LIQUIDATION_POLICY,
  });
  return bank.loans.open({
    productId: product.id,
    userId: BORROWER,
    collateralAmount: amt('1'),
    principal: amt('5000'),
    now: NOW,
  });
}

function countReason(ledger: MemoryLedger, reason: string): number {
  return ledger.journal().filter((tx) => tx.reason === reason).length;
}

describe('LoanService.repay — overlapping event ids pay the outstanding once', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
               bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
               bank.loan_reserve_fundings
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('two overlapping repayments with different event ids do not each pay the full outstanding', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    // The draw already put 5000 USDT in hand. Another 5000 means both callers
    // can fund a full repayment; a second post is not stopped by the balance.
    await fund(ledger, BORROWER, 'USDT', '5000');
    const eventA = randomUUID();
    const eventB = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let parked = false;
    let releasePark!: () => void;
    const park = new Promise<void>((resolve) => {
      releasePark = resolve;
    });
    ledger.post = async (request: PostRequest) => {
      if (!parked && request.reason === 'loan.repaid') {
        parked = true;
        await park;
      }
      return innerPost(request);
    };

    const noteSettled = () => {
      releasePark();
    };
    const results = await Promise.allSettled([
      bank.loans.repay({ loanId: opened.loan.id, amount: amt('5000'), eventId: eventA, now: NOW }).finally(noteSettled),
      bank.loans.repay({ loanId: opened.loan.id, amount: amt('5000'), eventId: eventB, now: NOW }).finally(noteSettled),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'bank.loan_closed' });

    const paid = fulfilled[0] as PromiseFulfilledResult<{
      ledgerTxId: string;
      principalPaid: bigint;
      interestPaid: bigint;
      closed: boolean;
    }>;
    expect(paid.value.principalPaid).toBe(amt('5000'));
    expect(paid.value.interestPaid).toBe(0n);
    expect(paid.value.closed).toBe(true);
    expect(countReason(ledger, 'loan.repaid')).toBe(1);
    expect(countReason(ledger, 'loan.collateral.released')).toBe(1);
    expect((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount).toBe(amt('5000'));
    expect(await bank.loans.collateralOf(opened.loan)).toBe(0n);
    expect((await bank.loans.loan(opened.loan.id)).status).toBe('repaid');
    expect((await bank.loans.outstanding(opened.loan.id)).total).toBe(0n);

    const winnerId = paid.value.ledgerTxId;
    const winnerEvent = results[0]?.status === 'fulfilled' ? eventA : eventB;
    const again = await bank.loans.repay({ loanId: opened.loan.id, amount: amt('5000'), eventId: winnerEvent, now: NOW });
    expect(again.ledgerTxId).toBe(winnerId);
    expect(countReason(ledger, 'loan.repaid')).toBe(1);
    expect(countReason(ledger, 'loan.collateral.released')).toBe(1);
  }, 20_000);
});
