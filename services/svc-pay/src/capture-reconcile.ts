import type { Sql } from 'postgres';
import { merchantClearing, parseAmount, railBoundary, type Amount, type LedgerClient, type LedgerTx } from '@intafaced/ledger-client';
import { writeAudit } from './control/audit.js';

/**
 * Payments left `authorized` after the ledger capture key already exists:
 * the post committed in svc-ledger and the status update in this service did not.
 *
 * One bounded pass. It does not call `ledger.post`. Completion is the same
 * function a normal capture runs after its post (`finishBookedCapture`).
 * Two runners: a session try-lock around the pass (a busy lock returns, it does
 * not wait), and the merchant row then the payment row inside each payment's
 * transaction (the capture lock order). One payment's failure is counted and
 * the pass continues. A cursor `(created_at, id)` lets the caller walk past a
 * healthy or mismatched head; a short page returns no cursor so the next run
 * starts again.
 *
 * The HTTP ledger client returns `meta: {}` from `getTx`. Account ids and
 * directions are what prove the booked legs are this merchant's clearing debit
 * and this rail's boundary credit. A missing rail reference is a mismatch only
 * when those accounts cannot be read.
 *
 * `off` refuses and reads nothing. A blank limit refuses — this file does not
 * pick a batch size.
 */

export type CaptureReconcileMode = 'off' | 'required';

export type CaptureReconcileErrorCode =
  'pay.capture_reconcile_disabled' | 'pay.capture_reconcile_batch_limit_unset' | 'pay.validation_failed';

export class CaptureReconcileError extends Error {
  constructor(
    message: string,
    readonly code: CaptureReconcileErrorCode,
  ) {
    super(message);
    this.name = 'CaptureReconcileError';
  }
}

/** Resume after this row. `createdAt` is the UTC timestamp the pass returned, microseconds included. */
export interface CaptureReconcileCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface CaptureReconcileInput {
  readonly limit?: number;
  readonly cursor?: CaptureReconcileCursor;
}

export interface CaptureReconcileReport {
  readonly busy: boolean;
  readonly examined: number;
  readonly reconciled: number;
  readonly leftAuthorized: number;
  readonly alreadyCaptured: number;
  readonly mismatched: number;
  readonly failed: number;
  /** Last row of a full page. Null when the page was short: the caller starts over. */
  readonly nextCursor: CaptureReconcileCursor | null;
}

/** Payment columns the capture completion path already reads. */
export interface AuthorizedPaymentRow {
  id: string;
  merchant_id: string;
  profile_id: string | null;
  amount: string;
  currency: string;
  method: string;
  rail_adapter: string;
  rail_ref: string | null;
  status: string;
  created_at: Date;
}

export interface BookedCaptureCompletion {
  readonly ledgerTxId: string;
  readonly amount: Amount;
  readonly railRef: string;
  /**
   * When the ledger booked the capture. The reconciler passes it into the
   * intake guard so the cap period is that instant, not the run.
   */
  readonly postedAt?: Date;
}

/** Account ids `balance(railBoundary)` and `balance(merchantClearing)` returned. Empty means the book has no id yet. */
export interface CaptureAccountIds {
  readonly railBoundaryAccountId: string;
  readonly merchantClearingAccountId: string;
}

export interface CaptureReconcileDeps {
  readonly sql: Sql;
  readonly ledger: Pick<LedgerClient, 'getTxByKey' | 'balance'>;
  readonly lockMerchant: (tx: Sql, merchantId: string) => Promise<void>;
  readonly complete: (tx: Sql, row: AuthorizedPaymentRow, booked: BookedCaptureCompletion) => Promise<{ status: string }>;
  readonly onReconciled?: (view: { status: string }) => void;
}

