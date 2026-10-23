import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { signStatement } from '../statements/statement-file.js';
import { dailyLoanInterest } from './risk.js';

/**
 * BK-loan-06 (J-bank-11 steps 1 and 6). Reads only.
 *
 * A crypto-backed loan has no instalment schedule. `projectLoanDays` replays
 * the same `dailyLoanInterest` the accrual job posts, and the result is a
 * projection, never an obligation. A payoff quote adds only a fee the owner
 * published. A blank fee or a blank validity window refuses; nothing here
 * stores a quote or posts.
 */

export const BANK_LOAN_PAYOFF_FEE_ENV = 'BANK_LOAN_PAYOFF_FEE';
export const BANK_LOAN_PAYOFF_WINDOW_ENV = 'BANK_LOAN_PAYOFF_WINDOW_MINUTES';

const WINDOW_MAX_MINUTES = 10_080;

export interface ProjectionRow {
  readonly date: string;
  readonly basis: string;
  readonly interest: string;
  readonly principal: string;
  readonly debt: string;
}

export interface LoanProjection {
  readonly loanId: string;
  readonly kind: 'projection';
  readonly obligation: false;
  readonly aprBps: number;
  readonly days: number;
  readonly openingPrincipal: string;
  readonly openingInterest: string;
  readonly extraApplied: string | null;
  readonly rows: ProjectionRow[];
}

export interface PayoffQuote {
  readonly loanId: string;
  readonly principal: string;
  readonly interest: string;
  readonly fee: string;
  readonly total: string;
  readonly assetId: string;
  readonly validUntil: string;
}

export interface LoanStatementFile {
  readonly format: 'csv';
  readonly filename: string;
  readonly contentType: 'text/csv; charset=utf-8';
  readonly bodyBase64: string;
  readonly sha256: string;
  readonly signature: string;
  readonly rowCount: number;
  readonly provisional: boolean;
  readonly openingPrincipal: string;
  readonly openingInterest: string;
  readonly closingPrincipal: string;
  readonly closingInterest: string;
  readonly generatedAt: string;
}

export function parsePayoffFee(raw: string | null | undefined): Amount {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+(\.\d{1,18})?$/.test(text)) {
    throw new BankError('The owner has not published the loan payoff fee, so no payoff quote is given', 'bank.loan_fee_unset');
  }
  return parseAmount(text);
}

export function parsePayoffWindowMinutes(raw: string | null | undefined): number {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) {
    throw new BankError(
      'The owner has not published how long a loan payoff quote stays valid, so no payoff quote is given',
      'bank.loan_payoff_window_unset',
    );
  }
  const minutes = Number(text);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > WINDOW_MAX_MINUTES) {
    throw new BankError(
      'The owner has not published how long a loan payoff quote stays valid, so no payoff quote is given',
      'bank.loan_payoff_window_unset',
    );
  }
  return minutes;
}

function assertApr(aprBps: number): void {
  if (!Number.isInteger(aprBps) || aprBps < 0 || aprBps > 10_000) {
    throw new BankError('This loan has no usable rate snapshot, so it cannot be projected', 'bank.loan_terms_missing');
  }
}

