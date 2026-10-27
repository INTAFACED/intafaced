import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { DEFINITE_POST_REFUSAL_CODES, LedgerError, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { postPayLedger } from '../../ledger-receipt.js';
import { INTERNAL_RAIL } from '../internal.js';
import { WithdrawalReturnError } from './errors.js';
import { RETURN_BLOCKER, type ListInput, type RecordInput, type RecreditInput, type ReturnView } from './schemas.js';

/**
 * Returned withdrawals (W-withdraw-07, wallet-withdraw-R01). A returned withdrawal is a SENT withdrawal whose funds came
 * back from the outside. One founder records it (parked, nothing booked); a second founder, never the one who recorded
 * it, approves the credit, and the amount goes back to the person's available balance through `withdrawReturned`, keyed
 * on the attempt the settle was posted under, so it is booked once however often it is approved or retried. svc-ledger
 * books it only against that posted settle, for no more than it sent. Every write is append-only and appends to
 * `pay.withdrawal_return_events` in the same transaction.
 *
 * If this crashes exactly here: after the approval and before the post, nothing is booked and the same approval again
 * posts it; after the post and before the posting row, the person is already credited and the same approval again finds
 * the ledger's transaction under the same key and records it. Nobody's funds are stranded or credited twice.
 */
export interface WithdrawalReturnServiceDeps {
  readonly sql: Sql;
  /** svc-pay's ledger client. The credit is booked through it and nowhere else. */
  readonly ledger: LedgerClient;
}

interface ReturnRow {
  withdrawal_id: string;
  return_ref: string;
  user_id: string;
  asset_id: string;
  amount: string;
  reason: string;
  reason_code: ReturnView['reasonCode'];
  blocker: string;
  recorded_by: string;
  recorded_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  ledger_withdrawal_id: string | null;
  ledger_tx_id: string | null;
  posted_at: Date | null;
  last_failure: string | null;
}

/** The ledger refusal that will refuse again on a retry, as opposed to an answer that was lost. */
const WITHDRAW_RETURN_UNBOUND = 'ledger.withdraw_return_unbound';

/**
 * One SELECT for get, list and recredit. `last_failure` is the ledger's code from the newest failed credit, so a credit
 * that is approved and not booked names what stops it.
 */
const rowColumns = (q: Sql) => q`
  r.withdrawal_id, r.return_ref, w.user_id, r.asset_id, r.amount::text AS amount, r.reason, r.reason_code, r.blocker,
  r.recorded_by, r.recorded_at, c.approved_by, c.approved_at, c.ledger_withdrawal_id, p.ledger_tx_id, p.posted_at,
  (SELECT e.detail->>'code' FROM pay.withdrawal_return_events e
    WHERE e.withdrawal_id = r.withdrawal_id AND e.kind = 'credit_failed' ORDER BY e.seq DESC LIMIT 1) AS last_failure`;

const view = (r: ReturnRow): ReturnView => ({
  withdrawalId: r.withdrawal_id,
  returnRef: r.return_ref,
  userId: r.user_id,
  assetId: r.asset_id,
  amount: r.amount,
  reason: r.reason,
  reasonCode: r.reason_code,
  state: r.ledger_tx_id ? 'credited' : r.approved_by ? 'crediting' : 'parked',
  // A parked return always waits on the second founder now; rows recorded before the recipe existed still store the
  // old `ledger.recipe_missing` blocker, which is no longer true.
  blocker: r.ledger_tx_id ? null : r.approved_by ? r.last_failure : RETURN_BLOCKER,
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at.toISOString(),
  approvedBy: r.approved_by,
  approvedAt: r.approved_at?.toISOString() ?? null,
  ledgerTxId: r.ledger_tx_id,
  creditedAt: r.posted_at?.toISOString() ?? null,
});

export class WithdrawalReturnService {
  constructor(private readonly deps: WithdrawalReturnServiceDeps) {}

  async record(actor: string, input: RecordInput): Promise<ReturnView> {
    return transaction(this.deps.sql, async (tx) => {
      const [withdrawal] = await tx<Array<{ status: string; amount: string; asset_id: string; rail: string }>>`
        SELECT status::text AS status, amount::text AS amount, asset_id, rail FROM pay.withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`;
      if (!withdrawal) throw new WithdrawalReturnError('withdrawal_return.withdrawal_not_found', 'no such withdrawal');
      if (withdrawal.status !== 'sent') {
        throw new WithdrawalReturnError('withdrawal_return.not_sent', 'only a sent withdrawal can come back; this one was not sent');
      }
      if (withdrawal.rail === INTERNAL_RAIL) {
        throw new WithdrawalReturnError(
          'withdrawal_return.internal_settlement',
          'a withdrawal settled inside the platform never left by a rail, so nothing can come back from one',
        );
      }
      if (parseAmount(input.amount) <= 0n) {
        throw new WithdrawalReturnError('withdrawal_return.amount_invalid', 'a return is a positive amount');
      }
      if (parseAmount(input.amount) > parseAmount(withdrawal.amount)) {
        throw new WithdrawalReturnError('withdrawal_return.amount_exceeds_withdrawal', 'a return cannot be larger than the withdrawal');
      }
      const [byRef] = await tx<Array<{ withdrawal_id: string }>>`
        SELECT withdrawal_id FROM pay.withdrawal_returns WHERE return_ref = ${input.returnRef}`;
      if (byRef && byRef.withdrawal_id !== input.withdrawalId) {
        throw new WithdrawalReturnError('withdrawal_return.ref_differs', 'that return reference already names another withdrawal');
      }
      const inserted = await tx<Array<{ withdrawal_id: string }>>`
        INSERT INTO pay.withdrawal_returns (withdrawal_id, return_ref, asset_id, amount, reason, reason_code, state, blocker, recorded_by)
        VALUES (${input.withdrawalId}, ${input.returnRef}, ${withdrawal.asset_id}, ${input.amount}::numeric, ${input.reason},
                ${input.reasonCode}, 'parked', ${RETURN_BLOCKER}, ${actor})
        ON CONFLICT (withdrawal_id) DO NOTHING
        RETURNING withdrawal_id`;
      if (inserted[0]) {
        await tx`
          INSERT INTO pay.withdrawal_return_events (withdrawal_id, kind, actor_id, detail)
          VALUES (${input.withdrawalId}, 'recorded', ${actor},
                  ${tx.json({ returnRef: input.returnRef, amount: input.amount, assetId: withdrawal.asset_id, reasonCode: input.reasonCode })})`;
      } else {
        const [existing] = await this.rows(tx, input.withdrawalId);
        const same =
          existing !== undefined &&
          existing.return_ref === input.returnRef &&
          parseAmount(existing.amount) === parseAmount(input.amount) &&
          existing.reason === input.reason &&
          existing.reason_code === input.reasonCode;
        if (!same) {
          throw new WithdrawalReturnError(
            existing?.return_ref === input.returnRef ? 'withdrawal_return.ref_differs' : 'withdrawal_return.already_recorded',
            'a return is already recorded for this withdrawal with different terms',
          );
        }
      }
      const [row] = await this.rows(tx, input.withdrawalId);
      return view(row!);
    });
  }

  async get(withdrawalId: string): Promise<ReturnView> {
    const [row] = await this.rows(this.deps.sql, withdrawalId);
    if (!row) throw new WithdrawalReturnError('withdrawal_return.not_found', 'no return is recorded for this withdrawal');
    return view(row);
  }

  async list(input: ListInput): Promise<ReturnView[]> {
    const rows = await this.deps.sql<ReturnRow[]>`
      SELECT ${rowColumns(this.deps.sql)}
        FROM pay.withdrawal_returns r
        JOIN pay.withdrawals w ON w.id = r.withdrawal_id
        LEFT JOIN pay.withdrawal_return_credits c ON c.withdrawal_id = r.withdrawal_id
        LEFT JOIN pay.withdrawal_return_postings p ON p.withdrawal_id = r.withdrawal_id
       WHERE (${input.after ?? null}::uuid IS NULL
              OR (r.recorded_at, r.withdrawal_id) < (SELECT recorded_at, withdrawal_id FROM pay.withdrawal_returns WHERE withdrawal_id = ${input.after ?? null}::uuid))
       ORDER BY r.recorded_at DESC, r.withdrawal_id DESC
       LIMIT ${input.limit}`;
    return rows.map(view);
  }

  /**
   * Put a recorded return back in the person's available balance. A second founder approves it: the founder who recorded
   * it is refused. The approval is written before anything is posted; the post is keyed on the settled attempt, so the
   * same approval again (by either founder) books nothing new and records the ledger's answer if it was lost.
   */
  async recredit(actor: string, input: RecreditInput): Promise<ReturnView> {
    const { row: approved, rail } = await transaction(this.deps.sql, async (tx) => {
      const [withdrawal] = await tx<Array<{ status: string; attempts: number; rail: string }>>`
        SELECT status::text AS status, attempts, rail FROM pay.withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`;
      const [row] = await this.rows(tx, input.withdrawalId);
      if (!withdrawal || !row) throw new WithdrawalReturnError('withdrawal_return.not_found', 'no return is recorded for this withdrawal');
      if (row.approved_by) return { row, rail: withdrawal.rail };
      if (row.recorded_by === actor) {
        throw new WithdrawalReturnError(
          'withdrawal_return.same_founder',
          'the founder who recorded this return cannot also approve its credit',
        );
      }
      if (withdrawal.status !== 'sent') {
        throw new WithdrawalReturnError('withdrawal_return.not_sent', 'only a sent withdrawal can come back; this one is no longer sent');
      }
      const ledgerWithdrawalId = `${input.withdrawalId}:${withdrawal.attempts}`;
      await tx`
        INSERT INTO pay.withdrawal_return_credits (withdrawal_id, approved_by, note, ledger_withdrawal_id)
        VALUES (${input.withdrawalId}, ${actor}, ${input.reason}, ${ledgerWithdrawalId})`;
      await tx`
        INSERT INTO pay.withdrawal_return_events (withdrawal_id, kind, actor_id, detail)
        VALUES (${input.withdrawalId}, 'approved', ${actor}, ${tx.json({ note: input.reason, ledgerWithdrawalId })})`;
      const [after] = await this.rows(tx, input.withdrawalId);
      return { row: after!, rail: withdrawal.rail };
    });
    if (approved.ledger_tx_id) return view(approved);

    let txId: string;
    try {
      const posted = await postPayLedger(
        this.deps.ledger,
        recipes.withdrawReturned({
          userId: approved.user_id,
          assetId: approved.asset_id,
          amount: parseAmount(approved.amount),
          rail,
          withdrawalId: approved.ledger_withdrawal_id!,
        }),
      );
      txId = posted.id;
    } catch (error) {
      const code = error instanceof LedgerError ? error.code : 'ledger.unknown';
      const message = error instanceof Error ? error.message : 'ledger error';
      await this.deps.sql`
        INSERT INTO pay.withdrawal_return_events (withdrawal_id, kind, actor_id, detail)
        VALUES (${input.withdrawalId}, 'credit_failed', ${actor}, ${this.deps.sql.json({ code, message })})`;
      if (code === WITHDRAW_RETURN_UNBOUND || DEFINITE_POST_REFUSAL_CODES.has(code)) {
        throw new WithdrawalReturnError(
          'withdrawal_return.ledger_refused',
          `the credit is approved and the ledger refused it (${code}: ${message}); nothing was booked, and the return names this until it is fixed`,
        );
      }
      throw new WithdrawalReturnError(
        'withdrawal_return.ledger_outcome_unknown',
        `the credit is approved and its ledger answer is not known (${message}); the same approval again posts it once`,
      );
    }
    await transaction(this.deps.sql, async (tx) => {
      const inserted = await tx<Array<{ withdrawal_id: string }>>`
        INSERT INTO pay.withdrawal_return_postings (withdrawal_id, ledger_tx_id) VALUES (${input.withdrawalId}, ${txId})
        ON CONFLICT (withdrawal_id) DO NOTHING
        RETURNING withdrawal_id`;
      if (inserted[0]) {
        await tx`
          INSERT INTO pay.withdrawal_return_events (withdrawal_id, kind, actor_id, detail)
          VALUES (${input.withdrawalId}, 'credited', ${actor}, ${tx.json({ ledgerTxId: txId, approvedBy: approved.approved_by })})`;
      }
    });
    return this.get(input.withdrawalId);
  }

  private rows(q: Sql, withdrawalId: string): Promise<ReturnRow[]> {
    return q<ReturnRow[]>`
      SELECT ${rowColumns(q)}
        FROM pay.withdrawal_returns r
        JOIN pay.withdrawals w ON w.id = r.withdrawal_id
        LEFT JOIN pay.withdrawal_return_credits c ON c.withdrawal_id = r.withdrawal_id
        LEFT JOIN pay.withdrawal_return_postings p ON p.withdrawal_id = r.withdrawal_id
       WHERE r.withdrawal_id = ${withdrawalId}`;
  }
}
