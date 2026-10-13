/**
 * Unit card — recovery after a lost ledger receipt never moves money it should not
 *
 * 1. Promise: recovering pending loan rows re-sends only what the borrower's
 *    debt state still allows, re-reads each row under its lock, and never lets a
 *    repayment close a loan over a liquidation sale whose outcome is unknown.
 * 2. Break (independent review of the first draft): recovery re-sent a pending
 *    excess-collateral release on a loan that still owed, with no LTV re-check;
 *    re-sent a row that had turned `rejected` while it waited; and a liquidation
 *    with a lost receipt put the loan back in `margin_call`, so a full repayment
 *    was accepted on top of the sale (borrower paid twice).
 * 3. Done bar: the release stays pending and the collateral stays; the rejected
 *    row is not re-sent; repay is refused while the rung is pending and the next
 *    sweep finishes that sale once.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, formatAmount, marketMaker, recipes, userAvailable } from '@intafaced/ledger-client';
import { LoanService, marketMakerVenue } from './loan-service.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';

const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const MM = '88888888-8888-4888-8888-888888888888';
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

let markNow = NOW;
const price = (btc: string) => fixedPriceSource({ BTC: { price: btc, quality: 'mid' } }, () => markNow);

async function fund(ledger: MemoryLedger, userId: string, assetId: string, value: string) {
  await ledger.post(recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: randomUUID() }));
}

/** Fail the first post with this reason, either before it reaches the ledger or after it commits. */
function lose(ledger: MemoryLedger, reason: string, mode: 'after-commit' | 'before-commit'): () => void {
  const post = ledger.post.bind(ledger);
  let done = false;
  ledger.post = async (request) => {
    if (!done && request.reason === reason) {
      done = true;
      if (mode === 'before-commit') throw new Error('socket hang up before the ledger');
      await post(request);
      throw new Error('receipt lost after ledger commit');
    }
    return post(request);
  };
  return () => {
    ledger.post = post;
  };
}

const posts = (ledger: MemoryLedger, reason: string, loanId: string) =>
  ledger.journal().filter((tx) => tx.reason === reason && tx.idempotencyKey.includes(loanId));

async function openLoan(ledger: MemoryLedger, collateral: string, principal: string) {
  markNow = NOW;
  await fund(ledger, PAYER, 'USDT', '100000');
  await fund(ledger, BORROWER, 'BTC', collateral);
  // A market maker able to buy seized collateral.
  await fund(ledger, MM, 'USDT', '100000');
  await ledger.post({
    idempotencyKey: `seed-mm-${randomUUID()}`,
    module: 'test',
    reason: 'seed',
    entries: [
      { account: userAvailable(MM, 'USDT'), direction: 'credit', amount: amt('100000') },
      { account: marketMaker('USDT'), direction: 'debit', amount: amt('100000') },
    ],
  });
  const loans = new LoanService(sql, ledger, { priceSource: price('10000'), venue: marketMakerVenue() });
  await loans.fundReserve({ debtAssetId: 'USDT', fundingId: randomUUID(), amount: amt('100000'), from: userAvailable(PAYER, 'USDT') });
  const product = await loans.createProduct({
    name: `TEST ${randomUUID()}`,
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
    collateralAmount: amt(collateral),
    principal: amt(principal),
    now: NOW,
  });
  return { loans, loan };
}

describe('recovery after a lost loan receipt', () => {
  it('does not release excess collateral from a loan that still owes', async () => {
    const ledger = new MemoryLedger();
    const { loans, loan } = await openLoan(ledger, '2', '5000');
    const eventId = randomUUID();
    const restore = lose(ledger, 'loan.collateral.released', 'before-commit');
    await expect(loans.releaseExcess({ loanId: loan.id, eventId, amount: amt('1'), now: NOW })).rejects.toThrow();
    restore();

    // The market falls: with 2 BTC the loan is healthy, with 1 BTC it would be past the margin-call line.
    const crashed = new LoanService(sql, ledger, { priceSource: price('6000'), venue: marketMakerVenue() });
    const out = await crashed.recoverRepayments(100);

    expect(out.find((o) => o.loanId === loan.id)).toEqual({ loanId: loan.id, outcome: 'open' });
    expect(formatAmount(await crashed.collateralOf(loan))).toBe('2');
    expect(posts(ledger, 'loan.collateral.released', loan.id)).toHaveLength(0);
    const row = await sql`SELECT status FROM bank.loan_collateral_events WHERE id = ${eventId}`;
    expect(row[0]?.status).toBe('pending');
  });

  it('does not re-send a repayment that stopped being pending while recovery waited', async () => {
    const ledger = new MemoryLedger();
    const { loans, loan } = await openLoan(ledger, '1', '5000');
    const eventId = randomUUID();
    const restore = lose(ledger, 'loan.repaid', 'before-commit');
    await expect(loans.repay({ loanId: loan.id, eventId, amount: amt('1000'), now: NOW })).rejects.toThrow();
    restore();

    const other = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      await other`SELECT pg_advisory_lock(hashtext('bank.loan.repay'), hashtext(${loan.id}))`;
      const running = loans.recoverRepayments(100);
      for (let i = 0; i < 100; i++) {
        const waiting = await other<
          Array<{ n: number }>
        >`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        if ((waiting[0]?.n ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // What a concurrent same-id retry that met a definite refusal leaves behind.
      await other`UPDATE bank.loan_repayments SET status = 'rejected', rejection_code = 'ledger.insufficient_funds' WHERE id = ${eventId}`;
      await other`SELECT pg_advisory_unlock(hashtext('bank.loan.repay'), hashtext(${loan.id}))`;
      await running;
    } finally {
      await other.end();
    }

    const row = await sql`SELECT status FROM bank.loan_repayments WHERE id = ${eventId}`;
    expect(row[0]?.status).toBe('rejected');
    expect(posts(ledger, 'loan.repaid', loan.id)).toHaveLength(0);
  });

  it('refuses repayment while a liquidation sale has an unknown outcome, then finishes that sale once', async () => {
    const ledger = new MemoryLedger();
    const { loan } = await openLoan(ledger, '1', '5000');
    const loans = new LoanService(sql, ledger, { priceSource: price('5700'), venue: marketMakerVenue() });
    await loans.runRiskSweep({ now: NOW, limit: 500 });
    expect((await loans.loan(loan.id)).status).toBe('margin_call');

    const later = new Date(NOW.getTime() + 2 * 3600_000);
    markNow = later;
    const restore = lose(ledger, 'loan.liquidated', 'after-commit');
    await loans.runRiskSweep({ now: later, limit: 500 });
    restore();

    expect((await loans.loan(loan.id)).status).toBe('liquidating');
    const owed = await loans.outstanding(loan.id);
    await fund(ledger, BORROWER, 'USDT', '6000');
    await expect(loans.repay({ loanId: loan.id, eventId: randomUUID(), amount: owed.total, now: later })).rejects.toMatchObject({
      code: expect.stringMatching(/^bank\.(ledger_outcome_unknown|loan_liquidating)$/),
    });

    await loans.runRiskSweep({ now: later, limit: 500 });
    const rungs = await sql`SELECT status FROM bank.loan_liquidations WHERE loan_id = ${loan.id} ORDER BY tranche`;
    expect(rungs[0]?.status).toBe('settled');
    expect(posts(ledger, 'loan.liquidated', loan.id)).toHaveLength(1);
    expect(posts(ledger, 'loan.repaid', loan.id)).toHaveLength(0);
  });
});
