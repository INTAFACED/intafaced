import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  loanCollateralAccount,
  parseAmount,
  recipes,
  type AccountRef,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { signedAmountString } from '../router/shared.js';

/**
 * LOAN-05 (J-bank-11 #4): interest corrections, the loan's interest rows, and the per-loan check against the ledger.
 *
 * A correction is a NEW row in `bank.loan_adjustments`, never an edit of a past day: both interest tables refuse
 * UPDATE and DELETE (migration 20261024143716). It moves no value. Like a day of accrual it changes what is owed, and
 * `outstanding()` adds it to the interest leg. Taking off more interest than is owed now is refused: interest already
 * paid would have to come back as money, and that needs a recipe this slice does not have.
 *
 * The ledger check rebuilds each settled draw, repayment and collateral movement with the same `recipes` the loan
 * posted them through, and compares it with the transaction the ledger booked under that row's id: the key, and every
 * leg's account, side and amount. It also compares the loan's collateral pot with the settled locks, releases and
 * sales. It reads; it never repairs. A difference is reported, never fixed here.
 */

export const ADJUST_LOAN_INTEREST_ACTION = 'bank.adjust_loan_interest';

/** The most accrual days the interest rows list, newest first. Older days are counted, never cut silently. */
export const INTEREST_ROWS_LISTED = 366;

export interface InterestCorrectionTerms {
  readonly adjustmentId: string;
  readonly loanId: string;
  /** Signed decimal string, exactly as proposed: it is part of the approval's hash. */
  readonly amount: string;
  readonly reason: string;
}

export interface InterestAdjustment {
  readonly id: string;
  readonly loanId: string;
  readonly kind: 'interest_correction';
  readonly amount: Amount;
  readonly reason: string;
  readonly proposedBy: string;
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly createdAt: Date;
}

/** The fields the four-eyes approval binds, exactly as the founders proposed them. */
export function correctionApprovalFields(terms: InterestCorrectionTerms): Record<string, string> {
  return { loanId: terms.loanId, adjustmentId: terms.adjustmentId, amount: terms.amount, reason: terms.reason };
}

/** Shape only. The amount is signed and never zero; the reason is a sentence a person can read back. */
export function parseCorrection(terms: InterestCorrectionTerms): { amount: Amount; reason: string } {
  if (!signedAmountString.safeParse(terms.amount).success) {
    throw new BankError('An interest correction needs a signed decimal amount', 'bank.correction_invalid');
  }
  const amount = parseAmount(terms.amount);
  if (amount === 0n) throw new BankError('An interest correction of zero changes nothing', 'bank.correction_invalid');
  const reason = terms.reason.trim();
  // Counted in characters, as the database CHECK counts them (char_length), not in UTF-16 units.
  const length = [...reason].length;
  if (length < 3 || length > 500) {
    throw new BankError('An interest correction needs a reason of 3 to 500 characters', 'bank.correction_invalid');
  }
  if (reason !== terms.reason) {
    throw new BankError('An interest correction reason has no leading or trailing spaces', 'bank.correction_invalid');
  }
  return { amount, reason };
}

interface AdjustmentRow {
  id: string;
  loan_id: string;
  kind: string;
  amount: string;
  reason: string;
  proposed_by: string;
  approved_by: string;
  approval_id: string;
  created_at: Date;
}

function toAdjustment(row: AdjustmentRow): InterestAdjustment {
  return {
    id: row.id,
    loanId: row.loan_id,
    kind: 'interest_correction',
    amount: parseAmount(row.amount),
    reason: row.reason,
    proposedBy: row.proposed_by,
    approvedBy: row.approved_by,
    approvalId: row.approval_id,
    createdAt: row.created_at,
  };
}

export async function adjustmentById(sql: Sql, id: string): Promise<InterestAdjustment | null> {
  const rows = await sql<AdjustmentRow[]>`
    SELECT id, loan_id, kind, amount::text AS amount, reason, proposed_by, approved_by, approval_id, created_at
      FROM bank.loan_adjustments WHERE id = ${id}
  `;
  return rows[0] ? toAdjustment(rows[0]) : null;
}

/** The same correction again: same loan, amount and reason. Anything else under that id is a conflict. */
export function assertSameCorrection(prior: InterestAdjustment, terms: InterestCorrectionTerms): void {
  const { amount, reason } = parseCorrection(terms);
  if (prior.loanId !== terms.loanId || prior.amount !== amount || prior.reason !== reason) {
    throw new BankError(`Correction ${prior.id} already exists with other terms`, 'bank.correction_conflict');
  }
}