export interface CaptureReconcileLog {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

const noopLog: CaptureReconcileLog = { warn: () => undefined };
let reconcileLog: CaptureReconcileLog = noopLog;

/** Wired from the service log at boot. A throw here must not stop the pass. */
export function setCaptureReconcileLogger(log: CaptureReconcileLog): void {
  reconcileLog = log;
}

export function resetCaptureReconcileLoggerForTests(): void {
  reconcileLog = noopLog;
}

function safeWarn(fields: Record<string, unknown>, message: string): void {
  try {
    reconcileLog.warn(fields, message);
  } catch {
    // A broken logger must not stop the pass or undo a decision already committed.
  }
}

/** Session advisory lock for this job. Not a commercial magnitude. */
export const CAPTURE_RECONCILE_LOCK_A = 7411;
export const CAPTURE_RECONCILE_LOCK_B = 2075;

/**
 * A reserved postgres.js connection can run `BEGIN` (the driver allows it
 * there, and does not attach `begin` to that handle). The row lock is the
 * total order, so read committed queues instead of aborting the pass.
 */
async function inReservedTransaction<T>(conn: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  await conn`BEGIN ISOLATION LEVEL READ COMMITTED`;
  try {
    const result = await fn(conn);
    await conn`COMMIT`;
    return result;
  } catch (error) {
    await conn`ROLLBACK`.catch(() => undefined);
    throw error;
  }
}

/** The ceiling the other internal jobs already use. A request past it is refused, not shrunk. */
const MAX_BATCH = 500;

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;
const PAYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function captureIdempotencyKey(paymentId: string): string {
  return `payment.capture:${paymentId.toLowerCase()}`;
}

export function captureAccountsVerifiable(accounts: CaptureAccountIds): boolean {
  return accounts.railBoundaryAccountId !== '' && accounts.merchantClearingAccountId !== '';
}

/**
 * The two legs `recipes.paymentCapture` books: credit the rail boundary, debit merchant clearing.
 * Any other account or direction is a different movement under this payment's key.
 */
function entriesOnCaptureAccounts(entries: LedgerTx['entries'], accounts: CaptureAccountIds): boolean {
  if (entries.length !== 2) return false;
  let credit = false;
  let debit = false;
  for (const entry of entries) {
    if (entry.direction === 'credit' && entry.accountId === accounts.railBoundaryAccountId) {
      if (credit) return false;
      credit = true;
    } else if (entry.direction === 'debit' && entry.accountId === accounts.merchantClearingAccountId) {
      if (debit) return false;
      debit = true;
    } else {
      return false;
    }
  }
  return credit && debit;
}

/**
 * The booked capture is this payment's, for this amount, and either the rail
 * and clearing accounts match or (only when those ids cannot be read) the rail
 * reference is present on both sides and agrees.
 */
export function matchBookedCapture(
  row: AuthorizedPaymentRow,
  booked: LedgerTx,
  accounts: CaptureAccountIds,
): BookedCaptureCompletion | null {
  const key = captureIdempotencyKey(row.id);
  if (booked.idempotencyKey !== key || booked.module !== 'pay' || booked.reason !== 'payment.captured') return null;
  if (booked.entries.length === 0) return null;
  let authorized: Amount;
  try {
    authorized = parseAmount(row.amount);
  } catch {
    return null;
  }
  if (authorized <= 0n) return null;
  for (const entry of booked.entries) {
    if (entry.assetId !== row.currency || entry.amount !== authorized) return null;
  }
  const metaPayment = booked.meta?.paymentId;
  if (typeof metaPayment === 'string' && metaPayment.toLowerCase() !== row.id.toLowerCase()) return null;
  const metaRail = booked.meta?.railRef;
  if (typeof metaRail === 'string' && row.rail_ref && metaRail !== row.rail_ref) return null;

  const postedAt = booked.postedAt;
  if (!(postedAt instanceof Date) || !Number.isFinite(postedAt.getTime())) return null;

  const verifiable = captureAccountsVerifiable(accounts);
  if (verifiable) {
    if (!entriesOnCaptureAccounts(booked.entries, accounts)) return null;
  } else if (typeof metaRail !== 'string' || !row.rail_ref || metaRail !== row.rail_ref) {
    return null;
  }

  const railRef = row.rail_ref ?? (typeof metaRail === 'string' ? metaRail : '');
  if (!railRef && !verifiable) return null;
  return { ledgerTxId: booked.id, amount: authorized, railRef, postedAt };
}

async function expectedCaptureAccounts(
  ledger: Pick<LedgerClient, 'balance'>,
  row: { merchant_id: string; currency: string; rail_adapter: string },
): Promise<CaptureAccountIds> {
  const boundary = await ledger.balance(railBoundary(row.rail_adapter, row.currency));
  const clearing = await ledger.balance(merchantClearing(row.merchant_id, row.currency));
  return { railBoundaryAccountId: boundary.accountId, merchantClearingAccountId: clearing.accountId };
}

function assertBatchLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new CaptureReconcileError(
      'capture reconcile batch size is unset. Blank refuses — never a default. Pass a positive integer (50 is allowed if explicit).',
      'pay.capture_reconcile_batch_limit_unset',
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new CaptureReconcileError(`limit must be an integer 1..${MAX_BATCH}, got ${limit}`, 'pay.validation_failed');
  }
  return limit;
}

