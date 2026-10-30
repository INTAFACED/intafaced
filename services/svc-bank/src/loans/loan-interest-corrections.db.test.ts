/**
 * LOAN-05 (J-bank-11 #4): interest corrections as new rows, append-only interest tables, and the per-loan ledger check.
 * Harness from loan-reads.db.test.ts. A correction moves no value; the ledger check reads only.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { actionApprovalSchema, createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { bankActionPayloadHash, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { ADJUST_LOAN_INTEREST_ACTION, correctionApprovalFields } from './loan-adjustments.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY } from './risk.js';

const SECRET = 'bank-loan-corrections-statement-secret';
const BORROWER = '11111111-1111-4111-8111-111111111111';
const PAYER = '99999999-9999-4999-8999-999999999999';
const FOUNDER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOUNDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const LATER = new Date('2026-06-11T09:00:00.000Z');

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

afterAll(async () => {
  await db.drop();
}, 30_000);

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: BORROWER,
    userId: BORROWER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function context(p: Principal) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
      'content-type': 'application/json',
    },
    id: `req-${randomUUID()}`,
  } as unknown as Parameters<typeof edgeContext>[0]);
}

/**
 * Identity, as far as this door sees it: founder A proposed exactly these fields, founder B approved, and each
 * approval is consumed once. A consume whose hash is not the proposal's is refused, as identity refuses it.
 */
function identity() {
  const proposals = new Map<string, { payloadHash: string; consumed: boolean }>();
  let consumes = 0;
  const consumer: ActionApprovalConsumer = {
    async consume(input) {
      consumes += 1;
      const row = proposals.get(input.approvalId);
      if (!row || row.payloadHash !== input.payloadHash || row.consumed) throw new Error('action_approval.consume_failed');
      row.consumed = true;
      return actionApprovalSchema.parse({
        ...input,
        actionType: input.targetId,
        requesterId: FOUNDER_A,
        approverId: FOUNDER_B,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'v1',
        createdAt: '2026-06-01T12:00:00.000Z',
        expiresAt: '2026-06-01T12:10:00.000Z',
        status: 'CONSUMED',
      });
    },
  };
  return {
    consumer,
    consumes: () => consumes,
    approve(fields: Record<string, string>) {
      const approvalId = `appr-${randomUUID()}`;
      proposals.set(approvalId, { payloadHash: bankActionPayloadHash(ADJUST_LOAN_INTEREST_ACTION, fields), consumed: false });
      return { approvalId, operationId: `op-${randomUUID()}` };
    },
  };
}