interface CorrectionDeps {
  readonly sql: Sql;
  readonly outstanding: (loanId: string, tx: Sql) => Promise<{ principal: Amount; interest: Amount; total: Amount }>;
}

/**
 * Every refusal a correction can meet, read under `tx`. Called once before the approval is spent (so a correction
 * that cannot land does not use it up) and again under the loan row lock, where it decides.
 */
async function assertCorrectable(deps: CorrectionDeps, tx: Sql, loanId: string, amount: Amount, lock: boolean): Promise<void> {
  const loans = lock
    ? await tx<Array<{ status: string }>>`SELECT status FROM bank.loans WHERE id = ${loanId} FOR UPDATE`
    : await tx<Array<{ status: string }>>`SELECT status FROM bank.loans WHERE id = ${loanId}`;
  const status = loans[0]?.status;
  if (!status) throw new BankError(`No loan ${loanId}`, 'bank.loan_not_found');
  if (status === 'repaid' || status === 'liquidated') throw new BankError(`Loan ${loanId} is ${status}`, 'bank.loan_closed');
  if (status === 'pending') throw new BankError(`Loan ${loanId} has no drawn principal`, 'bank.loan_not_drawable');
  if (status === 'liquidating') throw new BankError(`Loan ${loanId} is mid-liquidation`, 'bank.loan_liquidating');
  // A repayment or a sale whose ledger outcome is unknown split its money against the interest owed before this
  // correction. Correcting under it could make that split wrong, so the correction waits for it.
  const open = await tx<Array<{ repayments: string; sales: string; shortfalls: string }>>`
    SELECT (SELECT COUNT(*) FROM bank.loan_repayments WHERE loan_id = ${loanId} AND status = 'pending')::text AS repayments,
           (SELECT COUNT(*) FROM bank.loan_liquidations WHERE loan_id = ${loanId} AND status = 'pending')::text AS sales,
           (SELECT COUNT(*) FROM bank.loan_liquidations
             WHERE loan_id = ${loanId} AND status = 'settled' AND shortfall > 0 AND bad_debt_ledger_tx_id IS NULL)::text AS shortfalls
  `;
  if (Number(open[0]?.repayments ?? 0) > 0) {
    throw new BankError(`Loan ${loanId} has a repayment whose ledger outcome is not known yet`, 'bank.ledger_outcome_unknown');
  }
  if (Number(open[0]?.sales ?? 0) > 0 || Number(open[0]?.shortfalls ?? 0) > 0) {
    throw new BankError(`Loan ${loanId} has a sale or an uncovered shortfall still open`, 'bank.loan_liquidating');
  }
  if (amount < 0n) {
    const debt = await deps.outstanding(loanId, tx);
    if (-amount > debt.interest) {
      throw new BankError(
        `Loan ${loanId} owes ${formatAmount(debt.interest)} interest now; a correction cannot take off more`,
        'bank.correction_exceeds_interest',
      );
    }
  }
}

/** The non-locking pre-check, run before the approval is consumed. */
export async function checkCorrection(deps: CorrectionDeps, terms: InterestCorrectionTerms): Promise<void> {
  const { amount } = parseCorrection(terms);
  await assertCorrectable(deps, deps.sql, terms.loanId, amount, false);
}

/**
 * Write one approved correction. Under the loan row lock, which repay's claim also takes, so a repayment either
 * splits against the corrected interest or is pending and refuses the correction. The id is the operation's own
 * business key: the same id with the same terms returns the first row and writes nothing, also when two requests
 * with that id race (the second waits on the lock and finds the first row).
 */
export async function writeCorrection(
  deps: CorrectionDeps,
  terms: InterestCorrectionTerms,
  people: { readonly proposedBy: string; readonly approvedBy: string; readonly approvalId: string },
  now: Date,
): Promise<{ adjustment: InterestAdjustment; replay: boolean }> {
  const { amount, reason } = parseCorrection(terms);
  return transaction(
    deps.sql,
    async (tx) => {
      // The loan row lock first: a second request with this id waits here, then finds the first one's row.
      const locked = await tx<Array<{ id: string }>>`SELECT id FROM bank.loans WHERE id = ${terms.loanId} FOR UPDATE`;
      if (locked.length === 0) throw new BankError(`No loan ${terms.loanId}`, 'bank.loan_not_found');
      const prior = await adjustmentById(tx, terms.adjustmentId);
      if (prior) {
        assertSameCorrection(prior, terms);
        return { adjustment: prior, replay: true };
      }
      await assertCorrectable(deps, tx, terms.loanId, amount, false);
      const rows = await tx<AdjustmentRow[]>`
        INSERT INTO bank.loan_adjustments (id, loan_id, kind, amount, reason, proposed_by, approved_by, approval_id, created_at)
        VALUES (${terms.adjustmentId}, ${terms.loanId}, 'interest_correction', ${formatAmount(amount)}::numeric, ${reason},
                ${people.proposedBy}, ${people.approvedBy}, ${people.approvalId}, ${now})
        ON CONFLICT (id) DO NOTHING
        RETURNING id, loan_id, kind, amount::text AS amount, reason, proposed_by, approved_by, approval_id, created_at
      `;
      if (rows[0]) return { adjustment: toAdjustment(rows[0]), replay: false };
      // The same id written for another loan (whose lock this request did not hold): the first row stands.
      const other = await adjustmentById(tx, terms.adjustmentId);
      if (!other) throw new BankError(`Correction ${terms.adjustmentId} could not be written`, 'bank.correction_conflict');
      assertSameCorrection(other, terms);
      return { adjustment: other, replay: true };
    },
    { isolation: 'read committed', maxAttempts: 1 },
  );
}

