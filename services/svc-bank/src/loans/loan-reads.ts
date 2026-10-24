import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { csvCell, signStatement } from '../statements/statement-file.js';
import { accrualDay, dailyLoanInterest } from './risk.js';

/**
 * BK-loan-06 (J-bank-11 steps 1 and 6). Reads only.
 *
 * A crypto-backed loan has no instalment schedule. `projectLoanDays` replays
 * the same `dailyLoanInterest` the accrual job posts, and the result is a
 * projection, never an obligation. A payoff quote adds only a fee the owner
 * published, and only a published zero for now: repay has no fee entry, so a
 * quote that added one would ask for money repay never collects. A blank fee
 * or a blank validity window refuses; nothing here stores a quote or posts.
 */

const WINDOW_MAX_MINUTES = 10_080;
/** The most lines in one loan statement, as for the account statement. A wider range is refused, never cut. */
const MAX_STATEMENT_LINES = 5_000;

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
  /** The last UTC day whose interest the quote includes: today, so it holds until the day ends. */
  readonly interestThrough: string;
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
  const fee = parseAmount(text);
  if (fee !== 0n) {
    throw new BankError(
      'A loan payoff fee is published, but repay cannot collect a fee, so no payoff quote is given',
      'bank.loan_fee_unsupported',
    );
  }
  return fee;
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
 * The next `days` UTC accrual days after `chargedThrough` (the last day `accrue`
 * charged, or the open day), compounding the way `accrue` does: each day is
 * charged on the debt at the end of the previous day, rounded down. Days the
 * job has not charged yet, today included, are the first rows.
 */
