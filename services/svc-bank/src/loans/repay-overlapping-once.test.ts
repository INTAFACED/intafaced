/**
 * Unit card — overlapping repayments pay the outstanding once
 *
 * 1. Promise: two repay calls in flight, different event ids, each offering the
 *    full debt, move that debt once. The lock that covers the debt re-read also
 *    covers the pending repayment and the post, and it is still held when the
 *    row is marked settled.
 * 2. Break: the loan lock commits before settle. The second caller reads
 *    outstanding() and pending repayments as two statements, so a settle that
 *    commits between them is in neither figure and the second split pays the
 *    full balance again.
 * 3. Done bar: one loan.repaid for the outstanding, the other call refuses
 *    bank.loan_closed, collateral releases once, and a retry of the posted
 *    event id does not post the repayment again. The borrower is funded for
 *    both, so a second post is not an insufficient-balance accident.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/loans/loan-service.ts (repay)
 * 6. RED: the second caller is let through the debt re-read, the first row is
 *    settled in that gap, and both callers post loan.repaid
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Sql, TransactionSql } from 'postgres';
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

function queryText(arg: unknown): string {
  if (Array.isArray(arg)) return arg.join(' ');
  return '';
}

function isDebtReread(text: string): boolean {
  return text.includes('WITH drawn AS') && text.includes('loan_repayments');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      loans: { originationFeeBps: '0', priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW) },
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
      releasePark = () => resolve();
    });
    // The first repayment has moved money and is not yet marked settled.
    // Releasing the park lets that settle commit.
    ledger.post = async (request: PostRequest) => {
      const posted = await innerPost(request);
      if (!parked && request.reason === 'loan.repaid') {
        parked = true;
        await park;
      }
      return posted;
    };

    let armed = false;
    let debtReads = 0;
    let sawLockWait = false;
    let settleResolve!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleResolve = resolve;
    });
    const originalBegin = sql.begin.bind(sql);
    const originalUnsafe = sql.unsafe.bind(sql);

    const onDebtReread = async () => {
      if (!armed) return;
      debtReads += 1;
      // The first read is the caller that already posted. The next read is the
      // overlapping caller. Hold it here, let the posted row settle, then allow
      // the pending read. A lock still held through settle never reaches this
      // gap: the second read starts only after that settle.
      if (debtReads < 2) return;
      releasePark();
      await Promise.race([
        settled,
        sleep(8_000).then(() => {
          throw new Error('settle did not commit between the debt re-read and the pending repayment');
        }),
      ]);
    };

    const tapTx = (tx: TransactionSql): TransactionSql =>
      new Proxy(tx, {
        apply(target, thisArg, argArray: unknown[]) {
          const text = queryText(argArray[0]);
          const run = Reflect.apply(target, thisArg, argArray) as Promise<unknown>;
          if (!isDebtReread(text)) return run;
          return run.then(async (rows) => {
            await onDebtReread();
            return rows;
          });
        },
      });

    sql.begin = (async (options: unknown, fn?: unknown) => {
      if (typeof options === 'function') {
        return originalBegin((tx) => (options as (tx: TransactionSql) => unknown)(tapTx(tx)));
      }
      return originalBegin(options as string, (tx) => (fn as (tx: TransactionSql) => unknown)(tapTx(tx)));
    }) as typeof sql.begin;

    sql.unsafe = ((query: string, parameters?: Parameters<Sql['unsafe']>[1], queryOptions?: Parameters<Sql['unsafe']>[2]) => {
      const pending = originalUnsafe(query, parameters, queryOptions);
      const note = () => {
        if (armed && query.includes('UPDATE bank.loan_repayments') && query.includes("status = 'settled'")) settleResolve();
      };
      const execute = pending.execute.bind(pending);
      pending.execute = (async () => {
        const result = await execute();
        note();
        return result;
      }) as typeof pending.execute;
      const then = pending.then.bind(pending);
      pending.then = ((onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        then((value: unknown) => {
          note();
          return onFulfilled ? onFulfilled(value) : value;
        }, onRejected)) as typeof pending.then;
      return pending;
    }) as typeof sql.unsafe;

    let watch = true;
    const watcher = (async () => {
      while (watch) {
        if (parked) {
          const waits = await originalUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND pid <> pg_backend_pid()`,
          );
          if (Number(waits[0]?.n ?? 0) > 0) {
            sawLockWait = true;
            releasePark();
          }
        }
        await sleep(20);
      }
    })();

    armed = true;
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([
        bank.loans.repay({ loanId: opened.loan.id, amount: amt('5000'), eventId: eventA, now: NOW }).finally(releasePark),
        bank.loans.repay({ loanId: opened.loan.id, amount: amt('5000'), eventId: eventB, now: NOW }).finally(releasePark),
      ]);
    } finally {
      armed = false;
      watch = false;
      releasePark();
      sql.begin = originalBegin;
      sql.unsafe = originalUnsafe;
      await watcher;
    }

    expect(debtReads >= 2 || sawLockWait).toBe(true);

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
