import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { PayGuardRefusal, type PartialPayGuards } from '../seams/guards.js';
import { PayError } from '../payment-service/internal.js';
import type { PaymentView } from '../payment-service.js';

/**
 * J-merchant-06: the refund controls around the one refund door (`PayService.refund`, which posts through the
 * ledger-client refund recipe). Nothing here posts to the ledger or calls a rail; every refund that runs goes through
 * that door under a business key, so the ledger's idempotency and the payment's event log stay the single record.
 *
 * - The owner's approval rule (per asset): a refund above the threshold waits for a second person. No rule means none
 *   was asked for; nothing is defaulted.
 * - Refund requests: a refund that waits (queued) with nothing posted, bound to one payment, amount and refund key. The
 *   checker (not the maker) approves it under their own confirmation, and then exactly that refund runs, once.
 * - The guard on the refund door: above the rule, a refund runs only for an approved request with the same payment,
 *   key and amount, whoever calls the door (portal, public API, bulk).
 * - Bulk refunds: one row per payment, each its own refund keyed by batch and row, so a batch run again refunds nothing
 *   twice; the report names each row's outcome.
 */

export type RefundRequestStatus = 'queued' | 'approved' | 'refunded' | 'failed' | 'rejected' | 'cancelled' | 'voided';

export interface RefundRule {
  merchantId: string;
  assetId: string;
  threshold: string;
  setBy: string;
  setAt: Date;
}

export interface RefundRequest {
  id: string;
  merchantId: string;
  paymentId: string;
  assetId: string;
  amount: string;
  refundId: string;
  status: RefundRequestStatus;
  makerUserId: string;
  checkerUserId: string | null;
  checkerReason: string | null;
  failureCode: string | null;
  voidReason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  closedAt: Date | null;
}

export interface RefundBatchRow {
  row: number;
  paymentId: string;
  amount: string | null;
  refundId: string;
  outcome: 'pending' | 'refunded' | 'refused' | 'unknown';
  refusalCode: string | null;
}

/** What the refund door and a payment read look like from here. */
export interface RefundDoor {
  getPayment(paymentId: string): Promise<PaymentView>;
  refund(paymentId: string, amount: Amount, options: { refundId: string }): Promise<PaymentView>;
}

/** Most rows one bulk refund may carry (M-payments-core-04). */
export const BULK_REFUND_MAX_ROWS = 500;

type RequestRow = {
  id: string;
  merchant_id: string;
  payment_id: string;
  asset_code: string;
  amount: string;
  refund_id: string;
  status: RefundRequestStatus;
  maker_user_id: string;
  checker_user_id: string | null;
  checker_reason: string | null;
  failure_code: string | null;
  void_reason: string | null;
  created_at: Date;
  decided_at: Date | null;
  closed_at: Date | null;
};

const toRequest = (r: RequestRow): RefundRequest => ({
  id: r.id,
  merchantId: r.merchant_id,
  paymentId: r.payment_id,
  assetId: r.asset_code,
  amount: formatAmount(parseAmount(r.amount)),
  refundId: r.refund_id,
  status: r.status,
  makerUserId: r.maker_user_id,
  checkerUserId: r.checker_user_id,
  checkerReason: r.checker_reason,
  failureCode: r.failure_code,
  voidReason: r.void_reason,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  closedAt: r.closed_at,
});

const REQUEST_COLUMNS = `id, merchant_id, payment_id, asset_code, amount::text AS amount, refund_id, status, maker_user_id, checker_user_id,
  checker_reason, failure_code, void_reason, created_at, decided_at, closed_at`;

/** A refusal the router maps by its code. */
const closed = (r: { id: string; status: string }) =>
  new PayError(`Refund request ${r.id} is ${r.status}; only a queued request can be changed`, 'pay.refund_request_closed', {
    status: r.status,
  });

export class RefundControl {
  constructor(
    private readonly sql: Sql,
    private readonly door: RefundDoor,
  ) {}

  // ── the owner's rule ────────────────────────────────────────────────────────────────────────────────────────────

