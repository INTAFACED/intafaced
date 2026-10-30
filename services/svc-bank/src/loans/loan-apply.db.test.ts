/**
 * The loan application's money-side rules on a real database (BK-loan-01, BK-loan-02, J-bank-09 #4 and #5):
 * a loan opened before an origination fee was published still replays as that loan once the fee is published, while a
 * new loan refuses; and an operator's rate change is recorded with its reason and approver, its previous rate read under
 * the row's lock, so two changes never report the same previous rate, a repeat of the current rate refuses, and the
 * record can't be edited.
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

const BORROWER = '11111111-1111-4111-8111-111111111112';
const PAYER = '99999999-9999-4999-8999-999999999998';
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
    recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${randomUUID()}` }),
  );
}

describe('the loan application on a real database', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.loan_product_rate_changes, bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
               bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
               bank.loan_reserve_fundings
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  function services(originationFeeBps: string | null = '0') {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW),
        originationFeeBps,
      },
    });
  }

  async function product(bank: ReturnType<typeof createBankServices>) {
    await fund(ledger, PAYER, 'USDT', '100000');
    await bank.loans.fundReserve({
      debtAssetId: 'USDT',
      fundingId: `f:${randomUUID()}`,
      amount: amt('100000'),
      from: userAvailable(PAYER, 'USDT'),
    });
    await fund(ledger, BORROWER, 'BTC', '2');
    return bank.loans.createProduct({
      name: 'BTC-backed USDT',
      debtAssetId: 'USDT',
      collateralAssetId: 'BTC',
      quoteAssetId: 'USDT',
      aprBps: 500,
      maxLtvBps: 5_000,
      minPrincipal: amt('1'),
      policy: DEFAULT_LIQUIDATION_POLICY,
    });
  }

  it('replays a loan opened under a zero fee, and refuses only a new one once the fee is blank or above zero', async () => {
    const before = services('0');
    const made = await product(before);
    const loanId = randomUUID();
    const terms = { loanId, productId: made.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('100'), now: NOW };
    const first = await before.loans.open(terms);
    const posted = ledger.journal().length;

    // The owner publishes a fee svc-bank can't collect yet.
    const after = services('50');
    const replay = await after.loans.open(terms);
    expect(replay.loan.id).toBe(loanId);
    expect(replay.drawLedgerTxId).toBe(first.drawLedgerTxId);
    expect(replay.collateralLedgerTxId).toBe(first.collateralLedgerTxId);
    expect(ledger.journal().length, 'the replay moves nothing').toBe(posted);

    await expect(after.loans.open({ ...terms, loanId: randomUUID() })).rejects.toMatchObject({ code: 'bank.loan_fee_unwired' });
    await expect(after.loans.open({ ...terms, loanId: undefined })).rejects.toMatchObject({ code: 'bank.loan_fee_unwired' });

    // The fee left blank: a retry still replays, and a new loan refuses as not set.
    const blank = services(null);
    expect((await blank.loans.open(terms)).loan.id).toBe(loanId);
    await expect(blank.loans.open({ ...terms, loanId: randomUUID() })).rejects.toMatchObject({ code: 'bank.loan_fee_unset' });
    await expect(blank.loans.open({ ...terms, loanId: undefined })).rejects.toMatchObject({ code: 'bank.loan_fee_unset' });
    const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.loans`;
    const n = row?.n;
    expect(n, 'no row for a refused new loan').toBe(1);
    expect(ledger.journal().length).toBe(posted);
  });

  it('records each rate change with its reason, approval and approver, bound to the rate it replaces, and replays by approval', async () => {
    const bank = services();
    const made = await product(bank);
    // Two changes both read 500: the row lock lets one replace it, and the other finds the rate moved.
    const raced = await Promise.allSettled([
      bank.loans.setProductRate({
        productId: made.id,
        fromAprBps: 500,
        aprBps: 600,
        reason: 'first change',
        approvalId: 'appr-1',
        approvedBy: 'founder-b',
      }),
      bank.loans.setProductRate({
        productId: made.id,
        fromAprBps: 500,
        aprBps: 700,
        reason: 'second change',
        approvalId: 'appr-2',
        approvedBy: 'founder-c',
      }),
    ]);
    const done = raced.flatMap((c) => (c.status === 'fulfilled' ? [c.value] : []));
    const lost = raced.flatMap((c) => (c.status === 'rejected' ? [c.reason] : []));
    expect(done).toHaveLength(1);
    expect(done[0]!.previousAprBps).toBe(500);
    expect(lost).toEqual([expect.objectContaining({ code: 'bank.loan_rate_moved' })]);
    const rows = await sql<Array<{ apr_bps: number; previous_apr_bps: number; reason: string; approval_id: string; approved_by: string }>>`
      SELECT apr_bps, previous_apr_bps, reason, approval_id, approved_by FROM bank.loan_product_rate_changes WHERE product_id = ${made.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ previous_apr_bps: 500, apr_bps: done[0]!.product.aprBps });
    const current = (await bank.loans.product(made.id)).aprBps;
    expect(current).toBe(rows[0]!.apr_bps);

    // A retry with the approval that made it reads the same change back; the same approval for other terms refuses.
    const terms = { productId: made.id, fromAprBps: 500, aprBps: current, reason: rows[0]!.reason };
    expect(await bank.loans.rateChangeByApproval(rows[0]!.approval_id, terms)).toEqual({
      productId: made.id,
      aprBps: current,
      previousAprBps: 500,
      approvedBy: rows[0]!.approved_by,
    });
    await expect(bank.loans.rateChangeByApproval(rows[0]!.approval_id, { ...terms, aprBps: 900 })).rejects.toMatchObject({
      code: 'bank.loan_rate_approval_reused',
    });
    expect(await bank.loans.rateChangeByApproval('appr-unused', terms)).toBeNull();

    // Checked before the approval is spent: a stale "from", no real change, a blank reason.
    await expect(bank.loans.checkRateChange({ ...terms, fromAprBps: 500, aprBps: 800 })).rejects.toMatchObject({
      code: 'bank.loan_rate_moved',
    });
    await expect(bank.loans.checkRateChange({ ...terms, fromAprBps: current, aprBps: current })).rejects.toMatchObject({
      code: 'bank.loan_params_invalid',
    });
    await expect(bank.loans.checkRateChange({ ...terms, fromAprBps: current, aprBps: 800, reason: ' ' })).rejects.toMatchObject({
      code: 'bank.loan_params_invalid',
    });
    const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.loan_product_rate_changes`;
    const n = row?.n;
    expect(n, 'a refused change records nothing').toBe(1);
    await expect(sql`UPDATE bank.loan_product_rate_changes SET reason = 'edited'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM bank.loan_product_rate_changes`).rejects.toThrow(/append-only/);
  });

  it('opens a new loan only at the rate the borrower was shown; a retry of an opened loan replays', async () => {
    const bank = services();
    const made = await product(bank);
    const loanId = randomUUID();
    const terms = { loanId, productId: made.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('100'), now: NOW };
    const first = await bank.loans.open({ ...terms, expectedAprBps: 500 });
    await bank.loans.setProductRate({
      productId: made.id,
      fromAprBps: 500,
      aprBps: 900,
      reason: 'rate up',
      approvalId: 'appr-up',
      approvedBy: 'founder-b',
    });
    const posted = ledger.journal().length;
    // The retry carries the rate it was shown; the loan it opened keeps 500 and replays.
    const replay = await bank.loans.open({ ...terms, expectedAprBps: 500 });
    expect(replay.drawLedgerTxId).toBe(first.drawLedgerTxId);
    expect(replay.loan.aprBps).toBe(500);
    // A new loan shown 500 while the product now charges 900 refuses, with nothing written or moved.
    await expect(
      bank.loans.open({ ...terms, loanId: randomUUID(), collateralAmount: amt('0.5'), expectedAprBps: 500 }),
    ).rejects.toMatchObject({
      code: 'bank.loan_rate_changed',
    });
    const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.loans`;
    const n = row?.n;
    expect(n).toBe(1);
    expect(ledger.journal().length).toBe(posted);
  });
});
