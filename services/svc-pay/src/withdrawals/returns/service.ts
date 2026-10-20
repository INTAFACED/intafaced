import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { WithdrawalReturnError } from './errors.js';
import { RETURN_BLOCKER, type ListInput, type RecordInput, type ReturnView } from './schemas.js';

/**
 * Returned withdrawals (W-withdraw-07, wallet-withdraw-R01). A returned withdrawal is a SENT withdrawal whose funds
 * came back from the outside. The returned-funds ledger recipe does not exist (a named ledger-owner job), so a return is
 * recorded and PARKED with its blocker named and nothing is booked: no balance moves here, and the customer is not
 * told their funds are back. Each write appends to `pay.withdrawal_return_events` in the same transaction.
 */
export interface WithdrawalReturnServiceDeps {
  readonly sql: Sql;
}

interface ReturnRow {
  withdrawal_id: string;
  return_ref: string;
  user_id: string;
  asset_id: string;
  amount: string;
  reason: string;
  state: 'parked';
  blocker: string;
  recorded_by: string;
  recorded_at: Date;
}

const view = (r: ReturnRow): ReturnView => ({
  withdrawalId: r.withdrawal_id,
  returnRef: r.return_ref,
  userId: r.user_id,
  assetId: r.asset_id,
  amount: r.amount,
  reason: r.reason,
  state: r.state,
  blocker: r.blocker,
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at.toISOString(),
});

export class WithdrawalReturnService {
  constructor(private readonly deps: WithdrawalReturnServiceDeps) {}

  async record(actor: string, input: RecordInput): Promise<ReturnView> {
    return transaction(this.deps.sql, async (tx) => {
      const [withdrawal] = await tx<Array<{ status: string; amount: string; asset_id: string }>>`
        SELECT status::text AS status, amount::text AS amount, asset_id FROM pay.withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`;
      if (!withdrawal) throw new WithdrawalReturnError('withdrawal_return.withdrawal_not_found', 'no such withdrawal');
      if (withdrawal.status !== 'sent') {
        throw new WithdrawalReturnError('withdrawal_return.not_sent', 'only a sent withdrawal can come back; this one was not sent');
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
        INSERT INTO pay.withdrawal_returns (withdrawal_id, return_ref, asset_id, amount, reason, state, blocker, recorded_by)
        VALUES (${input.withdrawalId}, ${input.returnRef}, ${withdrawal.asset_id}, ${input.amount}::numeric, ${input.reason}, 'parked', ${RETURN_BLOCKER}, ${actor})
        ON CONFLICT (withdrawal_id) DO NOTHING
        RETURNING withdrawal_id`;
      if (inserted[0]) {
        await tx`
          INSERT INTO pay.withdrawal_return_events (withdrawal_id, kind, actor_id, detail)
          VALUES (${input.withdrawalId}, 'recorded', ${actor},
                  ${tx.json({ returnRef: input.returnRef, amount: input.amount, assetId: withdrawal.asset_id, blocker: RETURN_BLOCKER })})`;
      } else {
        const [existing] = await this.rows(tx, input.withdrawalId);
        const same =
          existing !== undefined &&
          existing.return_ref === input.returnRef &&
          parseAmount(existing.amount) === parseAmount(input.amount) &&
          existing.reason === input.reason;
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
      SELECT r.withdrawal_id, r.return_ref, w.user_id, r.asset_id, r.amount::text AS amount, r.reason, r.state, r.blocker,
             r.recorded_by, r.recorded_at
        FROM pay.withdrawal_returns r JOIN pay.withdrawals w ON w.id = r.withdrawal_id
       WHERE (${input.after ?? null}::uuid IS NULL
              OR (r.recorded_at, r.withdrawal_id) < (SELECT recorded_at, withdrawal_id FROM pay.withdrawal_returns WHERE withdrawal_id = ${input.after ?? null}::uuid))
       ORDER BY r.recorded_at DESC, r.withdrawal_id DESC
       LIMIT ${input.limit}`;
    return rows.map(view);
  }

  /**
   * Re-credit the customer for a recorded return. Refused: it needs the returned-funds ledger recipe and a second
   * person's approval, neither of which exists. The return stays parked.
   */
  async recredit(withdrawalId: string): Promise<never> {
    await this.get(withdrawalId);
    throw new WithdrawalReturnError(
      'withdrawal_return.recredit_unwired',
      `re-credit needs ${RETURN_BLOCKER} and a second approver; the return stays parked and nothing is booked`,
    );
  }

  private rows(q: Sql, withdrawalId: string): Promise<ReturnRow[]> {
    return q<ReturnRow[]>`
      SELECT r.withdrawal_id, r.return_ref, w.user_id, r.asset_id, r.amount::text AS amount, r.reason, r.state, r.blocker,
             r.recorded_by, r.recorded_at
        FROM pay.withdrawal_returns r JOIN pay.withdrawals w ON w.id = r.withdrawal_id
       WHERE r.withdrawal_id = ${withdrawalId}`;
  }
}
