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
        originationFeeBps: '0',
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
    expect(quote).toMatchObject({ principal: '100', fee: '0', assetId: 'USDT' });
    expect(Date.parse(quote.validUntil)).toBeGreaterThan(Date.now());
    const priced = await bank.loans.payoffQuote({ loanId: opened.loan.id, now: NOW });
    expect(priced).toMatchObject({ principal: '100', interest: '0', fee: '0', total: '100', interestThrough: '2026-06-01' });
    expect(priced.validUntil).toBe('2026-06-01T12:15:00.000Z');
    expect(ledger.journal()).toHaveLength(posted);
  });

  it('a fee repay cannot collect, a blank fee or a blank window refuses without a post', async () => {
    const bank = services({ payoffFee: '1.25' });
    const opened = await seed(bank);
    const posted = ledger.journal().length;
    await expect(caller(bank).loans.payoffQuote({ loanId: opened.loan.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'bank.loan_fee_unsupported' }),
    });
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
    const bank = services();
    const opened = await seed(bank);
    const before = await bank.loans.payoffQuote({ loanId: opened.loan.id, now: NOW });
    expect(before.total).toBe('100');
    await bank.loans.repay({ loanId: opened.loan.id, eventId: randomUUID(), amount: amt('40'), now: NOW });
    const after = await bank.loans.payoffQuote({ loanId: opened.loan.id, now: NOW });
    expect(after.principal).toBe('60');
    expect(after.fee).toBe('0');
    expect(after.total).toBe('60');
  });

  it('includes the days accrual has not charged yet, and paying the quote clears the loan', async () => {
    const bank = services({ payoffWindowMinutes: '1440' });
    const opened = await seed(bank);
    const later = new Date('2026-06-04T09:00:00.000Z');
    await bank.loans.accrue({ loanId: opened.loan.id, until: new Date('2026-06-02T09:00:00.000Z') });
    const projection = await bank.loans.projection({ loanId: opened.loan.id, days: 2 });
    expect(projection.rows.map((row) => row.date)).toEqual(['2026-06-03', '2026-06-04']);
    const quote = await bank.loans.payoffQuote({ loanId: opened.loan.id, now: later });
    expect(quote.interestThrough).toBe('2026-06-04');
    expect(quote.validUntil).toBe('2026-06-05T00:00:00.000Z');
    await bank.loans.accrue({ loanId: opened.loan.id, until: later });
    const books = await bank.loans.outstanding(opened.loan.id);
    expect(quote.total).toBe(formatAmount(books.total));
    await fund(ledger, BORROWER, 'USDT', '1');
    const paid = await bank.loans.repay({ loanId: opened.loan.id, eventId: randomUUID(), amount: amt(quote.total), now: later });
    expect(paid.closed).toBe(true);
  });

  it('refuses a quote while a repayment outcome or a sale is still pending', async () => {
    const bank = services();
    const opened = await seed(bank);
    await sql`
      INSERT INTO bank.loan_repayments (id, loan_id, sequence, principal_amount, interest_amount, status)
      VALUES (${randomUUID()}, ${opened.loan.id}, 1, '10'::numeric, '0'::numeric, 'pending')
    `;
    await expect(bank.loans.payoffQuote({ loanId: opened.loan.id, now: NOW })).rejects.toMatchObject({
      code: 'bank.ledger_outcome_unknown',
    });
    await sql`DELETE FROM bank.loan_repayments WHERE loan_id = ${opened.loan.id}`;
    await sql`
      INSERT INTO bank.loan_liquidations (
        loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
        principal_repaid, interest_repaid, penalty, surplus_returned, shortfall, status
      ) VALUES (
        ${opened.loan.id}, 0, 9000, '10000'::numeric, '0.008'::numeric, '80'::numeric,
        '80'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, 'pending'
      )
    `;
    await expect(bank.loans.payoffQuote({ loanId: opened.loan.id, now: NOW })).rejects.toMatchObject({
      code: 'bank.loan_liquidating',
    });
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
    expect(bytes.toString('utf8')).toContain('\r\ncollateral_pledge,');
    expect(bytes.toString('utf8')).not.toContain('collateral_top_up');
    expect(bytes.toString('utf8')).toContain('\r\nclosing_provisional,');
    statementDebt(bytes.toString('utf8'), month.openingPrincipal, month.openingInterest);
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

  it('dates the draw from drawn_at, so a window before that draw does not include it', async () => {
    const bank = services();
    const opened = await seed(bank);
    const openedAt = new Date('2026-06-01T12:00:00.000Z');
    const drawnAt = new Date('2026-06-10T12:00:00.000Z');
    await sql`
      UPDATE bank.loans
         SET opened_at = ${openedAt}, drawn_at = ${drawnAt}
       WHERE id = ${opened.loan.id}
    `;
    const earlier = await bank.loans.statement({
      loanId: opened.loan.id,
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-05T00:00:00.000Z',
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(earlier.openingPrincipal).toBe('0');
    expect(earlier.closingPrincipal).toBe('0');
    expect(earlier.openingInterest).toBe('0');
    expect(earlier.closingInterest).toBe('0');
    const earlierText = Buffer.from(earlier.bodyBase64, 'base64').toString('utf8');
    expect(statementDebt(earlierText, earlier.openingPrincipal, earlier.openingInterest).rows.map((row) => row.kind)).not.toContain('draw');
    expect(earlierText).not.toContain(opened.drawLedgerTxId);

    const later = await bank.loans.statement({
      loanId: opened.loan.id,
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-15T00:00:00.000Z',
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(later.openingPrincipal).toBe('0');
    expect(later.closingPrincipal).toBe('100');
    expect(later.openingInterest).toBe('0');
    expect(later.closingInterest).toBe('0');
    const laterText = Buffer.from(later.bodyBase64, 'base64').toString('utf8');
    const summed = statementDebt(laterText, later.openingPrincipal, later.openingInterest);
    expect(summed.principal).toBe('100');
    expect(summed.rows.filter((row) => row.kind === 'draw')).toEqual([
      { kind: 'draw', interest: '0', principal: '100', ledgerTxId: opened.drawLedgerTxId },
    ]);
    expect(laterText).toContain(`draw,${drawnAt.toISOString()},100,0,100,USDT,${opened.drawLedgerTxId}`);
    expect(laterText).not.toContain(openedAt.toISOString());
  });

  it('writes off an insured liquidation shortfall so closing debt is zero and the lines sum to it', async () => {
    const bank = services();
    const opened = await seed(bank);
    const saleAt = new Date('2026-06-15T00:00:00.000Z');
    await sql`
      INSERT INTO bank.loan_liquidations (
        loan_id, tranche, ltv_bps, mark_price, collateral_sold, proceeds,
        principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
        status, ledger_tx_id, bad_debt_ledger_tx_id, settled_at
      ) VALUES (
        ${opened.loan.id}, 0, 9000, '10000'::numeric, '0.008'::numeric, '80'::numeric,
        '80'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '20'::numeric,
        'settled', 'sale-tx-80', 'bad-debt-tx-20', ${saleAt}
      )
    `;
    const books = await bank.loans.outstanding(opened.loan.id);
    expect(formatAmount(books.principal)).toBe('0');
    expect(formatAmount(books.interest)).toBe('0');
    const file = await bank.loans.statement({
      loanId: opened.loan.id,
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      now: new Date('2026-07-02T00:00:00.000Z'),
    });
    expect(file.closingPrincipal).toBe('0');
    expect(file.closingInterest).toBe('0');
    expect(file.closingPrincipal).toBe(formatAmount(books.principal));
    expect(file.closingInterest).toBe(formatAmount(books.interest));
    const text = Buffer.from(file.bodyBase64, 'base64').toString('utf8');
    const summed = statementDebt(text, file.openingPrincipal, file.openingInterest);
    expect(summed.principal).toBe(file.closingPrincipal);
    expect(summed.interest).toBe(file.closingInterest);
    const sale = summed.rows.find((row) => row.kind === 'liquidation');
    const wroteOff = summed.rows.find((row) => row.kind === 'liquidation_shortfall');
    expect(sale).toMatchObject({ principal: '80', interest: '0', ledgerTxId: 'sale-tx-80' });
    expect(wroteOff).toMatchObject({ principal: '20', interest: '0', ledgerTxId: 'bad-debt-tx-20' });
    expect(signStatement(SECRET, Buffer.from(file.bodyBase64, 'base64'))).toEqual({
      sha256: file.sha256,
      signature: file.signature,
    });
  });
});

/** Opening plus draws and interest, minus repayments, sales and insured shortfall. */
function statementDebt(text: string, openingPrincipal: string, openingInterest: string) {
  let principal = amt(openingPrincipal);
  let interest = amt(openingInterest);
  const rows: Array<{ kind: string; interest: string; principal: string; ledgerTxId: string }> = [];
  const lines = text.replace(/^\uFEFF/, '').split('\r\n');
  expect(lines[0]).toBe('kind,at,amount,interest,principal,asset,ledgerTxId');
  expect(csvCells(lines[1] ?? '').slice(0, 5)).toEqual([
    'opening',
    expect.any(String),
    expect.any(String),
    openingInterest,
    openingPrincipal,
  ]);
  let lastAt = '';
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = csvCells(line);
    const kind = cells[0] ?? '';
    if (kind === 'opening' || kind === 'closing' || kind === 'closing_provisional') continue;
    expect(cells[1]! >= lastAt).toBe(true);
    lastAt = cells[1]!;
    const interestCell = cells[3] ?? '0';
    const principalCell = cells[4] ?? '0';
    const ledgerTxId = cells[6] ?? '';
    rows.push({ kind, interest: interestCell, principal: principalCell, ledgerTxId });
    const linePrincipal = amt(principalCell);
    const lineInterest = amt(interestCell);
    if (kind === 'draw' || kind === 'interest') {
      principal += linePrincipal;
      interest += lineInterest;
    } else if (kind === 'repayment' || kind === 'liquidation' || kind === 'liquidation_shortfall') {
      principal -= linePrincipal;
      interest -= lineInterest;
    } else if (linePrincipal !== 0n || lineInterest !== 0n) {
      throw new Error(`statement line ${kind} moves debt and is not in the sum`);
    }
  }
  return { principal: formatAmount(principal), interest: formatAmount(interest), rows };
}

function csvCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = false;
      } else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(current);
      current = '';
    } else current += ch;
  }
  cells.push(current);
  return cells;
}
