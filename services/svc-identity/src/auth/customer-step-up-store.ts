/**
 * Pending customer step-up rows and the mint/consume audit.
 * The spendable approval stays on action_approvals.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

export type StepUpStatus = 'pending' | 'minted' | 'expired';

export type CustomerStepUpRow = {
  readonly challengeId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly purpose: string;
  readonly amount: string | null;
  readonly target: string | null;
  readonly payloadHash: string;
  readonly webauthnChallenge: string | null;
  readonly status: StepUpStatus;
  readonly approvalId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly mintedAt: Date | null;
};

export type StepUpAuditEvent = {
  readonly event: 'minted' | 'consumed';
  readonly challengeId: string | null;
  readonly approvalId: string | null;
  readonly userId: string;
  readonly sessionId: string;
  readonly scope: string;
  readonly purpose: string;
  readonly amount: string | null;
  readonly target: string | null;
  readonly createdAt: Date;
};

type DbRow = {
  challenge_id: string;
  user_id: string;
  session_id: string;
  scope: string;
  purpose: string;
  amount: string | null;
  target: string | null;
  payload_hash: string;
  webauthn_challenge: string | null;
  status: StepUpStatus;
  approval_id: string | null;
  created_at: Date;
  expires_at: Date;
  minted_at: Date | null;
};

const COLS = `challenge_id, user_id, session_id, scope, purpose, amount, target, payload_hash,
  webauthn_challenge, status, approval_id, created_at, expires_at, minted_at`;

function fromDb(row: DbRow): CustomerStepUpRow {
  return {
    challengeId: row.challenge_id,
    userId: row.user_id,
    sessionId: row.session_id,
    scope: row.scope,
    purpose: row.purpose,
    amount: row.amount,
    target: row.target,
    payloadHash: row.payload_hash,
    webauthnChallenge: row.webauthn_challenge,
    status: row.status,
    approvalId: row.approval_id,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    mintedAt: row.minted_at ? (row.minted_at instanceof Date ? row.minted_at : new Date(row.minted_at)) : null,
  };
}

export class SqlCustomerStepUpStore {
  constructor(private readonly sql: Sql) {}

  async insert(row: CustomerStepUpRow, db: Sql = this.sql): Promise<void> {
    await db`
      INSERT INTO customer_step_ups (
        challenge_id, user_id, session_id, scope, purpose, amount, target, payload_hash,
        webauthn_challenge, status, approval_id, created_at, expires_at, minted_at
      ) VALUES (
        ${row.challengeId}, ${row.userId}, ${row.sessionId}, ${row.scope}, ${row.purpose},
        ${row.amount}, ${row.target}, ${row.payloadHash}, ${row.webauthnChallenge}, ${row.status},
        ${row.approvalId}, ${row.createdAt}, ${row.expiresAt}, ${row.mintedAt}
      )
    `;
  }

  async lock(challengeId: string, db: Sql): Promise<CustomerStepUpRow | null> {
    const rows = await db<DbRow[]>`
      SELECT ${db.unsafe(COLS)} FROM customer_step_ups WHERE challenge_id = ${challengeId} LIMIT 1 FOR UPDATE
    `;
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async countSince(userId: string, since: Date, db: Sql): Promise<{ readonly count: number; readonly oldest: Date | null }> {
    const rows = await db<Array<{ n: string; oldest: Date | null }>>`
      SELECT count(*)::text AS n, min(created_at) AS oldest
      FROM customer_step_ups
      WHERE user_id = ${userId} AND created_at > ${since}
    `;
    return { count: Number(rows[0]?.n ?? '0'), oldest: rows[0]?.oldest ?? null };
  }

  async markMinted(challengeId: string, approvalId: string, at: Date, db: Sql): Promise<boolean> {
    const rows = await db<Array<{ challenge_id: string }>>`
      UPDATE customer_step_ups
      SET status = 'minted', approval_id = ${approvalId}, minted_at = ${at}
      WHERE challenge_id = ${challengeId} AND status = 'pending'
      RETURNING challenge_id
    `;
    return rows.length === 1;
  }

  async markExpired(challengeId: string, db: Sql = this.sql): Promise<void> {
    await db`
      UPDATE customer_step_ups SET status = 'expired'
      WHERE challenge_id = ${challengeId} AND status = 'pending'
    `;
  }

  async findByApproval(approvalId: string): Promise<CustomerStepUpRow | null> {
    const rows = await this.sql<DbRow[]>`
      SELECT ${this.sql.unsafe(COLS)} FROM customer_step_ups WHERE approval_id = ${approvalId} LIMIT 1
    `;
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async audit(event: StepUpAuditEvent, db: Sql = this.sql): Promise<void> {
    await db`
      INSERT INTO step_up_audit (
        audit_id, event, challenge_id, approval_id, user_id, session_id, scope, purpose, amount, target, created_at
      ) VALUES (
        ${randomUUID()}, ${event.event}, ${event.challengeId}, ${event.approvalId}, ${event.userId},
        ${event.sessionId}, ${event.scope}, ${event.purpose}, ${event.amount}, ${event.target}, ${event.createdAt}
      )
    `;
  }

  /** Consume audit. A same-person row minted by this ceremony copies its amount and target. */
  async auditConsumed(row: {
    readonly approvalId: string;
    readonly requesterId: string;
    readonly sessionId?: string | null;
    readonly actionType: string;
    readonly at: Date;
  }): Promise<void> {
    const intent = await this.findByApproval(row.approvalId);
    await this.audit({
      event: 'consumed',
      challengeId: intent?.challengeId ?? null,
      approvalId: row.approvalId,
      userId: row.requesterId,
      sessionId: row.sessionId ?? intent?.sessionId ?? '',
      scope: intent?.scope ?? row.actionType,
      purpose: intent?.purpose ?? row.actionType,
      amount: intent?.amount ?? null,
      target: intent?.target ?? null,
      createdAt: row.at,
    });
  }
}