export interface InterestRows {
  readonly loanId: string;
  readonly assetId: string;
  /** Accrual days, newest first, at most `INTEREST_ROWS_LISTED`. */
  readonly days: Array<{ date: string; rateBps: number; basis: Amount; interest: Amount }>;
  /** Days older than the listed ones; their interest is in `accrued`. */
  readonly earlierDays: number;
  readonly corrections: Array<{ id: string; at: Date; amount: Amount; reason: string }>;
  /** Every day's interest, every correction, the interest paid by repayments and sales, and what is owed now. */
  readonly accrued: Amount;
  readonly corrected: Amount;
  readonly paid: Amount;
  readonly owed: Amount;
}

export async function readInterestRows(
  sql: Sql,
  loan: { id: string; debtAssetId: string },
  owed: (tx: Sql) => Promise<Amount>,
): Promise<InterestRows> {
  return sql.begin('isolation level repeatable read read only', async (t) => {
    const tx = t as unknown as Sql;
    const [days, totals, corrections, paid, interest] = await Promise.all([
      tx<Array<{ accrual_date: string; rate_bps: number; principal_basis: string; interest_amount: string }>>`
        SELECT accrual_date::text AS accrual_date, rate_bps, principal_basis::text AS principal_basis,
               interest_amount::text AS interest_amount
          FROM bank.loan_interest_accruals WHERE loan_id = ${loan.id}
         ORDER BY accrual_date DESC
         LIMIT ${INTEREST_ROWS_LISTED}
      `,
      tx<Array<{ n: string; v: string }>>`
        SELECT COUNT(*)::text AS n, COALESCE(SUM(interest_amount), 0)::text AS v
          FROM bank.loan_interest_accruals WHERE loan_id = ${loan.id}
      `,
      tx<Array<{ id: string; created_at: Date; amount: string; reason: string }>>`
        SELECT id, created_at, amount::text AS amount, reason
          FROM bank.loan_adjustments WHERE loan_id = ${loan.id} AND kind = 'interest_correction'
         ORDER BY created_at DESC, id ASC
      `,
      tx<Array<{ v: string }>>`
        SELECT ((SELECT COALESCE(SUM(interest_amount), 0) FROM bank.loan_repayments
                  WHERE loan_id = ${loan.id} AND status = 'settled')
              + (SELECT COALESCE(SUM(interest_repaid), 0) FROM bank.loan_liquidations
                  WHERE loan_id = ${loan.id} AND status = 'settled'))::text AS v
      `,
      owed(tx),
    ]);
    const listed = days.map((d) => ({
      date: d.accrual_date,
      rateBps: Number(d.rate_bps),
      basis: parseAmount(d.principal_basis),
      interest: parseAmount(d.interest_amount),
    }));
    const listedCorrections = corrections.map((c) => ({
      id: c.id,
      at: c.created_at,
      amount: parseAmount(c.amount),
      reason: c.reason,
    }));
    return {
      loanId: loan.id,
      assetId: loan.debtAssetId,
      days: listed,
      earlierDays: Number(totals[0]?.n ?? 0) - listed.length,
      corrections: listedCorrections,
      accrued: parseAmount(totals[0]?.v ?? '0'),
      corrected: listedCorrections.reduce((sum, c) => sum + c.amount, 0n),
      paid: parseAmount(paid[0]?.v ?? '0'),
      owed: interest,
    };
  });
}

export type LedgerCheckKind = 'draw' | 'repayment' | 'collateral_lock' | 'collateral_release' | 'liquidation' | 'bad_debt';

