/**
 * Unit card — a settled repay retry still releases collateral
 *
 * 1. Promise: repay that has already settled (ledger tx recorded) and then
 *    crashed before releaseCollateral still returns the collateral on retry.
 *    The retry posts loanCollateralRelease once and does not post loanRepay again.
 * 2. Break: the retry returns as soon as the repayment row has ledger_tx_id,
 *    so the borrower is told the loan is closed while the collateral stays locked.
 * 3. Done bar: crash after loan.repaid and before loan.collateral.released,
 *    then the same eventId: one loan.repaid, one loan.collateral.released,
 *    collateral balance 0, status repaid. A further retry posts neither again.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts (repay)
 * 6. RED: retry reports closed with collateral still 1 BTC and no release post
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
    minPrincipal: 0n,
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

describe('LoanService.repay — settled retry still releases collateral', () => {
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

  it('releases collateral the first post left locked, and does not post the repayment again', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
    });
    const opened = await seedOpenLoan(bank, ledger);
    const eventId = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let crashed = false;
    ledger.post = async (request: PostRequest) => {
      if (!crashed && request.reason === 'loan.collateral.released') {
        crashed = true;
        throw new Error('crashed after repayment settled');
      }
      return innerPost(request);
    };

    await expect(bank.loans.repay({ loanId: opened.loan.id, amount: amt('5000'), eventId, now: NOW })).rejects.toThrow(
      /crashed after repayment settled/,
    );
    expect(countReason(ledger, 'loan.repaid')).toBe(1);
    expect(countReason(ledger, 'loan.collateral.released')).toBe(0);
    expect(await bank.loans.collateralOf(opened.loan)).toBe(amt('1'));

    ledger.post = innerPost;

    const retry = await bank.loans.repay({ loanId: opened.loan.id, amount: amt('5000'), eventId, now: NOW });
    expect(retry.closed).toBe(true);
    expect(retry.ledgerTxId.length).toBeGreaterThan(0);
    expect(countReason(ledger, 'loan.repaid')).toBe(1);
    expect(countReason(ledger, 'loan.collateral.released')).toBe(1);
    expect(await bank.loans.collateralOf(opened.loan)).toBe(amt('0'));
    expect((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount).toBe(amt('1'));
    expect((await bank.loans.loan(opened.loan.id)).status).toBe('repaid');

    const again = await bank.loans.repay({ loanId: opened.loan.id, amount: amt('5000'), eventId, now: NOW });
    expect(again.ledgerTxId).toBe(retry.ledgerTxId);
    expect(again.closed).toBe(true);
    expect(countReason(ledger, 'loan.repaid')).toBe(1);
    expect(countReason(ledger, 'loan.collateral.released')).toBe(1);
    expect(await bank.loans.collateralOf(opened.loan)).toBe(amt('0'));
  });
});
