/**
 * Unit card — a committed repayment with a lost receipt is never collected twice
 *
 * 1. Promise: once loan.repaid has committed, the debt it paid is gone, even if
 *    the acknowledgement was lost; a later repayment under a new eventId cannot
 *    take the same principal again.
 * 2. Break: repay() marks the claimed row rejected with a null tx on any post
 *    error, outstanding() counts only settled rows, so the debt still reads
 *    5000 and a new eventId collects 5000 a second time.
 * 3. Done bar: commit-then-throw on loan.repaid, then a new eventId for the full
 *    amount: exactly one loan.repaid post for the loan, borrower charged once,
 *    and no durable row says rejected for a committed post.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts (repay, outstanding)
 * 6. RED on 11ab823a8: two loan.repaid posts; first row rejected/null tx
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { LoanService } from './loan-service.js';
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
  await ledger.post(recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: randomUUID() }));
}

describe('loan repayment with a lost ledger acknowledgement', () => {
  it('does not collect the same principal again under a new eventId', async () => {
    const ledger = new MemoryLedger();
    await fund(ledger, PAYER, 'USDT', '100000');
    await fund(ledger, BORROWER, 'BTC', '1');
    const options = { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) };
    let loans = new LoanService(sql, ledger, options);
    await loans.fundReserve({ debtAssetId: 'USDT', fundingId: randomUUID(), amount: amt('100000'), from: userAvailable(PAYER, 'USDT') });
    const product = await loans.createProduct({
      name: 'TEST BTC',
      debtAssetId: 'USDT',
      collateralAssetId: 'BTC',
      quoteAssetId: 'USDT',
      aprBps: 1000,
      maxLtvBps: 5000,
      minPrincipal: 0n,
      policy: DEFAULT_LIQUIDATION_POLICY,
    });
    const { loan } = await loans.open({
      loanId: randomUUID(),
      productId: product.id,
      userId: BORROWER,
      collateralAmount: amt('1'),
      principal: amt('5000'),
      now: NOW,
    });
    // Spare funds so a second collection would be executable if the service allowed it.
    await fund(ledger, BORROWER, 'USDT', '5000');

    const post = ledger.post.bind(ledger);
    let lost = false;
    ledger.post = async (request) => {
      const receipt = await post(request);
      if (!lost && request.reason === 'loan.repaid') {
        lost = true;
        throw new Error('receipt lost after ledger commit');
      }
      return receipt;
    };
    await expect(loans.repay({ loanId: loan.id, eventId: randomUUID(), amount: amt('5000'), now: NOW })).rejects.toThrow();
    ledger.post = post;

    loans = new LoanService(sql, ledger, options);
    try {
      await loans.repay({ loanId: loan.id, eventId: randomUUID(), amount: amt('5000'), now: NOW });
    } catch {
      // Refusing while the original outcome is reconciled is acceptable; collecting again is not.
    }

    const repaid = ledger.journal().filter((tx) => tx.reason === 'loan.repaid' && tx.idempotencyKey.includes(loan.id));
    expect(repaid).toHaveLength(1);
    const contradicting = await sql`
      SELECT id FROM bank.loan_repayments WHERE loan_id = ${loan.id} AND status = 'rejected' AND ledger_tx_id IS NULL`;
    expect(contradicting).toHaveLength(0);
  });
});

describe('unattended recovery after a lost loan acknowledgement', () => {
  async function openLoan(ledger: MemoryLedger) {
    await fund(ledger, PAYER, 'USDT', '100000');
    await fund(ledger, BORROWER, 'BTC', '1');
    const options = { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) };
    const loans = new LoanService(sql, ledger, options);
    await loans.fundReserve({ debtAssetId: 'USDT', fundingId: randomUUID(), amount: amt('100000'), from: userAvailable(PAYER, 'USDT') });
    const product = await loans.createProduct({
      name: `TEST BTC ${randomUUID()}`,
      debtAssetId: 'USDT',
      collateralAssetId: 'BTC',
      quoteAssetId: 'USDT',
      aprBps: 1000,
      maxLtvBps: 5000,
      minPrincipal: 0n,
      policy: DEFAULT_LIQUIDATION_POLICY,
    });
    const { loan } = await loans.open({
      loanId: randomUUID(),
      productId: product.id,
      userId: BORROWER,
      collateralAmount: amt('1'),
      principal: amt('5000'),
      now: NOW,
    });
    return { loans, loan, options };
  }

  function loseFirst(ledger: MemoryLedger, reason: string): () => void {
    const post = ledger.post.bind(ledger);
    let lost = false;
    ledger.post = async (request) => {
      const receipt = await post(request);
      if (!lost && request.reason === reason) {
        lost = true;
        throw new Error('receipt lost after ledger commit');
      }
      return receipt;
    };
    return () => {
      ledger.post = post;
    };
  }

  it('settles the original repayment and closes the loan without the borrower', async () => {
    const ledger = new MemoryLedger();
    const { loans, loan, options } = await openLoan(ledger);
    const eventId = randomUUID();
    const restore = loseFirst(ledger, 'loan.repaid');
    await expect(loans.repay({ loanId: loan.id, eventId, amount: amt('5000'), now: NOW })).rejects.toThrow(
      'receipt lost after ledger commit',
    );
    restore();

    const pending = await sql`SELECT status, ledger_tx_id FROM bank.loan_repayments WHERE id = ${eventId}`;
    expect(pending[0]?.status).toBe('pending');
    await fund(ledger, BORROWER, 'USDT', '5000');
    await expect(loans.repay({ loanId: loan.id, eventId: randomUUID(), amount: amt('5000'), now: NOW })).rejects.toMatchObject({
      code: 'bank.ledger_outcome_unknown',
    });

    // The database is shared with the other cases (each has its own in-memory ledger): judge only this loan.
    const out = await new LoanService(sql, ledger, options).recoverRepayments(10);
    expect(out.find((o) => o.loanId === loan.id)).toEqual({ loanId: loan.id, outcome: 'completed' });

    const repaid = ledger.journal().filter((tx) => tx.reason === 'loan.repaid' && tx.idempotencyKey.includes(loan.id));
    expect(repaid).toHaveLength(1);
    const row = await sql`SELECT status, ledger_tx_id FROM bank.loan_repayments WHERE id = ${eventId}`;
    expect(row[0]?.status).toBe('settled');
    expect(row[0]?.ledger_tx_id).toBe(repaid[0]?.id);
    const after = await loans.loan(loan.id);
    expect(after.status).toBe('repaid');
    expect(await loans.collateralOf(after)).toBe(0n);
    const releases = ledger.journal().filter((tx) => tx.reason === 'loan.collateral.released' && tx.idempotencyKey.includes(loan.id));
    expect(releases).toHaveLength(1);
  });

  it('finishes a committed release whose acknowledgement was lost, releasing once', async () => {
    const ledger = new MemoryLedger();
    const { loans, loan, options } = await openLoan(ledger);
    const releaseReason = recipes.loanCollateralRelease({
      loanId: loan.id,
      userId: BORROWER,
      collateralAssetId: 'BTC',
      amount: amt('1'),
      sequence: 1,
    }).reason;
    const restore = loseFirst(ledger, releaseReason);
    await expect(loans.repay({ loanId: loan.id, eventId: randomUUID(), amount: amt('5000'), now: NOW })).rejects.toThrow(
      'receipt lost after ledger commit',
    );
    restore();
    expect((await loans.loan(loan.id)).status).not.toBe('repaid');

    // The database is shared with the other cases (each has its own in-memory ledger): judge only this loan.
    const out = await new LoanService(sql, ledger, options).recoverRepayments(10);
    expect(out.find((o) => o.loanId === loan.id)).toEqual({ loanId: loan.id, outcome: 'completed' });

    const after = await loans.loan(loan.id);
    expect(after.status).toBe('repaid');
    const releases = ledger.journal().filter((tx) => tx.reason === releaseReason && tx.idempotencyKey.includes(loan.id));
    expect(releases).toHaveLength(1);
    const rows = await sql`
      SELECT status, ledger_tx_id FROM bank.loan_collateral_events WHERE loan_id = ${loan.id} AND direction = 'release'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('settled');
    expect(rows[0]?.ledger_tx_id).toBe(releases[0]?.id);
  });

  it('still records a definite ledger refusal as rejected and lets a new repayment through', async () => {
    const ledger = new MemoryLedger();
    const { loans, loan } = await openLoan(ledger);
    // Spend the borrower's drawn USDT so the first repayment is definitely refused.
    const drained = await ledger.balance(userAvailable(BORROWER, 'USDT'));
    await ledger.post(
      recipes.withdrawHold({ userId: BORROWER, assetId: 'USDT', amount: drained.amount, rail: 'test', withdrawalId: randomUUID() }),
    );
    const refusedId = randomUUID();
    await expect(loans.repay({ loanId: loan.id, eventId: refusedId, amount: amt('5000'), now: NOW })).rejects.toMatchObject({
      code: 'ledger.insufficient_funds',
    });
    const refused = await sql`SELECT status, rejection_code FROM bank.loan_repayments WHERE id = ${refusedId}`;
    expect(refused[0]?.status).toBe('rejected');
    expect(refused[0]?.rejection_code).toBe('ledger.insufficient_funds');

    await fund(ledger, BORROWER, 'USDT', '5000');
    const ok = await loans.repay({ loanId: loan.id, eventId: randomUUID(), amount: amt('5000'), now: NOW });
    expect(ok.closed).toBe(true);
  });
});
