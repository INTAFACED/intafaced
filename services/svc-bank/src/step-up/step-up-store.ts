/**
 * Where svc-bank remembers which operation spent a step-up approval.
 *
 * Identity burns an approval on the first consume (CAS). A retry of the SAME operation
 * (same client-supplied transfer/schedule/card id) must still succeed once the first
 * attempt's response was lost, so bank records (approval, operation key) here after the
 * identity consume and answers a repeat from this row without calling identity again.
 * A different operation presenting the same approval is refused. No balances.
 */
import type { Sql } from 'postgres';

export type StepUpUse = {
  readonly approvalId: string;
  readonly userId: string;
  readonly actionType: string;
  readonly payloadHash: string;
  /** transferId / scheduleId / payrollId / clientId / cardId... the idempotency id inside the hash. */
  readonly operationKey: string;
  /** The approval's own expiry: a replay is only honoured inside the original five minutes. */
  readonly expiresAt: Date;
};

export interface StepUpUseStore {
  get(approvalId: string): Promise<StepUpUse | null>;
  /** Insert if absent. Returns the row that now holds the approval (the new one, or the earlier winner). */
  record(use: StepUpUse): Promise<StepUpUse>;
}

export class MemoryStepUpUseStore implements StepUpUseStore {
  private readonly rows = new Map<string, StepUpUse>();

  async get(approvalId: string): Promise<StepUpUse | null> {
    return this.rows.get(approvalId) ?? null;
  }

  async record(use: StepUpUse): Promise<StepUpUse> {
    const existing = this.rows.get(use.approvalId);
    if (existing) return existing;
    this.rows.set(use.approvalId, use);
    return use;
  }
}

type Row = {
  approval_id: string;
  user_id: string;
  action_type: string;
  payload_hash: string;
  operation_key: string;
  expires_at: Date | string;
};

function fromRow(r: Row): StepUpUse {
  return {
    approvalId: r.approval_id,
    userId: r.user_id,
    actionType: r.action_type,
    payloadHash: r.payload_hash,
    operationKey: r.operation_key,
    expiresAt: r.expires_at instanceof Date ? r.expires_at : new Date(r.expires_at),
  };
}

export class SqlStepUpUseStore implements StepUpUseStore {
  constructor(private readonly sql: Sql) {}

  async get(approvalId: string): Promise<StepUpUse | null> {
    const rows = await this.sql<Row[]>`
      SELECT approval_id, user_id, action_type, payload_hash, operation_key, expires_at
      FROM bank.step_up_uses WHERE approval_id = ${approvalId} LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async record(use: StepUpUse): Promise<StepUpUse> {
    const inserted = await this.sql<Row[]>`
      INSERT INTO bank.step_up_uses (approval_id, user_id, action_type, payload_hash, operation_key, expires_at)
      VALUES (${use.approvalId}, ${use.userId}, ${use.actionType}, ${use.payloadHash}, ${use.operationKey}, ${use.expiresAt})
      ON CONFLICT (approval_id) DO NOTHING
      RETURNING approval_id, user_id, action_type, payload_hash, operation_key, expires_at
    `;
    if (inserted[0]) return fromRow(inserted[0]);
    const winner = await this.get(use.approvalId);
    if (!winner) throw new Error('step_up_uses: conflict without a row');
    return winner;
  }
}