export function projectLoanDays(input: {
  loanId: string;
  principal: Amount;
  interest: Amount;
  aprBps: number;
  days: number;
  chargedThrough: string;
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
  const start = input.chargedThrough;
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

/**
 * What clears the loan today. `unchargedDays` are the days `accrue` has not
 * charged yet, through today (`daysToAccrue`); their interest is added with the
 * same rule, so the quote does not go stale when the job runs later today. It
 * holds until the owner's window ends or the UTC day ends, whichever is first:
 * tomorrow's interest is not in it. Repay never takes more than is owed, so
 * paying the quote clears the loan whether or not the job has run.
 */
export function quotePayoff(input: {
  loanId: string;
  principal: Amount;
  interest: Amount;
  aprBps: number;
  unchargedDays: readonly string[];
  daysPerYear?: number;
  assetId: string;
  feeRaw: string | null | undefined;
  windowRaw: string | null | undefined;
  now: Date;
}): PayoffQuote {
  if (input.principal + input.interest <= 0n) {
    throw new BankError(`Loan ${input.loanId} has nothing outstanding`, 'bank.loan_closed');
  }
  assertApr(input.aprBps);
  const fee = parsePayoffFee(input.feeRaw);
  const minutes = parsePayoffWindowMinutes(input.windowRaw);
  let interest = input.interest;
  for (let n = 0; n < input.unchargedDays.length; n += 1) {
    interest += dailyLoanInterest(input.principal + interest, input.aprBps, input.daysPerYear);
  }
  const total = input.principal + interest + fee;
  const today = accrualDay(input.now);
  const windowEnd = input.now.getTime() + minutes * 60_000;
  const dayEnd = Date.parse(`${addUtcDays(today, 1)}T00:00:00.000Z`);
  return {
    loanId: input.loanId,
    principal: formatAmount(input.principal),
    interest: formatAmount(interest),
    fee: formatAmount(fee),
    total: formatAmount(total),
    assetId: input.assetId,
    interestThrough: today,
    validUntil: new Date(Math.min(windowEnd, dayEnd)).toISOString(),
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
  const adjusted = await sql<Array<{ v: string }>>`
    SELECT COALESCE(SUM(amount), 0)::text AS v
      FROM bank.loan_adjustments
     WHERE loan_id = ${loanId} AND kind = 'interest_correction' AND created_at < ${cutoff}
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
  const interest =
    parseAmount(accrued[0]?.v ?? '0') +
    parseAmount(adjusted[0]?.v ?? '0') -
    parseAmount(repaid[0]?.i ?? '0') -
    parseAmount(seized[0]?.i ?? '0');
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
  pool: Sql,
  loan: {
    id: string;
    debtAssetId: string;
    collateralAssetId: string;
    principal: Amount;
    drawLedgerTxId: string | null;
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
  // Every read sees one snapshot, so a repayment that settles while the file is built
  // cannot make the lines disagree with the opening and closing debt.
  const read = await pool.begin('isolation level repeatable read read only', async (tx) => {
    const sql = tx as unknown as Sql;
    // opened_at is the pending insert. The draw can fail and land later; drawn_at
    // is written in the same update as draw_ledger_tx_id.
    const drawnRows = await sql<Array<{ drawn_at: Date | null }>>`
    SELECT drawn_at FROM bank.loans WHERE id = ${loan.id}
  `;
    const drawnAt = drawnRows[0]?.drawn_at ?? null;
    // One more than the cap is read from each kind, so a range over the cap is refused, never cut.
    const cap = MAX_STATEMENT_LINES + 1;
    const [opening, closing, accruals, adjustments, repayments, collateral, liquidations] = await Promise.all([
      debtBefore(sql, loan.id, from, loan.principal, drawnAt),
      debtBefore(sql, loan.id, to, loan.principal, drawnAt),
      sql<Array<{ accrual_date: string; interest_amount: string }>>`
      SELECT accrual_date::text AS accrual_date, interest_amount::text AS interest_amount
        FROM bank.loan_interest_accruals
       WHERE loan_id = ${loan.id}
         AND accrual_date >= ${utcDay(from)}::date
         AND accrual_date < ${utcDay(to)}::date
       ORDER BY accrual_date ASC
       LIMIT ${cap}
    `,
      sql<Array<{ created_at: Date; amount: string }>>`
      SELECT created_at, amount::text AS amount
        FROM bank.loan_adjustments
       WHERE loan_id = ${loan.id} AND kind = 'interest_correction'
         AND created_at >= ${from}
         AND created_at < ${to}
       ORDER BY created_at ASC, id ASC
       LIMIT ${cap}
    `,
      sql<Array<{ settled_at: Date; interest_amount: string; principal_amount: string; ledger_tx_id: string | null }>>`
      SELECT COALESCE(settled_at, created_at) AS settled_at, interest_amount::text AS interest_amount,
             principal_amount::text AS principal_amount, ledger_tx_id
        FROM bank.loan_repayments
       WHERE loan_id = ${loan.id} AND status = 'settled'
         AND COALESCE(settled_at, created_at) >= ${from}
         AND COALESCE(settled_at, created_at) < ${to}
       ORDER BY settled_at ASC, sequence ASC
       LIMIT ${cap}
    `,
      sql<Array<{ settled_at: Date; direction: string; sequence: number; amount: string; ledger_tx_id: string | null }>>`
      SELECT COALESCE(settled_at, created_at) AS settled_at, direction, sequence, amount::text AS amount, ledger_tx_id
        FROM bank.loan_collateral_events
       WHERE loan_id = ${loan.id} AND status = 'settled'
         AND COALESCE(settled_at, created_at) >= ${from}
         AND COALESCE(settled_at, created_at) < ${to}
       ORDER BY settled_at ASC, sequence ASC
       LIMIT ${cap}
    `,
      sql<
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
       LIMIT ${cap}
    `,
    ]);
    return { drawnAt, opening, closing, accruals, adjustments, repayments, collateral, liquidations };
  });
  const { drawnAt, opening, closing, accruals, adjustments, repayments, collateral, liquidations } = read;
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
  // An approved correction (LOAN-05), signed: below zero took interest off, above zero added interest. It moves no value.
  for (const row of adjustments) {
    const interest = parseAmount(row.amount);
    lines.push({
      kind: 'interest_correction',
      at: row.created_at.toISOString(),
      amount: interest,
      interest,
      principal: 0n,
      asset: loan.debtAssetId,
      ledgerTxId: '',
    });
  }
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
  for (const row of collateral) {
    // Sequence 0 is the pledge made when the loan opened; later locks are top-ups.
    const kind =
      row.direction === 'release' ? 'collateral_release' : Number(row.sequence) === 0 ? 'collateral_pledge' : 'collateral_top_up';
    lines.push({
      kind,
      at: row.settled_at.toISOString(),
      amount: parseAmount(row.amount),
      interest: 0n,
      principal: 0n,
      asset: loan.collateralAssetId,
      ledgerTxId: row.ledger_tx_id ?? '',
    });
  }
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
  if (lines.length > MAX_STATEMENT_LINES) {
    throw new BankError(`A loan statement holds at most ${MAX_STATEMENT_LINES} lines. Narrow the dates.`, 'bank.statement_too_large');
  }
  // Time order. The sort is stable, so lines at the same instant keep the order above.
  lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const provisional = toMs > now.getTime();
  const generatedAt = now.toISOString();
  // Opening and closing debt are rows of their own, so the file stays plain CSV and carries them.
  const row = (kind: string, at: string, amount: Amount, interest: Amount, principal: Amount, asset: string, ledgerTxId: string) =>
    [
      csvCell(kind, true),
      csvCell(at, false),
      csvCell(formatAmount(amount), false),
      csvCell(formatAmount(interest), false),
      csvCell(formatAmount(principal), false),
      csvCell(asset, true),
      csvCell(ledgerTxId, true),
    ].join(',');
  const text = [
    'kind,at,amount,interest,principal,asset,ledgerTxId',
    row('opening', from.toISOString(), opening.principal + opening.interest, opening.interest, opening.principal, loan.debtAssetId, ''),
    ...lines.map((line) => row(line.kind, line.at, line.amount, line.interest, line.principal, line.asset, line.ledgerTxId)),
    row(
      provisional ? 'closing_provisional' : 'closing',
      to.toISOString(),
      closing.principal + closing.interest,
      closing.interest,
      closing.principal,
      loan.debtAssetId,
      '',
    ),
  ];
  const bytes = Buffer.from(`\uFEFF${text.join('\r\n')}\r\n`, 'utf8');
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