function assertCursor(cursor: CaptureReconcileCursor | undefined): CaptureReconcileCursor | null {
  if (cursor === undefined) return null;
  // `Date.parse` only keeps milliseconds. The cursor string keeps the microseconds
  // Postgres stored, and that string is what the next query casts.
  const millisecond = cursor.createdAt.replace(/(\.\d{3})\d+/, '$1');
  if (typeof cursor.createdAt !== 'string' || !CURSOR_AT.test(cursor.createdAt) || !Number.isFinite(Date.parse(millisecond))) {
    throw new CaptureReconcileError('cursor.createdAt is not an instant', 'pay.validation_failed');
  }
  if (typeof cursor.id !== 'string' || !PAYMENT_ID.test(cursor.id)) {
    throw new CaptureReconcileError('cursor.id is not a payment id', 'pay.validation_failed');
  }
  return { createdAt: cursor.createdAt, id: cursor.id };
}

interface Candidate {
  id: string;
  merchant_id: string;
  currency: string;
  rail_adapter: string;
  cursor_at: string;
}

type OneOutcome =
  | { kind: 'left' }
  | { kind: 'already' }
  | { kind: 'reconciled'; view: { status: string } }
  | { kind: 'mismatch'; paymentId: string; merchantId: string; merchantStatus: string };

const BUSY: CaptureReconcileReport = {
  busy: true,
  examined: 0,
  reconciled: 0,
  leftAuthorized: 0,
  alreadyCaptured: 0,
  mismatched: 0,
  failed: 0,
  nextCursor: null,
};

export async function runCaptureReconcile(
  deps: CaptureReconcileDeps,
  input: CaptureReconcileInput,
  mode: CaptureReconcileMode,
): Promise<CaptureReconcileReport> {
  if (mode !== 'required') {
    throw new CaptureReconcileError(
      'PAY_CAPTURE_RECONCILE is off. The reconciler moves nothing until an owner sets it to required.',
      'pay.capture_reconcile_disabled',
    );
  }
  const limit = assertBatchLimit(input.limit);
  const cursor = assertCursor(input.cursor);

  const conn = await deps.sql.reserve();
  let examined = 0;
  let reconciled = 0;
  let leftAuthorized = 0;
  let alreadyCaptured = 0;
  let mismatched = 0;
  let failed = 0;
  let nextCursor: CaptureReconcileCursor | null = null;
  try {
    const [lock] = await conn<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${CAPTURE_RECONCILE_LOCK_A}, ${CAPTURE_RECONCILE_LOCK_B}) AS locked
    `;
    if (lock?.locked !== true) return BUSY;
    try {
      const candidates = cursor
        ? await conn<Candidate[]>`
            SELECT id, merchant_id, currency, rail_adapter,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
              FROM pay.payments
             WHERE status = 'authorized'
               AND (created_at, id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)
             ORDER BY created_at, id
             LIMIT ${limit}
          `
        : await conn<Candidate[]>`
            SELECT id, merchant_id, currency, rail_adapter,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
              FROM pay.payments
             WHERE status = 'authorized'
             ORDER BY created_at, id
             LIMIT ${limit}
          `;
      examined = candidates.length;
      if (examined === limit) {
        const last = candidates[candidates.length - 1]!;
        nextCursor = { createdAt: last.cursor_at, id: last.id };
      }
      for (const candidate of candidates) {
        try {
          const outcome = await reconcileOne(deps, conn, candidate);
          if (outcome.kind === 'left') leftAuthorized += 1;
          else if (outcome.kind === 'already') alreadyCaptured += 1;
          else if (outcome.kind === 'mismatch') {
            mismatched += 1;
            safeWarn(
              {
                event: 'payment.capture_reconcile_mismatch',
                paymentId: outcome.paymentId,
                merchantId: outcome.merchantId,
                merchantStatus: outcome.merchantStatus,
              },
              'authorized payment capture key does not match this payment',
            );
          } else {
            reconciled += 1;
            try {
              deps.onReconciled?.(outcome.view);
            } catch (error) {
              safeWarn(
                {
                  event: 'payment.capture_reconcile_notice_failed',
                  paymentId: candidate.id,
                  err: error instanceof Error ? error.message : 'capture notice failed',
                },
                'capture reconcile notice failed after the payment was captured',
              );
            }
          }
        } catch (error) {
          failed += 1;
          safeWarn(
            {
              event: 'payment.capture_reconcile_failed',
              paymentId: candidate.id,
              err: error instanceof Error ? error.message : 'capture reconcile failed',
            },
            'capture reconcile left the payment authorized',
          );
        }
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(${CAPTURE_RECONCILE_LOCK_A}, ${CAPTURE_RECONCILE_LOCK_B})`;
    }
  } finally {
    conn.release();
  }

  return { busy: false, examined, reconciled, leftAuthorized, alreadyCaptured, mismatched, failed, nextCursor };
}

