/**
 * BK-loan-06: loans.projection, loans.payoffQuote and loans.statement (J-bank-11 steps 1 and 6).
 * Harness from releasable.test.ts. Reads post nothing.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { signStatement } from '../statements/statement-file.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY, dailyLoanInterest } from './risk.js';

const SECRET = 'bank-loan-reads-statement-secret-32';
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

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

function caller(bank: ReturnType<typeof createBankServices>, p: Principal = principal()) {
  return createBankRouter(bank).createCaller(
    edgeContext({ headers: signedHeaders(p), id: `req-${randomUUID()}` } as unknown as Parameters<typeof edgeContext>[0]),
  );
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

describe('loans.projection, payoffQuote, statement (BK-loan-06)', () => {
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

  function services(reads: { payoffFee?: string | null; payoffWindowMinutes?: string | null; statementSecret?: string | null } = {}) {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      loans: {
        priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => NOW),
        payoffFee: reads.payoffFee === undefined ? '0' : reads.payoffFee,
        payoffWindowMinutes: reads.payoffWindowMinutes === undefined ? '15' : reads.payoffWindowMinutes,
        statementSecret: reads.statementSecret === undefined ? SECRET : reads.statementSecret,
      },
    });
  }

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
    return bank.loans.open({
      productId: product.id,
      userId: BORROWER,
      collateralAmount: amt('1'),
      principal: amt('100'),
      now: NOW,
    });
  }

  it('projects 30 days with the accrual rule, quotes a published fee, and posts nothing', async () => {
    const bank = services();
    const opened = await seed(bank);
    const posted = ledger.journal().length;
    const me = caller(bank);
    const [first, second] = await Promise.all([
      me.loans.projection({ loanId: opened.loan.id, days: 30 }),
      me.loans.projection({ loanId: opened.loan.id, days: 30 }),
    ]);
    expect(second).toEqual(first);
    expect(first.kind).toBe('projection');
    expect(first.obligation).toBe(false);
    expect(first.rows).toHaveLength(30);
    expect(first.openingPrincipal).toBe('100');
    expect(first.openingInterest).toBe('0');
    expect(first.rows[0]!.interest).toBe(formatAmount(dailyLoanInterest(amt('100'), 500)));
    const quote = await me.loans.payoffQuote({ loanId: opened.loan.id });
    expect(quote).toMatchObject({ principal: '100', interest: '0', fee: '0', total: '100', assetId: 'USDT' });
    expect(Date.parse(quote.validUntil)).toBeGreaterThan(Date.now());
    const priced = await bank.loans.payoffQuote({ loanId: opened.loan.id, now: NOW });
    expect(priced.validUntil).toBe('2026-06-01T12:15:00.000Z');
    expect(ledger.journal()).toHaveLength(posted);
  });

  it('adds a published fee, and a blank fee or window refuses without a post', async () => {
    const bank = services({ payoffFee: '1.25' });
    const opened = await seed(bank);
    const posted = ledger.journal().length;
    const quote = await caller(bank).loans.payoffQuote({ loanId: opened.loan.id });
    expect(quote).toMatchObject({ principal: '100', interest: '0', fee: '1.25', total: '101.25' });
    const blankFee = services({ payoffFee: '' });
    await expect(caller(blankFee).loans.payoffQuote({ loanId: opened.loan.id })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.loan_fee_unset' }),
    });
    const blankWindow = services({ payoffWindowMinutes: '' });
    await expect(caller(blankWindow).loans.payoffQuote({ loanId: opened.loan.id })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.loan_payoff_window_unset' }),
    });
    expect(ledger.journal()).toHaveLength(posted);
  });

  it('a repay after a quote uses the books, not the earlier total', async () => {
    const bank = services({ payoffFee: '1.25' });
    const opened = await seed(bank);
    const before = await bank.loans.payoffQuote({ loanId: opened.loan.id, now: NOW });
    expect(before.total).toBe('101.25');
    await bank.loans.repay({ loanId: opened.loan.id, eventId: randomUUID(), amount: amt('40'), now: NOW });
    const after = await bank.loans.payoffQuote({ loanId: opened.loan.id, now: NOW });
    expect(after.principal).toBe('60');
    expect(after.fee).toBe('1.25');
    expect(after.total).toBe('61.25');
  });

  it('refuses another user and signs a statement whose empty month opens and closes at zero', async () => {
    const bank = services();
    const opened = await seed(bank);
    const stranger = principal({ sub: PAYER, userId: PAYER });
    await expect(caller(bank, stranger).loans.projection({ loanId: opened.loan.id, days: 30 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(bank, stranger).loans.statement({
        loanId: opened.loan.id,
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const empty = await bank.loans.statement({
      loanId: opened.loan.id,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-05-01T00:00:00.000Z',
      now: NOW,
    });
    expect(empty.rowCount).toBe(0);
    expect(empty.openingPrincipal).toBe(empty.closingPrincipal);
    expect(empty.openingInterest).toBe(empty.closingInterest);
    expect(empty.openingPrincipal).toBe('0');
    expect(empty.provisional).toBe(false);
    const month = await caller(bank).loans.statement({
      loanId: opened.loan.id,
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
    expect(month.provisional).toBe(true);
    expect(month.closingPrincipal).toBe('100');
    expect(month.openingPrincipal).toBe('0');
    expect(month.rowCount).toBeGreaterThan(0);
    const bytes = Buffer.from(month.bodyBase64, 'base64');
    expect(bytes.toString('utf8')).toContain(opened.drawLedgerTxId);
    expect(signStatement(SECRET, bytes)).toEqual({ sha256: month.sha256, signature: month.signature });
    const unsigned = services({ statementSecret: '' });
    await expect(
      unsigned.loans.statement({
        loanId: opened.loan.id,
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'bank.statement_unavailable' });
  });
});
