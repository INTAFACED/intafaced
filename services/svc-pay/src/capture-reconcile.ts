import type { Sql } from 'postgres';
import { parseAmount, type Amount, type LedgerClient, type LedgerTx } from '@intafaced/ledger-client';
import { writeAudit } from './control/audit.js';

/**
 * Payments left `authorized` after the ledger capture key already exists:
 * the post committed in svc-ledger and the status update in this service did not.
 *
 * One bounded pass. It does not call `ledger.post`. Completion is the same
 * function a normal capture runs after its post (`finishBookedCapture`).
 * Two runners: a session advisory lock around the pass, and the merchant row
 * then the payment row inside each payment's transaction (the capture lock order).
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

export interface CaptureReconcileReport {
  readonly examined: number;
  readonly reconciled: number;
  readonly leftAuthorized: number;
  readonly alreadyCaptured: number;
  readonly mismatched: number;
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
}

export interface CaptureReconcileDeps {
  readonly sql: Sql;
  readonly ledger: Pick<LedgerClient, 'getTxByKey'>;
  readonly lockMerchant: (tx: Sql, merchantId: string) => Promise<void>;
  readonly complete: (tx: Sql, row: AuthorizedPaymentRow, booked: BookedCaptureCompletion) => Promise<{ status: string }>;
  readonly onReconciled?: (view: { status: string }) => void;
}

/** Session advisory lock for this job. Not a commercial magnitude. */
const LOCK_A = 7411;
const LOCK_B = 2075;

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

export function captureIdempotencyKey(paymentId: string): string {
  return `payment.capture:${paymentId.toLowerCase()}`;
}

/**
 * The booked capture is this payment's, for this amount and rail reference.
 * Anything else is left `authorized`: completing it would record a capture
 * the book does not show.
 */
export function matchBookedCapture(row: AuthorizedPaymentRow, booked: LedgerTx): BookedCaptureCompletion | null {
  const key = captureIdempotencyKey(row.id);
  if (booked.idempotencyKey !== key || booked.module !== 'pay' || booked.reason !== 'payment.captured') return null;
  if (!row.rail_ref) return null;
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
  if (typeof metaRail === 'string' && metaRail !== row.rail_ref) return null;
  return { ledgerTxId: booked.id, amount: authorized, railRef: row.rail_ref };
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

export async function runCaptureReconcile(
  deps: CaptureReconcileDeps,
  input: { limit?: number },
  mode: CaptureReconcileMode,
): Promise<CaptureReconcileReport> {
  if (mode !== 'required') {
    throw new CaptureReconcileError(
      'PAY_CAPTURE_RECONCILE is off. The reconciler moves nothing until an owner sets it to required.',
      'pay.capture_reconcile_disabled',
    );
  }
  const limit = assertBatchLimit(input.limit);

  const conn = await deps.sql.reserve();
  let examined = 0;
  let reconciled = 0;
  let leftAuthorized = 0;
  let alreadyCaptured = 0;
  let mismatched = 0;
  try {
    await conn`SELECT pg_advisory_lock(${LOCK_A}, ${LOCK_B})`;
    try {
      const candidates = await conn<Array<{ id: string }>>`
        SELECT id FROM pay.payments
         WHERE status = 'authorized'
         ORDER BY created_at, id
         LIMIT ${limit}
      `;
      examined = candidates.length;
      for (const candidate of candidates) {
        const key = captureIdempotencyKey(candidate.id);
        const booked = await deps.ledger.getTxByKey(key);
        if (!booked) {
          leftAuthorized += 1;
          continue;
        }
        const db = conn as unknown as Sql;
        const outcome = await inReservedTransaction(db, async (tx) => {
          const peek = await tx<Array<{ merchant_id: string }>>`
            SELECT merchant_id FROM pay.payments WHERE id = ${candidate.id}
          `;
          const merchantId = peek[0]?.merchant_id;
          if (!merchantId) return 'missing' as const;
          // Merchant row, then payment row. The same order capture uses, so the two cannot deadlock.
          await deps.lockMerchant(tx, merchantId);
          const locked = await tx<AuthorizedPaymentRow[]>`
            SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
              FROM pay.payments WHERE id = ${candidate.id} FOR UPDATE
          `;
          const row = locked[0];
          if (!row) return 'missing' as const;
          if (row.status !== 'authorized') return 'already' as const;
          const match = matchBookedCapture(row, booked);
          if (!match) return 'mismatch' as const;
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
          return { view };
        });
        if (outcome === 'missing') {
          throw new CaptureReconcileError(`Payment ${candidate.id} disappeared during reconcile`, 'pay.validation_failed');
        }
        if (outcome === 'already') {
          alreadyCaptured += 1;
          continue;
        }
        if (outcome === 'mismatch') {
          mismatched += 1;
          continue;
        }
        reconciled += 1;
        deps.onReconciled?.(outcome.view);
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(${LOCK_A}, ${LOCK_B})`;
    }
  } finally {
    conn.release();
  }

  return { examined, reconciled, leftAuthorized, alreadyCaptured, mismatched };
}