  async rule(merchantId: string, assetId: string): Promise<RefundRule | null> {
    const rows = await this.sql<Array<{ threshold: string; set_by: string; set_at: Date }>>`
      SELECT threshold::text AS threshold, set_by, set_at FROM pay.refund_approval_rules
       WHERE merchant_id = ${merchantId}::uuid AND asset_code = ${assetId}
    `;
    const r = rows[0];
    return r ? { merchantId, assetId, threshold: formatAmount(parseAmount(r.threshold)), setBy: r.set_by, setAt: r.set_at } : null;
  }

  /**
   * Sets the rule, or clears it with `null`. Every change is kept, append-only. Loosening it (clearing it or raising the
   * threshold) is refused while any refund on this business and asset waits for approval, so a rule is never lowered to
   * let a queued refund through without its checker.
   */
  async setRule(merchantId: string, assetId: string, threshold: Amount | null, userId: string): Promise<RefundRule | null> {
    if (threshold !== null && threshold <= 0n) throw new PayError('A refund approval threshold must be above zero', 'pay.invalid_amount');
    await transaction(this.sql, async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id = ${merchantId}::uuid FOR UPDATE`;
      const current = await tx<Array<{ threshold: string }>>`
        SELECT threshold::text AS threshold FROM pay.refund_approval_rules WHERE merchant_id = ${merchantId}::uuid AND asset_code = ${assetId}
      `;
      const old = current[0] ? parseAmount(current[0].threshold) : null;
      const loosens = old !== null && (threshold === null || threshold > old);
      if (loosens) {
        const waiting = await tx<Array<{ id: string }>>`
          SELECT id FROM pay.refund_requests
           WHERE merchant_id = ${merchantId}::uuid AND asset_code = ${assetId} AND status IN ('queued', 'approved') LIMIT 1
        `;
        if (waiting[0]) {
          throw new PayError(
            'A refund is waiting for approval; the rule cannot be loosened until it is decided',
            'pay.refund_rule_change_blocked',
            {
              requestId: waiting[0].id,
            },
          );
        }
      }
      if (threshold === null) {
        await tx`DELETE FROM pay.refund_approval_rules WHERE merchant_id = ${merchantId}::uuid AND asset_code = ${assetId}`;
      } else {
        await tx`
          INSERT INTO pay.refund_approval_rules (merchant_id, asset_code, threshold, set_by)
          VALUES (${merchantId}::uuid, ${assetId}, ${formatAmount(threshold)}, ${userId})
          ON CONFLICT (merchant_id, asset_code) DO UPDATE SET threshold = EXCLUDED.threshold, set_by = EXCLUDED.set_by, set_at = now()
        `;
      }
      await tx`
        INSERT INTO pay.refund_approval_rule_changes (merchant_id, asset_code, old_threshold, new_threshold, changed_by)
        VALUES (${merchantId}::uuid, ${assetId}, ${old === null ? null : formatAmount(old)}, ${threshold === null ? null : formatAmount(threshold)}, ${userId})
      `;
    });
    return this.rule(merchantId, assetId);
  }

  /** Whether a refund of `amount` on this merchant and asset waits for a second person. */
  async needsApproval(merchantId: string, assetId: string, amount: Amount, paymentId?: string): Promise<RefundRule | null> {
    const rule = await this.rule(merchantId, assetId);
    if (!rule) return null;
    // Counted on the payment's whole refunds, so splitting one refund into several smaller ones never gets round it.
    const before = paymentId ? await refundedSoFar(this.sql, paymentId) : 0n;
    return before + amount > parseAmount(rule.threshold) ? rule : null;
  }

  // ── queued requests ──────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Queues a refund for approval. Nothing is posted. The same key and amount again answers the same request; the same
   * key with another amount is refused. A live request on the payment for another key is voided first (the maker
   * changed the amount), so an approval never runs for contents the checker did not see.
   */
  async request(input: {
    merchantId: string;
    paymentId: string;
    amount: Amount;
    refundId: string;
    makerUserId: string;
  }): Promise<RefundRequest> {
    const payment = await this.door.getPayment(input.paymentId);
    if (payment.merchantId !== input.merchantId) throw new PayError(`Payment ${input.paymentId} not found`, 'pay.payment_not_found');
    if (input.amount <= 0n) throw new PayError('Refund amount must be positive', 'pay.invalid_amount');
    const left = payment.capturedAmount - payment.refundedAmount;
    if (input.amount > left) {
      throw new PayError(
        `Refund of ${formatAmount(input.amount)} is more than the ${formatAmount(left)} left`,
        'pay.refund_exceeds_captured',
        {
          refundable: formatAmount(left),
        },
      );
    }
    if (payment.status === 'disputed') throw new PayError(`Payment ${payment.id} has an open dispute`, 'pay.refund_open_dispute');
    return transaction(this.sql, async (tx) => {
      // One request at a time per payment: the payment row lock orders concurrent asks.
      await tx`SELECT id FROM pay.payments WHERE id = ${input.paymentId}::uuid FOR UPDATE`;
      const same = await tx<RequestRow[]>`
        SELECT ${tx.unsafe(REQUEST_COLUMNS)} FROM pay.refund_requests
         WHERE payment_id = ${input.paymentId}::uuid AND refund_id = ${input.refundId}
      `;
      if (same[0]) {
        if (parseAmount(same[0].amount) !== input.amount) {
          throw new PayError(`Refund id ${input.refundId} was asked for ${same[0].amount}`, 'pay.refund_id_conflict', {
            asked: same[0].amount,
          });
        }
        return toRequest(same[0]);
      }
      // An approved request is being sent (or its outcome is being checked): nothing new is asked until it closes, so
      // its retry under the same key is never refused and the money it holds is never stranded.
      const sending = await tx<Array<{ id: string }>>`
        SELECT id FROM pay.refund_requests WHERE payment_id = ${input.paymentId}::uuid AND status = 'approved'
      `;
      if (sending[0]) {
        throw new PayError(`Refund request ${sending[0].id} on this payment is being sent; wait for it`, 'pay.refund_in_flight', {
          requestId: sending[0].id,
        });
      }
      await tx`
        UPDATE pay.refund_requests SET status = 'voided', void_reason = 'amount_changed', closed_at = now()
         WHERE payment_id = ${input.paymentId}::uuid AND status = 'queued'
      `;
      const rows = await tx<RequestRow[]>`
        INSERT INTO pay.refund_requests (merchant_id, payment_id, asset_code, amount, refund_id, maker_user_id)
        VALUES (${input.merchantId}::uuid, ${input.paymentId}::uuid, ${payment.assetId}, ${formatAmount(input.amount)}, ${input.refundId}, ${input.makerUserId})
        RETURNING ${tx.unsafe(REQUEST_COLUMNS)}
      `;
      return toRequest(rows[0]!);
    });
  }

  async get(requestId: string): Promise<RefundRequest> {
    const rows = await this.sql<
      RequestRow[]
    >`SELECT ${this.sql.unsafe(REQUEST_COLUMNS)} FROM pay.refund_requests WHERE id = ${requestId}::uuid`;
    if (!rows[0]) throw new PayError(`Refund request ${requestId} not found`, 'pay.refund_request_not_found');
    return toRequest(rows[0]);
  }

  async list(input: { merchantId: string; paymentId?: string; status?: RefundRequestStatus; limit: number }): Promise<RefundRequest[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.sql.unsafe(REQUEST_COLUMNS)} FROM pay.refund_requests
       WHERE merchant_id = ${input.merchantId}::uuid
         AND (${input.paymentId ?? null}::uuid IS NULL OR payment_id = ${input.paymentId ?? null}::uuid)
         AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null}::text)
       ORDER BY seq DESC
       LIMIT ${input.limit}
    `;
    return rows.map(toRequest);
  }

  /** Cancels a queued request, once. Nothing was posted, so nothing is undone. */
  async cancel(requestId: string): Promise<RefundRequest> {
    return transaction(this.sql, async (tx) => {
      const rows = await tx<
        RequestRow[]
      >`SELECT ${tx.unsafe(REQUEST_COLUMNS)} FROM pay.refund_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new PayError(`Refund request ${requestId} not found`, 'pay.refund_request_not_found');
      if (row.status !== 'queued') throw closed(row);
      const next = await tx<RequestRow[]>`
        UPDATE pay.refund_requests SET status = 'cancelled', closed_at = now() WHERE id = ${requestId}::uuid
        RETURNING ${tx.unsafe(REQUEST_COLUMNS)}
      `;
      return toRequest(next[0]!);
    });
  }

  /**
   * The checker's decision. The maker is refused. Reject closes the request. Approve records the checker, then runs
   * exactly the request's refund through the door under its key: refunded on success; failed with the code on a
   * definite refusal; and on any other error the request stays approved (the outcome is unknown), so `decide` cannot
   * run it twice and `retry` asks the door again with the same key.
   */
  async decide(input: {
    requestId: string;
    checkerUserId: string;
    decision: 'approve' | 'reject';
    reason?: string;
  }): Promise<RefundRequest> {
    const decided = await transaction(this.sql, async (tx) => {
      const rows = await tx<
        RequestRow[]
      >`SELECT ${tx.unsafe(REQUEST_COLUMNS)} FROM pay.refund_requests WHERE id = ${input.requestId}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new PayError(`Refund request ${input.requestId} not found`, 'pay.refund_request_not_found');
      if (row.status !== 'queued') throw closed(row);
      if (row.maker_user_id === input.checkerUserId) {
        throw new PayError('The person who asked for a refund cannot approve it', 'pay.refund_approval_self');
      }
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      const next = await tx<RequestRow[]>`
        UPDATE pay.refund_requests
           SET status = ${status}, checker_user_id = ${input.checkerUserId}, checker_reason = ${input.reason ?? null}, decided_at = now(),
               closed_at = ${status === 'rejected' ? new Date() : null}
         WHERE id = ${input.requestId}::uuid
        RETURNING ${tx.unsafe(REQUEST_COLUMNS)}
      `;
      return toRequest(next[0]!);
    });
    return decided.status === 'approved' ? this.execute(decided) : decided;
  }

  /** Runs an approved request's refund again under the same key (after an unknown outcome). */
  async retry(requestId: string): Promise<RefundRequest> {
    const request = await this.get(requestId);
    if (request.status !== 'approved') throw closed(request);
    return this.execute(request);
  }

  private async execute(request: RefundRequest): Promise<RefundRequest> {
    let outcome: { status: 'refunded' } | { status: 'failed'; code: string };
    try {
      await this.door.refund(request.paymentId, parseAmount(request.amount), { refundId: request.refundId });
      outcome = { status: 'refunded' };
    } catch (error) {
      // A typed refusal is definite; anything else leaves the request approved and the refund to be checked.
      if (!(error instanceof PayError) || error.code === 'pay.refund_in_flight') throw error;
      outcome = { status: 'failed', code: error.code };
    }
    const rows = await this.sql<RequestRow[]>`
      UPDATE pay.refund_requests
         SET status = ${outcome.status}, failure_code = ${outcome.status === 'failed' ? outcome.code : null}, closed_at = now()
       WHERE id = ${request.id}::uuid AND status = 'approved'
      RETURNING ${this.sql.unsafe(REQUEST_COLUMNS)}
    `;
    return rows[0] ? toRequest(rows[0]) : this.get(request.id);
  }

  // ── bulk refunds ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Runs one batch. Each row refunds what is left on its payment (or the row's amount), under the key
   * `refund:<paymentId>:bulk:<batchId>:<row>`, so a batch run again replays every row that ran and refunds nothing
   * twice. A row above the approval rule is queued for approval instead. Each row's outcome is kept and reported.
   */
  async bulk(input: {
    merchantId: string;
    batchId: string;
    rows: ReadonlyArray<{ paymentId: string; amount?: Amount }>;
    makerUserId: string;
  }): Promise<RefundBatchRow[]> {
    if (input.rows.length === 0 || input.rows.length > BULK_REFUND_MAX_ROWS) {
      throw new PayError(`A bulk refund carries 1 to ${BULK_REFUND_MAX_ROWS} rows`, 'pay.refund_batch_invalid', {
        max: BULK_REFUND_MAX_ROWS,
      });
    }
    if (new Set(input.rows.map((r) => r.paymentId)).size !== input.rows.length) {
      throw new PayError('A payment appears twice in one bulk refund', 'pay.refund_batch_invalid');
    }
    const kept = await this.sql<Array<{ row_no: number; payment_id: string; maker_user_id: string; merchant_id: string }>>`
      SELECT row_no, payment_id, maker_user_id, merchant_id FROM pay.refund_batch_rows WHERE batch_id = ${input.batchId}::uuid ORDER BY row_no
    `;
    if (
      kept.length > 0 &&
      (kept[0]!.merchant_id !== input.merchantId || kept.map((k) => k.payment_id).join() !== input.rows.map((r) => r.paymentId).join())
    ) {
      throw new PayError(`Batch ${input.batchId} was started with other rows`, 'pay.refund_batch_invalid');
    }
    const out: RefundBatchRow[] = [];
    for (const [i, row] of input.rows.entries()) {
      const rowNo = i + 1;
      const refundId = `refund:${row.paymentId}:bulk:${input.batchId}:${rowNo}`;
      await this.sql`
        INSERT INTO pay.refund_batch_rows (batch_id, row_no, merchant_id, payment_id, amount, refund_id, maker_user_id)
        VALUES (${input.batchId}::uuid, ${rowNo}, ${input.merchantId}::uuid, ${row.paymentId}::uuid,
                ${row.amount === undefined ? null : formatAmount(row.amount)}, ${refundId}, ${input.makerUserId})
        ON CONFLICT (batch_id, row_no) DO NOTHING
      `;
      const stored = await this.sql<Array<{ amount: string | null; outcome: RefundBatchRow['outcome']; refusal_code: string | null }>>`
        SELECT amount::text AS amount, outcome, refusal_code FROM pay.refund_batch_rows WHERE batch_id = ${input.batchId}::uuid AND row_no = ${rowNo}
      `;
      let amount = stored[0]!.amount === null ? null : parseAmount(stored[0]!.amount);
      let outcome: RefundBatchRow['outcome'];
      let code: string | null = null;
      try {
        const payment = await this.door.getPayment(row.paymentId);
        if (payment.merchantId !== input.merchantId) throw new PayError(`Payment ${row.paymentId} not found`, 'pay.payment_not_found');
        if (amount === null) {
          // What was left when the row first ran, kept on the row, so a run again names the same amount and replays.
          const left = payment.capturedAmount - payment.refundedAmount;
          const done = await this.alreadyRefunded(row.paymentId, refundId);
          amount = done ?? left;
          if (amount <= 0n) throw new PayError('Nothing is left to refund on this payment', 'pay.nothing_captured');
          await this
            .sql`UPDATE pay.refund_batch_rows SET amount = ${formatAmount(amount)} WHERE batch_id = ${input.batchId}::uuid AND row_no = ${rowNo} AND amount IS NULL`;
        }
        if (
          !(await this.alreadyRefunded(row.paymentId, refundId)) &&
          (await this.needsApproval(input.merchantId, payment.assetId, amount, row.paymentId))
        ) {
          await this.request({ merchantId: input.merchantId, paymentId: row.paymentId, amount, refundId, makerUserId: input.makerUserId });
          throw new PayError('Above the approval rule: queued for approval', 'pay.refund_request_invalid');
        }
        await this.door.refund(row.paymentId, amount, { refundId });
        outcome = 'refunded';
      } catch (error) {
        if (error instanceof PayError && error.code !== 'pay.refund_in_flight') {
          outcome = 'refused';
          code = error.code;
        } else if (error instanceof PayGuardRefusal) {
          outcome = 'refused';
          code = error.code;
        } else {
          outcome = 'unknown';
        }
      }
      await this.sql`
        UPDATE pay.refund_batch_rows SET outcome = ${outcome}, refusal_code = ${code}, updated_at = now()
         WHERE batch_id = ${input.batchId}::uuid AND row_no = ${rowNo}
      `;
      out.push({
        row: rowNo,
        paymentId: row.paymentId,
        amount: amount === null ? null : formatAmount(amount),
        refundId,
        outcome,
        refusalCode: code,
      });
    }
    return out;
  }

  /** The amount a completed refund under this key moved, if it ran. */
  private async alreadyRefunded(paymentId: string, refundId: string): Promise<Amount | null> {
    const rows = await this.sql<Array<{ amount: string }>>`
      SELECT payload->>'amount' AS amount FROM pay.payment_events
       WHERE payment_id = ${paymentId}::uuid AND event = 'refunded' AND payload->>'refundId' = ${refundId} LIMIT 1
    `;
    return rows[0] ? parseAmount(rows[0].amount) : null;
  }
}

/**
 * The guard on the refund door: above the owner's rule, a refund runs only for an approved request with the same
 * payment, key and amount, whoever calls the door (portal, public API, bulk, an approval being executed). Runs inside the
 * refund's first transaction, before anything is debited, so a refusal records and moves nothing.
 */
export function createRefundApprovalGuards(): PartialPayGuards {
  return {
    beforeRefund: async (ctx) => {
      if (ctx.replay.kind === 'replay') return;
      const rules = await ctx.tx<Array<{ threshold: string }>>`
        SELECT threshold::text AS threshold FROM pay.refund_approval_rules
         WHERE merchant_id = ${ctx.merchantId}::uuid AND asset_code = ${ctx.assetId}
      `;
      const rule = rules[0];
      if (!rule) return;
      const before = await refundedSoFar(ctx.tx, ctx.paymentId, ctx.refundId);
      if (before + ctx.amount <= parseAmount(rule.threshold)) return;
      // A refund larger than what is left can never run: the door refuses it by its own code
      // (pay.refund_exceeds_captured), which says why, rather than asking for an approval it could never use.
      const captured = await ctx.tx<Array<{ total: string }>>`
        SELECT COALESCE(SUM((payload->>'amount')::numeric), 0)::text AS total
          FROM pay.payment_events WHERE payment_id = ${ctx.paymentId}::uuid AND event = 'captured'
      `;
      if (ctx.amount > parseAmount(captured[0]?.total ?? '0') - before) return;
      const approved =
        ctx.refundId === undefined
          ? []
          : await ctx.tx<Array<{ id: string }>>`
              SELECT id FROM pay.refund_requests
               WHERE payment_id = ${ctx.paymentId}::uuid AND refund_id = ${ctx.refundId}
                 AND amount = ${formatAmount(ctx.amount)}::numeric AND status = 'approved'
            `;
      if (approved.length === 0) {
        throw new PayGuardRefusal('pay.guard_refund_approval_required', 'refused', {
          threshold: formatAmount(parseAmount(rule.threshold)),
        });
      }
    },
  };
}

/**
 * What the payment has already refunded or holds in a refund being sent: completed refunds, plus refunds posted and
 * not yet finished or reversed. The approval rule counts these with the new refund, so a split refund is counted whole.
 */
async function refundedSoFar(sql: Sql, paymentId: string, except?: string): Promise<Amount> {
  const rows = await sql<Array<{ total: string | null }>>`
    SELECT COALESCE(SUM((payload->>'amount')::numeric), 0)::text AS total
      FROM pay.payment_events e
     WHERE e.payment_id = ${paymentId}::uuid
       AND (${except ?? null}::text IS NULL OR e.payload->>'refundId' <> ${except ?? null}::text)
       AND (
         e.event = 'refunded'
         OR (
           e.event = 'refund.posted'
           AND NOT EXISTS (
             SELECT 1 FROM pay.payment_events d
              WHERE d.payment_id = e.payment_id AND d.event IN ('refunded', 'refund.reversed')
                AND d.payload->>'refundId' = e.payload->>'refundId'
           )
         )
       )
  `;
  return parseAmount(rows[0]?.total ?? '0');
}