/** Interest first, then principal. Never more than is owed. */
export function applyInterestFirst(
  principal: Amount,
  interest: Amount,
  payment: Amount,
): { principal: Amount; interest: Amount; applied: Amount } {
  const owed = principal + interest;
  const applied = payment > owed ? owed : payment;
  const toInterest = applied < interest ? applied : interest;
  return { principal: principal - (applied - toInterest), interest: interest - toInterest, applied };
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function addUtcDays(day: string, n: number): string {
  const cursor = new Date(`${day}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + n);
  return utcDay(cursor);
}

/**
 * The next `days` UTC accrual days after `asOf`, compounding the way `accrue` does:
 * each day is charged on the debt at the end of the previous day, rounded down.
 */
export function projectLoanDays(input: {
  loanId: string;
  principal: Amount;
  interest: Amount;
  aprBps: number;
  days: number;
  asOf: Date;
  daysPerYear?: number;
  extraRepayment?: Amount;
}): LoanProjection {
  assertApr(input.aprBps);
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 366) {
    throw new BankError('A loan projection covers 1 to 366 days', 'bank.statement_range');
  }
  const applied =
    input.extraRepayment && input.extraRepayment > 0n ? applyInterestFirst(input.principal, input.interest, input.extraRepayment) : null;
  let principal = applied ? applied.principal : input.principal;
  let interest = applied ? applied.interest : input.interest;
  const openingPrincipal = formatAmount(principal);
  const openingInterest = formatAmount(interest);
  const start = utcDay(input.asOf);
  const rows: ProjectionRow[] = [];
  for (let n = 1; n <= input.days; n += 1) {
    const basis = principal + interest;
    const charge = dailyLoanInterest(basis, input.aprBps, input.daysPerYear);
    interest += charge;
    rows.push({
      date: addUtcDays(start, n),
      basis: formatAmount(basis),
      interest: formatAmount(charge),
      principal: formatAmount(principal),
      debt: formatAmount(principal + interest),
    });
  }
  return {
    loanId: input.loanId,
    kind: 'projection',
    obligation: false,
    aprBps: input.aprBps,
    days: input.days,
    openingPrincipal,
    openingInterest,
    extraApplied: applied ? formatAmount(applied.applied) : null,
    rows,
  };
}

export function quotePayoff(input: {
  loanId: string;
  principal: Amount;
  interest: Amount;
  assetId: string;
  feeRaw: string | null | undefined;
  windowRaw: string | null | undefined;
  now: Date;
}): PayoffQuote {
  if (input.principal + input.interest <= 0n) {
    throw new BankError(`Loan ${input.loanId} has nothing outstanding`, 'bank.loan_closed');
  }
  const fee = parsePayoffFee(input.feeRaw);
  const minutes = parsePayoffWindowMinutes(input.windowRaw);
  const total = input.principal + input.interest + fee;
  return {
    loanId: input.loanId,
    principal: formatAmount(input.principal),
    interest: formatAmount(input.interest),
    fee: formatAmount(fee),
    total: formatAmount(total),
    assetId: input.assetId,
    validUntil: new Date(input.now.getTime() + minutes * 60_000).toISOString(),
  };
}

interface DebtParts {
  principal: Amount;
  interest: Amount;
}

async function debtBefore(sql: Sql, loanId: string, cutoff: Date, drawnPrincipal: Amount, drawnAt: Date | null): Promise<DebtParts> {
  const day = utcDay(cutoff);
  const drawn = drawnAt !== null && drawnAt.getTime() < cutoff.getTime() ? drawnPrincipal : 0n;
  const accrued = await sql<Array<{ v: string }>>`
    SELECT COALESCE(SUM(interest_amount), 0)::text AS v
      FROM bank.loan_interest_accruals
     WHERE loan_id = ${loanId} AND accrual_date < ${day}::date
  `;
  const repaid = await sql<Array<{ p: string; i: string }>>`
    SELECT COALESCE(SUM(principal_amount), 0)::text AS p, COALESCE(SUM(interest_amount), 0)::text AS i
      FROM bank.loan_repayments
     WHERE loan_id = ${loanId} AND status = 'settled' AND COALESCE(settled_at, created_at) < ${cutoff}
  `;
  const seized = await sql<Array<{ p: string; i: string; s: string }>>`
    SELECT COALESCE(SUM(principal_repaid), 0)::text AS p,
           COALESCE(SUM(interest_repaid), 0)::text AS i,
           COALESCE(SUM(
             CASE
               WHEN shortfall > 0 AND bad_debt_ledger_tx_id IS NOT NULL THEN shortfall
               ELSE 0
             END
           ), 0)::text AS s
      FROM bank.loan_liquidations
     WHERE loan_id = ${loanId}
       AND status = 'settled'
       AND COALESCE(settled_at, created_at) < ${cutoff}
  `;
  // Insured shortfall is principal the books wrote off. It counts on the sale's
  // cutoff, and only once bad_debt_ledger_tx_id is set, the same rule as outstanding().
  const principal = drawn - parseAmount(repaid[0]?.p ?? '0') - parseAmount(seized[0]?.p ?? '0') - parseAmount(seized[0]?.s ?? '0');
  const interest = parseAmount(accrued[0]?.v ?? '0') - parseAmount(repaid[0]?.i ?? '0') - parseAmount(seized[0]?.i ?? '0');
  return { principal: principal > 0n ? principal : 0n, interest: interest > 0n ? interest : 0n };
}

interface StatementLine {
  kind: string;
  at: string;
  amount: Amount;
  interest: Amount;
  principal: Amount;
  asset: string;
  ledgerTxId: string;
}

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function assertRange(from: string, to: string): { fromMs: number; toMs: number } {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new BankError('The statement end is not after the start', 'bank.statement_range');
  }
  if (toMs - fromMs > 366 * 24 * 60 * 60 * 1000) {
    throw new BankError('A statement covers at most 366 days', 'bank.statement_range');
  }
  return { fromMs, toMs };
}

export async function buildLoanStatement(
  sql: Sql,
  loan: {
    id: string;
    debtAssetId: string;
    collateralAssetId: string;
    principal: Amount;
    drawLedgerTxId: string | null;
    openedAt: Date;
  },
  secret: string | null | undefined,
  input: { from: string; to: string; now?: Date },
): Promise<LoanStatementFile> {
  const trimmed = typeof secret === 'string' ? secret.trim() : '';
  if (!trimmed) {
    throw new BankError('Statements are not available until the service secret is set', 'bank.statement_unavailable');
  }
  const { fromMs, toMs } = assertRange(input.from, input.to);
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const now = input.now ?? new Date();
  const drawnAt = loan.drawLedgerTxId ? loan.openedAt : null;
  const opening = await debtBefore(sql, loan.id, from, loan.principal, drawnAt);
  const closing = await debtBefore(sql, loan.id, to, loan.principal, drawnAt);
  const lines: StatementLine[] = [];
  if (drawnAt && drawnAt.getTime() >= fromMs && drawnAt.getTime() < toMs) {
    lines.push({
      kind: 'draw',
      at: drawnAt.toISOString(),
      amount: loan.principal,
      interest: 0n,
      principal: loan.principal,
      asset: loan.debtAssetId,
      ledgerTxId: loan.drawLedgerTxId ?? '',
    });
  }
  const accruals = await sql<Array<{ accrual_date: string; interest_amount: string }>>`
    SELECT accrual_date::text AS accrual_date, interest_amount::text AS interest_amount
      FROM bank.loan_interest_accruals
     WHERE loan_id = ${loan.id}
       AND accrual_date >= ${utcDay(from)}::date
       AND accrual_date < ${utcDay(to)}::date
     ORDER BY accrual_date ASC
  `;
  for (const row of accruals) {
    const interest = parseAmount(row.interest_amount);
    lines.push({
      kind: 'interest',
      at: `${row.accrual_date}T00:00:00.000Z`,
      amount: interest,
      interest,
      principal: 0n,
      asset: loan.debtAssetId,
      ledgerTxId: '',
    });
  }
  const repayments = await sql<Array<{ settled_at: Date; interest_amount: string; principal_amount: string; ledger_tx_id: string | null }>>`
    SELECT COALESCE(settled_at, created_at) AS settled_at, interest_amount::text AS interest_amount,
           principal_amount::text AS principal_amount, ledger_tx_id
      FROM bank.loan_repayments
     WHERE loan_id = ${loan.id} AND status = 'settled'
       AND COALESCE(settled_at, created_at) >= ${from}
       AND COALESCE(settled_at, created_at) < ${to}
     ORDER BY settled_at ASC, sequence ASC
  `;
  for (const row of repayments) {
    const interest = parseAmount(row.interest_amount);
    const principal = parseAmount(row.principal_amount);
    lines.push({
      kind: 'repayment',
      at: row.settled_at.toISOString(),
      amount: interest + principal,
      interest,
      principal,
      asset: loan.debtAssetId,
      ledgerTxId: row.ledger_tx_id ?? '',
    });
  }
  const collateral = await sql<Array<{ settled_at: Date; direction: string; amount: string; ledger_tx_id: string | null }>>`
    SELECT COALESCE(settled_at, created_at) AS settled_at, direction, amount::text AS amount, ledger_tx_id
      FROM bank.loan_collateral_events
     WHERE loan_id = ${loan.id} AND status = 'settled'
       AND COALESCE(settled_at, created_at) >= ${from}
       AND COALESCE(settled_at, created_at) < ${to}
     ORDER BY settled_at ASC, sequence ASC
  `;
  for (const row of collateral) {
    const amount = parseAmount(row.amount);
    lines.push({
      kind: row.direction === 'release' ? 'collateral_release' : 'collateral_top_up',
      at: row.settled_at.toISOString(),
      amount,
      interest: 0n,
      principal: 0n,
      asset: loan.collateralAssetId,
      ledgerTxId: row.ledger_tx_id ?? '',
    });
  }
  const liquidations = await sql<
    Array<{
      settled_at: Date;
      interest_repaid: string;
      principal_repaid: string;
      shortfall: string;
      ledger_tx_id: string | null;
      bad_debt_ledger_tx_id: string | null;
    }>
  >`
    SELECT COALESCE(settled_at, created_at) AS settled_at, interest_repaid::text AS interest_repaid,
           principal_repaid::text AS principal_repaid, shortfall::text AS shortfall,
           ledger_tx_id, bad_debt_ledger_tx_id
      FROM bank.loan_liquidations
     WHERE loan_id = ${loan.id} AND status = 'settled'
       AND COALESCE(settled_at, created_at) >= ${from}
       AND COALESCE(settled_at, created_at) < ${to}
     ORDER BY settled_at ASC, tranche ASC
  `;
  for (const row of liquidations) {
    const interest = parseAmount(row.interest_repaid);
    const principal = parseAmount(row.principal_repaid);
    const at = row.settled_at.toISOString();
    lines.push({
      kind: 'liquidation',
      at,
      amount: interest + principal,
      interest,
      principal,
      asset: loan.debtAssetId,
      ledgerTxId: row.ledger_tx_id ?? '',
    });
    const shortfall = parseAmount(row.shortfall);
    if (shortfall > 0n && row.bad_debt_ledger_tx_id !== null) {
      lines.push({
        kind: 'liquidation_shortfall',
        at,
        amount: shortfall,
        interest: 0n,
        principal: shortfall,
        asset: loan.debtAssetId,
        ledgerTxId: row.bad_debt_ledger_tx_id,
      });
    }
  }
  const provisional = toMs > now.getTime();
  const generatedAt = now.toISOString();
  const header = [
    'kind,at,amount,interest,principal,asset,ledgerTxId',
    `# loan ${loan.id}`,
    `# statement`,
    `# provisional ${provisional ? 'true' : 'false'}`,
    `# openingPrincipal ${formatAmount(opening.principal)}`,
    `# openingInterest ${formatAmount(opening.interest)}`,
    `# closingPrincipal ${formatAmount(closing.principal)}`,
    `# closingInterest ${formatAmount(closing.interest)}`,
  ];
  const body = lines.map((line) =>
    [line.kind, line.at, formatAmount(line.amount), formatAmount(line.interest), formatAmount(line.principal), line.asset, line.ledgerTxId]
      .map(cell)
      .join(','),
  );
  const bytes = Buffer.from([...header, ...body, ''].join('\n'), 'utf8');
  const signed = signStatement(trimmed, bytes);
  return {
    format: 'csv',
    filename: `intafaced-loan-${loan.id}-${input.from.slice(0, 10)}.csv`,
    contentType: 'text/csv; charset=utf-8',
    bodyBase64: bytes.toString('base64'),
    sha256: signed.sha256,
    signature: signed.signature,
    rowCount: lines.length,
    provisional,
    openingPrincipal: formatAmount(opening.principal),
    openingInterest: formatAmount(opening.interest),
    closingPrincipal: formatAmount(closing.principal),
    closingInterest: formatAmount(closing.interest),
    generatedAt,
  };
}