async function fund(ledger: MemoryLedger, userId: string, assetId: string, value: string) {
  await ledger.post(
    recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${randomUUID()}` }),
  );
}

describe('interest corrections and the per-loan ledger check (LOAN-05)', () => {
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

  function services() {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        originationFeeBps: '0',
        priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW),
        payoffFee: '0',
        payoffWindowMinutes: '15',
        statementSecret: SECRET,
      },
    });
  }

  /** One drawn loan of 100 USDT at 5% that has accrued ten days. */
  async function seed(bank: ReturnType<typeof createBankServices>) {
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
    await bank.loans.accrue({ loanId: opened.loan.id, until: LATER });
    return opened.loan.id;
  }

  function door(bank: ReturnType<typeof createBankServices>, ids: ReturnType<typeof identity>) {
    return createBankRouter(bank, { approvals: ids.consumer }).createCaller(
      context(principal({ sub: FOUNDER_A, userId: FOUNDER_A, scopes: ['admin:treasury'], mfa: true })),
    );
  }

  it('A proposes a correction and B approves: a new row with its reason, the interest owed falls by it, no past day changes and nothing posts', async () => {
    const bank = services();
    const loanId = await seed(bank);
    const ids = identity();
    const before = await bank.loans.interestRows(await bank.loans.loan(loanId));
    expect(before.days).toHaveLength(10);
    expect(before.owed).toBe(before.accrued);
    const posted = ledger.journal().length;

    const terms = { loanId, adjustmentId: randomUUID(), amount: '-0.05', reason: 'TEST: one day was charged on the wrong basis' };
    const approval = ids.approve(correctionApprovalFields(terms));
    const written = await door(bank, ids).ops.adjustLoanInterest({ ...terms, ...approval });
    expect(written).toMatchObject({
      adjustmentId: terms.adjustmentId,
      amount: '-0.05',
      reason: terms.reason,
      proposedBy: FOUNDER_A,
      approvedBy: FOUNDER_B,
      replay: false,
      interestOwed: formatAmount(before.accrued - amt('0.05')),
    });

    const after = await caller(bank).loans.interestRows({ loanId });
    expect(after.days).toEqual(
      before.days.map((d) => ({ date: d.date, rateBps: d.rateBps, basis: formatAmount(d.basis), interest: formatAmount(d.interest) })),
    );
    expect(after.corrections).toEqual([expect.objectContaining({ id: terms.adjustmentId, amount: '-0.05', reason: terms.reason })]);
    expect(after.corrected).toBe('-0.05');
    expect(amt(after.owed)).toBe(amt(after.accrued) + amt(after.corrected) - amt(after.paid));
    expect((await bank.loans.outstanding(loanId)).interest).toBe(before.accrued - amt('0.05'));
    expect(ledger.journal()).toHaveLength(posted);

    // The statement carries the correction as its own line, and its lines still add up to the closing debt.
    // The correction is written now, so the statement runs from the loan's first day to tomorrow.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const statement = await bank.loans.statement({ loanId, from: '2026-06-01T00:00:00.000Z', to: tomorrow });
    const csv = Buffer.from(statement.bodyBase64, 'base64').toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
    const lines = csv.slice(1).map((l) => l.split(','));
    const correction = lines.find((l) => l[0] === 'interest_correction');
    expect(correction?.slice(2, 5)).toEqual(['-0.05', '-0.05', '0']);
    const interest = lines.filter((l) => l[0] === 'interest' || l[0] === 'interest_correction').reduce((s, l) => s + amt(l[3]!), 0n);
    expect(formatAmount(interest)).toBe(statement.closingInterest);
  });

  it('a retry with the same id and terms returns the first row without spending another approval; other terms conflict', async () => {
    const bank = services();
    const loanId = await seed(bank);
    const ids = identity();
    const terms = { loanId, adjustmentId: randomUUID(), amount: '-0.01', reason: 'TEST: retried correction' };
    const approval = ids.approve(correctionApprovalFields(terms));
    const ops = door(bank, ids).ops;
    await ops.adjustLoanInterest({ ...terms, ...approval });
    const again = await ops.adjustLoanInterest({ ...terms, ...approval });
    expect(again.replay).toBe(true);
    expect(ids.consumes()).toBe(1);
    await expect(ops.adjustLoanInterest({ ...terms, amount: '-0.02', ...approval })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'bank.correction_conflict' }),
    });
    const rows = await sql`SELECT id FROM bank.loan_adjustments WHERE loan_id = ${loanId}`;
    expect(rows).toHaveLength(1);
  });

  it('an approval for other fields is refused by identity and writes nothing', async () => {
    const bank = services();
    const loanId = await seed(bank);
    const ids = identity();
    const terms = { loanId, adjustmentId: randomUUID(), amount: '-0.01', reason: 'TEST: approved amount' };
    const approval = ids.approve(correctionApprovalFields(terms));
    await expect(door(bank, ids).ops.adjustLoanInterest({ ...terms, amount: '-0.02', ...approval })).rejects.toBeTruthy();
    expect(await sql`SELECT id FROM bank.loan_adjustments`).toHaveLength(0);
  });

  it('refuses taking off more interest than is owed, before the approval is spent', async () => {
    const bank = services();
    const loanId = await seed(bank);
    const ids = identity();
    const owed = (await bank.loans.outstanding(loanId)).interest;
    const terms = { loanId, adjustmentId: randomUUID(), amount: formatAmount(-(owed + 1n)), reason: 'TEST: more than owed' };
    const approval = ids.approve(correctionApprovalFields(terms));
    await expect(door(bank, ids).ops.adjustLoanInterest({ ...terms, ...approval })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'bank.correction_exceeds_interest' }),
    });
    expect(ids.consumes()).toBe(0);
    // Exactly what is owed is allowed, and leaves no interest.
    const all = { ...terms, adjustmentId: randomUUID(), amount: formatAmount(-owed), reason: 'TEST: all of it' };
    await door(bank, ids).ops.adjustLoanInterest({ ...all, ...ids.approve(correctionApprovalFields(all)) });
    expect((await bank.loans.outstanding(loanId)).interest).toBe(0n);
  });

  it('refuses a zero amount, a blank reason, a pending repayment and a closed loan', async () => {
    const bank = services();
    const loanId = await seed(bank);
    const base = { loanId, adjustmentId: randomUUID(), amount: '-0.01', reason: 'TEST: refusals' };
    await expect(bank.loans.checkCorrection({ ...base, amount: '0' })).rejects.toMatchObject({ code: 'bank.correction_invalid' });
    await expect(bank.loans.checkCorrection({ ...base, reason: '  ' })).rejects.toMatchObject({ code: 'bank.correction_invalid' });
    await sql`
      INSERT INTO bank.loan_repayments (id, loan_id, sequence, principal_amount, interest_amount, status)
      VALUES (${randomUUID()}, ${loanId}, 1, '10'::numeric, '0'::numeric, 'pending')
    `;
    await expect(
      bank.loans.correctInterest(base, { proposedBy: FOUNDER_A, approvedBy: FOUNDER_B, approvalId: 'appr-pending' }),
    ).rejects.toMatchObject({ code: 'bank.ledger_outcome_unknown' });
    await sql`UPDATE bank.loans SET status = 'repaid' WHERE id = ${loanId}`;
    await expect(bank.loans.checkCorrection(base)).rejects.toMatchObject({ code: 'bank.loan_closed' });
  });

  it('the database refuses a correction approved by its proposer', async () => {
    const bank = services();
    const loanId = await seed(bank);
    await expect(
      bank.loans.correctInterest(
        { loanId, adjustmentId: randomUUID(), amount: '-0.01', reason: 'TEST: one person' },
        { proposedBy: FOUNDER_A, approvedBy: FOUNDER_A, approvalId: 'appr-self' },
      ),
    ).rejects.toThrow(/loan_adjustments_four_eyes_ck/);
  });

  it('accrual days and corrections are append-only: an UPDATE or DELETE raises', async () => {
    const bank = services();
    const loanId = await seed(bank);
    await bank.loans.correctInterest(
      { loanId, adjustmentId: randomUUID(), amount: '0.01', reason: 'TEST: added interest' },
      { proposedBy: FOUNDER_A, approvedBy: FOUNDER_B, approvalId: 'appr-add' },
    );
    await expect(sql`UPDATE bank.loan_interest_accruals SET interest_amount = 0 WHERE loan_id = ${loanId}`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM bank.loan_interest_accruals WHERE loan_id = ${loanId}`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE bank.loan_adjustments SET amount = 1 WHERE loan_id = ${loanId}`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM bank.loan_adjustments WHERE loan_id = ${loanId}`).rejects.toThrow(/append-only/);
    expect(await sql`SELECT id FROM bank.loan_interest_accruals WHERE loan_id = ${loanId}`).toHaveLength(10);
  });

  it('the ledger check agrees leg by leg after a draw, a repayment and a release, and names a row settled under the wrong transaction', async () => {
    const bank = services();
    const loanId = await seed(bank);
    await fund(ledger, BORROWER, 'USDT', '1');
    await bank.loans.repay({ loanId, eventId: randomUUID(), amount: amt('30'), now: LATER });
    await bank.loans.releaseExcess({ loanId, eventId: randomUUID(), amount: amt('0.1'), now: NOW });

    const agrees = await caller(bank).loans.ledgerCheck({ loanId });
    expect(agrees).toMatchObject({
      status: 'agrees',
      checked: 4,
      pending: 0,
      collateralHeld: '0.9',
      collateralExpected: '0.9',
      mismatches: [],
    });

    const draw = (await bank.loans.loan(loanId)).drawLedgerTxId;
    await sql`UPDATE bank.loan_repayments SET ledger_tx_id = ${draw} WHERE loan_id = ${loanId}`;
    const differs = await bank.loans.ledgerCheck(await bank.loans.loan(loanId));
    expect(differs.status).toBe('differs');
    expect(differs.mismatches).toEqual([expect.objectContaining({ kind: 'repayment', ref: '0', problem: 'key' })]);
  });

  it('a move still pending reads as pending, never as a difference', async () => {
    const bank = services();
    const loanId = await seed(bank);
    await sql`
      INSERT INTO bank.loan_collateral_events (id, loan_id, sequence, direction, amount, status)
      VALUES (${randomUUID()}, ${loanId}, 7, 'lock', '0.2'::numeric, 'pending')
    `;
    const check = await bank.loans.ledgerCheck(await bank.loans.loan(loanId));
    expect(check).toMatchObject({ status: 'pending', pending: 1, mismatches: [] });
  });

  it('two requests with one correction id race: one row, and the second answers with it', async () => {
    const bank = services();
    const loanId = await seed(bank);
    const terms = { loanId, adjustmentId: randomUUID(), amount: '-0.01', reason: 'TEST: sent twice at once' };
    const [a, b] = await Promise.all([
      bank.loans.correctInterest(terms, { proposedBy: FOUNDER_A, approvedBy: FOUNDER_B, approvalId: 'appr-race-1' }),
      bank.loans.correctInterest(terms, { proposedBy: FOUNDER_A, approvedBy: FOUNDER_B, approvalId: 'appr-race-2' }),
    ]);
    expect([a.replay, b.replay].sort()).toEqual([false, true]);
    expect(a.adjustment.id).toBe(b.adjustment.id);
    expect(await sql`SELECT id FROM bank.loan_adjustments WHERE loan_id = ${loanId}`).toHaveLength(1);
  });

  it('counts a reason in characters, as the database does', async () => {
    const bank = services();
    const loanId = await seed(bank);
    await expect(bank.loans.checkCorrection({ loanId, adjustmentId: randomUUID(), amount: '-0.01', reason: '😀😀' })).rejects.toMatchObject(
      {
        code: 'bank.correction_invalid',
      },
    );
  });

  it('another person cannot read the interest rows or the ledger check', async () => {
    const bank = services();
    const loanId = await seed(bank);
    const stranger = caller(bank, principal({ sub: PAYER, userId: PAYER }));
    await expect(stranger.loans.interestRows({ loanId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(stranger.loans.ledgerCheck({ loanId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

function caller(bank: ReturnType<typeof createBankServices>, p: Principal = principal()) {
  return createBankRouter(bank).createCaller(context(p));
}
