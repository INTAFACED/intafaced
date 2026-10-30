/**
 * Unit card — one lock covers repayment and liquidation (BNK-0038, BNK-0043)
 *
 * 1. Promise: a repayment and a liquidation of one loan share one session lock
 *    across the ledger post. The second waits or refuses. A quote that has not
 *    set status to liquidating does not sell the debt from before a repayment
 *    that settled while that quote was in flight.
 * 2. Break: repay locks bank.loan.repay and liquidation locks bank.loan.liquidate.
 *    The quote runs inside the liquidation lock, then splitProceeds uses the
 *    plan's principal. The other operation posts the same debt.
 * 3. Done bar: one of loan.repaid / loan.liquidated when both run together; a
 *    4500 repayment during the quote leaves principal 500 and no sale; a lost
 *    repayment acknowledgement stays pending and is not sold; the same event
 *    id posts once; status liquidating refuses bank.loan_liquidating.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts
 * 6. RED: two collection posts; a sale after the in-quote repayment; a sale
 *    over a pending lost-ack repayment.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, marketMaker, parseAmount as amt, recipes, userAvailable, type PostRequest } from '@intafaced/ledger-client';
import { LoanService, marketMakerVenue } from './loan-service.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';

const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const MM = '33333333-3333-4333-8333-333333333333';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function seedBuyer(ledger: MemoryLedger) {
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
}

function atPrice(ledger: MemoryLedger, btc: string, venue = marketMakerVenue()) {
  return new LoanService(sql, ledger, {
    originationFeeBps: '0',
    priceSource: fixedPriceSource({ BTC: { price: btc, quality: 'mid' } }, () => NOW),
    venue,
  });
}

async function openLoan(ledger: MemoryLedger) {
  const healthy = atPrice(ledger, '10000');
  await fund(ledger, PAYER, 'USDT', '100000');
  await healthy.fundReserve({
    debtAssetId: 'USDT',
    fundingId: `f:${randomUUID()}`,
    amount: amt('100000'),
    from: userAvailable(PAYER, 'USDT'),
  });
  await fund(ledger, BORROWER, 'BTC', '1');
  await seedBuyer(ledger);
  // Spare USDT so a second collection is not stopped by the balance.
  await fund(ledger, BORROWER, 'USDT', '5000');
  const product = await healthy.createProduct({
    name: 'BTC-backed USDT',
    debtAssetId: 'USDT',
    collateralAssetId: 'BTC',
    quoteAssetId: 'USDT',
    aprBps: 1_000,
    maxLtvBps: 5_000,
    minPrincipal: 0n,
    policy: DEFAULT_LIQUIDATION_POLICY,
  });
  const opened = await healthy.open({
    productId: product.id,
    userId: BORROWER,
    collateralAmount: amt('1'),
    principal: amt('5000'),
    now: NOW,
  });
  return opened.loan;
}

function collections(ledger: MemoryLedger, loanId: string) {
  return ledger
    .journal()
    .filter((tx) => (tx.reason === 'loan.repaid' || tx.reason === 'loan.liquidated') && tx.idempotencyKey.includes(loanId));
}

describe('one lock covers repayment and liquidation', () => {
  beforeEach(async () => {
    await sql`
      TRUNCATE bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
               bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
               bank.loan_reserve_fundings
      RESTART IDENTITY CASCADE
    `;
  });

  it('a repay post and a liquidation sale overlap on one ledger post; the other waits', async () => {
    const ledger = new MemoryLedger();
    const loan = await openLoan(ledger);
    const loans = atPrice(ledger, '5200');
    const innerPost = ledger.post.bind(ledger);
    let parked = false;
    let releasePark!: () => void;
    const park = new Promise<void>((resolve) => {
      releasePark = () => resolve();
    });
    let sawLockWait = false;
    ledger.post = async (request: PostRequest) => {
      const posted = await innerPost(request);
      if (!parked && (request.reason === 'loan.repaid' || request.reason === 'loan.liquidated')) {
        parked = true;
        await park;
      }
      return posted;
    };

    let watch = true;
    const watcher = (async () => {
      while (watch) {
        if (parked) {
          const waits = await sql.unsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND pid <> pg_backend_pid()`,
          );
          if (Number(waits[0]?.n ?? 0) > 0) {
            sawLockWait = true;
            releasePark();
          }
          if (collections(ledger, loan.id).length >= 2) releasePark();
        }
        await sleep(20);
      }
    })();

    try {
      await Promise.race([
        Promise.allSettled([
          loans.repay({ loanId: loan.id, amount: amt('5000'), eventId: randomUUID(), now: NOW }).finally(releasePark),
          loans.runRiskSweep({ now: NOW, limit: 500 }).finally(releasePark),
        ]),
        sleep(15_000).then(() => {
          throw new Error('repay and liquidation did not finish');
        }),
      ]);
    } finally {
      watch = false;
      releasePark();
      ledger.post = innerPost;
      await watcher;
    }

    expect(sawLockWait).toBe(true);
    const repaid = await sql<Array<{ p: string }>>`
      SELECT COALESCE(SUM(principal_amount), 0)::text AS p
        FROM bank.loan_repayments WHERE loan_id = ${loan.id} AND status = 'settled'
    `;
    const sold = await sql<Array<{ p: string }>>`
      SELECT COALESCE(SUM(principal_repaid), 0)::text AS p
        FROM bank.loan_liquidations WHERE loan_id = ${loan.id} AND status = 'settled'
    `;
    // The overlapping pair must not collect the same principal twice. A partial
    // sale may leave a remainder the repayment then pays; the two together stop
    // at the debt that was outstanding.
    expect(amt(repaid[0]!.p) + amt(sold[0]!.p) <= amt('5000')).toBe(true);
    expect(ledger.reconcile()).toEqual({ ok: true });
  }, 20_000);

  it('a repayment that settles during the quote is not sold at the pre-repayment debt', async () => {
    const ledger = new MemoryLedger();
    const loan = await openLoan(ledger);
    let releaseQuote!: () => void;
    const quoteHeld = new Promise<void>((resolve) => {
      releaseQuote = () => resolve();
    });
    let quoteStarted!: () => void;
    const inQuote = new Promise<void>((resolve) => {
      quoteStarted = () => resolve();
    });
    const loans = atPrice(ledger, '5200', {
      quote: async (input) => {
        quoteStarted();
        await quoteHeld;
        return marketMakerVenue().quote(input);
      },
    });

    const sweep = loans.runRiskSweep({ now: NOW, limit: 500 });
    await inQuote;
    const repaid = await loans.repay({ loanId: loan.id, amount: amt('4500'), eventId: randomUUID(), now: NOW });
    releaseQuote();
    const result = await sweep;

    expect(repaid.principalPaid).toBe(amt('4500'));
    expect(repaid.interestPaid).toBe(0n);
    expect(result.refused).toEqual([]);
    expect(collections(ledger, loan.id).filter((tx) => tx.reason === 'loan.liquidated')).toHaveLength(0);
    expect((await loans.outstanding(loan.id)).principal).toBe(amt('500'));
    expect(await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${loan.id}`).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  }, 20_000);

  it('a lost repayment acknowledgement stays pending and is not collected by a sale', async () => {
    const ledger = new MemoryLedger();
    const loan = await openLoan(ledger);
    const eventId = randomUUID();
    const innerPost = ledger.post.bind(ledger);
    let lost = false;
    ledger.post = async (request: PostRequest) => {
      const posted = await innerPost(request);
      if (!lost && request.reason === 'loan.repaid') {
        lost = true;
        throw new Error('receipt lost after ledger commit');
      }
      return posted;
    };
    const loans = atPrice(ledger, '5200');
    await expect(loans.repay({ loanId: loan.id, amount: amt('1000'), eventId, now: NOW })).rejects.toThrow(
      'receipt lost after ledger commit',
    );
    ledger.post = innerPost;

    const pending = await sql`SELECT status, ledger_tx_id FROM bank.loan_repayments WHERE id = ${eventId}`;
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.ledger_tx_id).toBeNull();

    await expect(loans.seize({ loanId: loan.id, now: NOW })).rejects.toMatchObject({ code: 'bank.ledger_outcome_unknown' });
    expect(collections(ledger, loan.id).filter((tx) => tx.reason === 'loan.liquidated')).toHaveLength(0);
    const still = await sql`SELECT status FROM bank.loan_repayments WHERE id = ${eventId}`;
    expect(still[0]?.status).toBe('pending');
    expect(collections(ledger, loan.id).filter((tx) => tx.reason === 'loan.repaid')).toHaveLength(1);
  }, 20_000);

  it('posts the same repayment event id once', async () => {
    const ledger = new MemoryLedger();
    const loan = await openLoan(ledger);
    const loans = atPrice(ledger, '10000');
    const eventId = randomUUID();
    const first = await loans.repay({ loanId: loan.id, amount: amt('1000'), eventId, now: NOW });
    const again = await loans.repay({ loanId: loan.id, amount: amt('1000'), eventId, now: NOW });
    expect(again.ledgerTxId).toBe(first.ledgerTxId);
    expect(collections(ledger, loan.id).filter((tx) => tx.reason === 'loan.repaid')).toHaveLength(1);
    expect((await loans.outstanding(loan.id)).principal).toBe(amt('4000'));
  });

  it('refuses repay with bank.loan_liquidating once status is liquidating', async () => {
    const ledger = new MemoryLedger();
    const loan = await openLoan(ledger);
    await sql`UPDATE bank.loans SET status = 'liquidating' WHERE id = ${loan.id}`;
    const loans = atPrice(ledger, '5200');
    await expect(loans.repay({ loanId: loan.id, amount: amt('1000'), eventId: randomUUID(), now: NOW })).rejects.toMatchObject({
      code: 'bank.loan_liquidating',
    });
    expect(collections(ledger, loan.id)).toHaveLength(0);
  });

  it('a lost liquidation acknowledgement stays pending and repay does not collect it', async () => {
    const ledger = new MemoryLedger();
    const loan = await openLoan(ledger);
    const innerPost = ledger.post.bind(ledger);
    let lost = false;
    ledger.post = async (request: PostRequest) => {
      const posted = await innerPost(request);
      if (!lost && request.reason === 'loan.liquidated') {
        lost = true;
        throw new Error('receipt lost after ledger commit');
      }
      return posted;
    };
    const loans = atPrice(ledger, '5200');
    const sweep = await loans.runRiskSweep({ now: NOW, limit: 500 });
    ledger.post = innerPost;

    expect(sweep.refused.map((row) => row.reason)).toContain('receipt lost after ledger commit');
    const pending = await sql`SELECT status, ledger_tx_id FROM bank.loan_liquidations WHERE loan_id = ${loan.id}`;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.ledger_tx_id).toBeNull();
    await expect(loans.repay({ loanId: loan.id, amount: amt('1000'), eventId: randomUUID(), now: NOW })).rejects.toMatchObject({
      code: 'bank.loan_liquidating',
    });
    expect(collections(ledger, loan.id).filter((tx) => tx.reason === 'loan.repaid')).toHaveLength(0);
    expect(collections(ledger, loan.id).filter((tx) => tx.reason === 'loan.liquidated')).toHaveLength(1);
    const still = await sql`SELECT status FROM bank.loan_liquidations WHERE loan_id = ${loan.id}`;
    expect(still[0]?.status).toBe('pending');
  }, 20_000);
});