export interface LedgerCheckMismatch {
  readonly kind: LedgerCheckKind | 'collateral_balance';
  readonly ref: string;
  /** missing: no booked transaction under that id; key: booked under another key; entries: another account, side or amount. */
  readonly problem: 'missing' | 'key' | 'entries' | 'balance';
  readonly expected: string;
  readonly found: string;
}

export interface LedgerCheck {
  readonly loanId: string;
  /** agrees: every settled row matches its ledger transaction; differs: at least one does not; pending: an outcome is not known yet. */
  readonly status: 'agrees' | 'differs' | 'pending';
  readonly checked: number;
  readonly pending: number;
  readonly collateralHeld: Amount;
  readonly collateralExpected: Amount;
  readonly mismatches: LedgerCheckMismatch[];
  readonly checkedAt: Date;
}

interface CheckedLoan {
  id: string;
  userId: string;
  debtAssetId: string;
  collateralAssetId: string;
  principal: Amount;
  drawLedgerTxId: string | null;
}

/** How many ledger reads the check has in flight at once. */
const CHECK_CONCURRENCY = 8;

/**
 * The per-loan ledger reconciliation. Each settled row is rebuilt with its recipe and compared, leg by leg, with the
 * transaction the ledger booked under the row's tx id. A liquidation rung and its bad-debt post are checked by key
 * (their legs depend on the sale's venue and the insurance fund, which the row does not carry); what a sale took out
 * of the pot still counts in the collateral comparison.
 *
 * The pot is read first and the rows after it, in one snapshot. A move is claimed as a pending row before it posts, so
 * anything the pot already holds is in the snapshot, settled or pending. While any move is pending the pot is not
 * compared (the answer is `pending`), and a pot that changed while the check read it counts as a move in flight too,
 * so a move in flight never reads as a difference.
 */