async function reconcileOne(deps: CaptureReconcileDeps, conn: Sql, candidate: Candidate): Promise<OneOutcome> {
  const key = captureIdempotencyKey(candidate.id);
  const booked = await deps.ledger.getTxByKey(key);
  if (!booked) return { kind: 'left' };
  const accounts = await expectedCaptureAccounts(deps.ledger, candidate);
  const db = conn as unknown as Sql;
  return inReservedTransaction(db, async (tx) => {
    const peek = await tx<Array<{ merchant_id: string }>>`
      SELECT merchant_id FROM pay.payments WHERE id = ${candidate.id}
    `;
    const merchantId = peek[0]?.merchant_id;
    if (!merchantId) throw new Error(`Payment ${candidate.id} disappeared during reconcile`);
    // Merchant row, then payment row. The same order capture uses, so the two cannot deadlock.
    await deps.lockMerchant(tx, merchantId);
    const locked = await tx<AuthorizedPaymentRow[]>`
      SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
        FROM pay.payments WHERE id = ${candidate.id} FOR UPDATE
    `;
    const row = locked[0];
    if (!row) throw new Error(`Payment ${candidate.id} disappeared during reconcile`);
    if (row.status !== 'authorized') return { kind: 'already' };
    const sameIdentity =
      row.merchant_id === candidate.merchant_id && row.currency === candidate.currency && row.rail_adapter === candidate.rail_adapter;
    const ids = sameIdentity ? accounts : await expectedCaptureAccounts(deps.ledger, row);
    const match = matchBookedCapture(row, booked, ids);
    if (!match) {
      const statusRows = await tx<Array<{ status: string }>>`
        SELECT status FROM pay.merchants WHERE id = ${row.merchant_id}
      `;
      const merchantStatus = statusRows[0]?.status ?? 'missing';
      await writeAudit(tx, {
        scope: 'merchant',
        scopeId: row.merchant_id,
        merchantId: row.merchant_id,
        kind: 'payment.capture_reconcile_mismatch',
        outcome: 'mismatch',
        actorId: 'system:capture_reconcile',
        reason: 'booked capture does not match this authorization',
        before: { status: merchantStatus },
        after: { paymentId: row.id, ledgerTxId: booked.id, idempotencyKey: key },
      });
      return { kind: 'mismatch', paymentId: row.id, merchantId: row.merchant_id, merchantStatus };
    }
    const view = await deps.complete(tx, row, match);
    await writeAudit(tx, {
      scope: 'merchant',
      scopeId: row.merchant_id,
      merchantId: row.merchant_id,
      kind: 'payment.capture_reconciled',
      outcome: 'reconciled',
      actorId: 'system:capture_reconcile',
      reason: 'authorized payment already had a ledger capture key',
      before: { status: 'authorized' },
      after: { paymentId: row.id, ledgerTxId: match.ledgerTxId, idempotencyKey: key },
    });
    return { kind: 'reconciled', view };
  });
}