export async function checkLoanLedger(
  sql: Sql,
  ledger: Pick<LedgerClient, 'balance' | 'getTx'>,
  loan: CheckedLoan,
  now: Date = new Date(),
): Promise<LedgerCheck> {
  const held = (await ledger.balance(loanCollateralAccount(loan.userId, loan.collateralAssetId, loan.id))).amount;
  const { repayments, collateral, liquidations, pending } = await sql.begin('isolation level repeatable read read only', async (t) => {
    const tx = t as unknown as Sql;
    const [repayments, collateral, liquidations, pending] = await Promise.all([
      tx<Array<{ sequence: number; interest_amount: string; principal_amount: string; ledger_tx_id: string | null }>>`
        SELECT sequence, interest_amount::text AS interest_amount, principal_amount::text AS principal_amount, ledger_tx_id
          FROM bank.loan_repayments WHERE loan_id = ${loan.id} AND status = 'settled' ORDER BY sequence
      `,
      tx<Array<{ sequence: number; direction: string; amount: string; ledger_tx_id: string | null }>>`
        SELECT sequence, direction, amount::text AS amount, ledger_tx_id
          FROM bank.loan_collateral_events WHERE loan_id = ${loan.id} AND status = 'settled' ORDER BY sequence
      `,
      tx<Array<{ tranche: number; collateral_sold: string; ledger_tx_id: string | null; bad_debt_ledger_tx_id: string | null }>>`
        SELECT tranche, collateral_sold::text AS collateral_sold, ledger_tx_id, bad_debt_ledger_tx_id
          FROM bank.loan_liquidations WHERE loan_id = ${loan.id} AND status = 'settled' ORDER BY tranche
      `,
      tx<Array<{ n: string }>>`
        SELECT ((SELECT COUNT(*) FROM bank.loan_repayments WHERE loan_id = ${loan.id} AND status = 'pending')
              + (SELECT COUNT(*) FROM bank.loan_collateral_events WHERE loan_id = ${loan.id} AND status = 'pending')
              + (SELECT COUNT(*) FROM bank.loan_liquidations WHERE loan_id = ${loan.id} AND status = 'pending'))::text AS n
      `,
    ]);
    return { repayments, collateral, liquidations, pending: Number(pending[0]?.n ?? 0) };
  });
  // Read again: a move that claimed, posted and settled between the first read and the snapshot changed the pot. It
  // is then in flight for this check, never a difference.
  const moved = (await ledger.balance(loanCollateralAccount(loan.userId, loan.collateralAssetId, loan.id))).amount !== held;

  const accountIds = new Map<string, Promise<string>>();
  const accountId = (ref: AccountRef) => {
    const key = JSON.stringify(ref);
    let id = accountIds.get(key);
    if (!id) {
      id = ledger.balance(ref).then((b) => b.accountId);
      accountIds.set(key, id);
    }
    return id;
  };
  const legs = async (request: PostRequest) =>
    (await Promise.all(request.entries.map(async (e) => `${await accountId(e.account)} ${e.direction} ${formatAmount(e.amount)}`))).sort();

  interface Check {
    kind: LedgerCheckKind;
    ref: string;
    txId: string | null;
    request: PostRequest;
    byKeyOnly: boolean;
  }
  const checks: Check[] = [];
  const keyOnly = (idempotencyKey: string): PostRequest => ({ idempotencyKey, module: 'bank', reason: '', entries: [] });

  if (loan.drawLedgerTxId) {
    checks.push({
      kind: 'draw',
      ref: loan.id,
      txId: loan.drawLedgerTxId,
      request: recipes.loanDraw({ loanId: loan.id, userId: loan.userId, debtAssetId: loan.debtAssetId, principal: loan.principal }),
      byKeyOnly: false,
    });
  }
  for (const r of repayments) {
    checks.push({
      kind: 'repayment',
      ref: String(r.sequence),
      txId: r.ledger_tx_id,
      request: recipes.loanRepay({
        loanId: loan.id,
        userId: loan.userId,
        debtAssetId: loan.debtAssetId,
        principal: parseAmount(r.principal_amount),
        interest: parseAmount(r.interest_amount),
        sequence: Number(r.sequence),
      }),
      byKeyOnly: false,
    });
  }
  let locked = 0n;
  let released = 0n;
  for (const c of collateral) {
    const input = {
      loanId: loan.id,
      userId: loan.userId,
      collateralAssetId: loan.collateralAssetId,
      amount: parseAmount(c.amount),
      sequence: Number(c.sequence),
    };
    const release = c.direction === 'release';
    if (release) released += input.amount;
    else locked += input.amount;
    checks.push({
      kind: release ? 'collateral_release' : 'collateral_lock',
      ref: String(c.sequence),
      txId: c.ledger_tx_id,
      request: release ? recipes.loanCollateralRelease(input) : recipes.loanCollateralLock(input),
      byKeyOnly: false,
    });
  }
  let sold = 0n;
  for (const q of liquidations) {
    sold += parseAmount(q.collateral_sold);
    checks.push({
      kind: 'liquidation',
      ref: String(q.tranche),
      txId: q.ledger_tx_id,
      request: keyOnly(`bank.loan.liquidate:${loan.id}:${q.tranche}`),
      byKeyOnly: true,
    });
    if (q.bad_debt_ledger_tx_id) {
      checks.push({
        kind: 'bad_debt',
        ref: String(q.tranche),
        txId: q.bad_debt_ledger_tx_id,
        request: keyOnly(`bank.loan.baddebt:${loan.id}`),
        byKeyOnly: true,
      });
    }
  }

  const compare = async ({ kind, ref, txId, request, byKeyOnly }: Check): Promise<LedgerCheckMismatch | null> => {
    const tx = txId ? await ledger.getTx(txId) : null;
    if (!tx) return { kind, ref, problem: 'missing', expected: request.idempotencyKey, found: txId ?? '' };
    if (tx.idempotencyKey !== request.idempotencyKey) {
      return { kind, ref, problem: 'key', expected: request.idempotencyKey, found: tx.idempotencyKey };
    }
    if (byKeyOnly) return null;
    const want = await legs(request);
    const got = tx.entries.map((e) => `${e.accountId} ${e.direction} ${formatAmount(e.amount)}`).sort();
    return want.join('|') === got.join('|') ? null : { kind, ref, problem: 'entries', expected: want.join('; '), found: got.join('; ') };
  };
  const mismatches: LedgerCheckMismatch[] = [];
  for (let at = 0; at < checks.length; at += CHECK_CONCURRENCY) {
    const found = await Promise.all(checks.slice(at, at + CHECK_CONCURRENCY).map(compare));
    for (const m of found) if (m) mismatches.push(m);
  }

  const expectedHeld = locked - released - sold;
  const inFlight = pending > 0 || moved;
  if (!inFlight && held !== expectedHeld) {
    mismatches.push({
      kind: 'collateral_balance',
      ref: loan.id,
      problem: 'balance',
      expected: formatAmount(expectedHeld),
      found: formatAmount(held),
    });
  }
  return {
    loanId: loan.id,
    status: mismatches.length > 0 ? 'differs' : inFlight ? 'pending' : 'agrees',
    checked: checks.length,
    pending,
    collateralHeld: held,
    collateralExpected: expectedHeld,
    mismatches,
    checkedAt: now,
  };
}
