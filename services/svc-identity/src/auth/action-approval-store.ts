/**
 * Durable action-bound approval rows. Identity owns issue/verify;
 * the target service consumes. No balances.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ActionApproval, ActionApprovalKind, ActionApprovalStatus } from '@intafaced/contracts';

export type StoredApproval = {
  readonly approvalId: string;
  readonly actionType: string;
  readonly targetService: string;
  readonly targetId: string;
  readonly expectedVersion: string;
  readonly payloadHash: string;
  readonly requesterId: string;
  readonly approverId: string | null;
  readonly policyVersion: string;
  readonly operationId: string;
  readonly status: ActionApprovalStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly approvedAt: Date | null;
  readonly consumedAt: Date | null;
  /** Absent means `four_eyes`. */
  readonly kind?: ActionApprovalKind;
  /** Session a `same_person` row is bound to. Null/absent for four-eyes rows. */
  readonly sessionId?: string | null;
};

/** What a consume asks the CAS to match, beyond the row's own fields. */
export type ConsumeCas = {
  readonly approvalId: string;
  readonly operationId: string;
  readonly payloadHash: string;
  readonly targetService: string;
  readonly targetId: string;
  readonly expectedVersion: string;
  /**
   * Same-person consume: the caller's principal. A `same_person` row is
   * consumed only when both match the row, atomically in the CAS; a
   * `four_eyes` row only when both are absent.
   */
  readonly principalUserId?: string | null;
  readonly principalSessionId?: string | null;
  readonly now: Date;
};

export interface ActionApprovalStore {
  insert(row: StoredApproval): Promise<StoredApproval>;
  get(approvalId: string): Promise<StoredApproval | null>;
  casExpire(approvalId: string, now: Date): Promise<StoredApproval | null>;
  casApprove(approvalId: string, approverId: string, now: Date): Promise<StoredApproval | null>;
  casReject(approvalId: string, actorId: string, now: Date): Promise<StoredApproval | null>;
  casRevoke(approvalId: string, actorId: string, now: Date): Promise<StoredApproval | null>;
  casConsume(input: ConsumeCas): Promise<StoredApproval | null>;
}

export function newApprovalIds(): { readonly approvalId: string; readonly operationId: string } {
  return { approvalId: randomUUID(), operationId: randomUUID() };
}

export function toActionApproval(row: StoredApproval): ActionApproval {
  return {
    ...(row.kind === 'same_person' ? { kind: 'same_person' as const } : {}),
    approvalId: row.approvalId,
    actionType: row.actionType,
    targetService: row.targetService,
    targetId: row.targetId,
    expectedVersion: row.expectedVersion,
    payloadHash: row.payloadHash,
    requesterId: row.requesterId,
    approverId: row.approverId,
    policyVersion: row.policyVersion,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.status,
    operationId: row.operationId,
  };
}

export class MemoryActionApprovalStore implements ActionApprovalStore {
  private readonly rows = new Map<string, StoredApproval>();

  async insert(row: StoredApproval): Promise<StoredApproval> {
    if (this.rows.has(row.approvalId)) throw new Error('action_approval.duplicate');
    this.rows.set(row.approvalId, row);
    return row;
  }

  async get(approvalId: string): Promise<StoredApproval | null> {
    return this.rows.get(approvalId) ?? null;
  }

  async casExpire(approvalId: string, now: Date): Promise<StoredApproval | null> {
    const row = this.rows.get(approvalId);
    if (!row) return null;
    if (row.status !== 'PENDING' && row.status !== 'APPROVED') return row;
    if (row.expiresAt.getTime() > now.getTime()) return row;
    const next: StoredApproval = { ...row, status: 'EXPIRED' };
    this.rows.set(approvalId, next);
    return next;
  }

  async casApprove(approvalId: string, approverId: string, now: Date): Promise<StoredApproval | null> {
    const row = this.rows.get(approvalId);
    if (!row || row.status !== 'PENDING') return null;
    if (row.requesterId === approverId) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    const next: StoredApproval = { ...row, status: 'APPROVED', approverId, approvedAt: now };
    this.rows.set(approvalId, next);
    return next;
  }

  async casReject(approvalId: string, actorId: string, now: Date): Promise<StoredApproval | null> {
    const row = this.rows.get(approvalId);
    if (!row || row.status !== 'PENDING') return null;
    if (row.requesterId === actorId) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    const next: StoredApproval = { ...row, status: 'REJECTED', approverId: actorId, approvedAt: now };
    this.rows.set(approvalId, next);
    return next;
  }

  async casRevoke(approvalId: string, actorId: string, now: Date): Promise<StoredApproval | null> {
    void now;
    const row = this.rows.get(approvalId);
    if (!row) return null;
    if (row.status !== 'PENDING' && row.status !== 'APPROVED') return null;
    if (row.requesterId !== actorId) return null;
    const next: StoredApproval = { ...row, status: 'REVOKED' };
    this.rows.set(approvalId, next);
    return next;
  }

  async casConsume(input: ConsumeCas): Promise<StoredApproval | null> {
    const row = this.rows.get(input.approvalId);
    if (!row) return null;
    if (row.status !== 'APPROVED') return null;
    if (!principalMatches(row, input)) return null;
    if (row.operationId !== input.operationId) return null;
    if (row.payloadHash !== input.payloadHash) return null;
    if (row.targetService !== input.targetService) return null;
    if (row.targetId !== input.targetId) return null;
    if (row.expectedVersion !== input.expectedVersion) return null;
    if (row.expiresAt.getTime() <= input.now.getTime()) return null;
    const next: StoredApproval = { ...row, status: 'CONSUMED', consumedAt: input.now };
    this.rows.set(input.approvalId, next);
    return next;
  }
}

/** Same rule as the SQL CAS: a same_person row needs the exact principal, a four_eyes row needs none. */
function principalMatches(row: StoredApproval, input: ConsumeCas): boolean {
  if (row.kind === 'same_person') {
    return (
      input.principalUserId != null &&
      input.principalSessionId != null &&
      row.requesterId === input.principalUserId &&
      row.sessionId === input.principalSessionId
    );
  }
  return input.principalUserId == null && input.principalSessionId == null;
}

type DbRow = {
  approval_id: string;
  action_type: string;
  target_service: string;
  target_id: string;
  expected_version: string;
  payload_hash: string;
  requester_id: string;
  approver_id: string | null;
  policy_version: string;
  operation_id: string;
  status: ActionApprovalStatus;
  created_at: Date;
  expires_at: Date;
  approved_at: Date | null;
  consumed_at: Date | null;
  kind: ActionApprovalKind;
  session_id: string | null;
};

function fromDb(row: DbRow): StoredApproval {
  return {
    approvalId: row.approval_id,
    actionType: row.action_type,
    targetService: row.target_service,
    targetId: row.target_id,
    expectedVersion: row.expected_version,
    payloadHash: row.payload_hash,
    requesterId: row.requester_id,
    approverId: row.approver_id,
    policyVersion: row.policy_version,
    operationId: row.operation_id,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    approvedAt: row.approved_at ? (row.approved_at instanceof Date ? row.approved_at : new Date(row.approved_at)) : null,
    consumedAt: row.consumed_at ? (row.consumed_at instanceof Date ? row.consumed_at : new Date(row.consumed_at)) : null,
    kind: row.kind,
    sessionId: row.session_id,
  };
}

const SELECT_COLS = `approval_id, action_type, target_service, target_id, expected_version, payload_hash,
  requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at, consumed_at, kind, session_id`;

export class SqlActionApprovalStore implements ActionApprovalStore {
  constructor(private readonly sql: Sql) {}

  async insert(row: StoredApproval): Promise<StoredApproval> {
    const saved = await this.sql<DbRow[]>`
      INSERT INTO action_approvals (
        approval_id, action_type, target_service, target_id, expected_version, payload_hash,
        requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at, consumed_at,
        kind, session_id
      ) VALUES (
        ${row.approvalId}, ${row.actionType}, ${row.targetService}, ${row.targetId}, ${row.expectedVersion}, ${row.payloadHash},
        ${row.requesterId}, ${row.approverId}, ${row.policyVersion}, ${row.operationId}, ${row.status},
        ${row.createdAt}, ${row.expiresAt}, ${row.approvedAt}, ${row.consumedAt},
        ${row.kind ?? 'four_eyes'}, ${row.sessionId ?? null}
      )
      RETURNING ${this.sql.unsafe(SELECT_COLS)}
    `;
    return fromDb(saved[0]!);
  }

  async get(approvalId: string): Promise<StoredApproval | null> {
    const rows = await this.sql<DbRow[]>`
      SELECT ${this.sql.unsafe(SELECT_COLS)} FROM action_approvals WHERE approval_id = ${approvalId} LIMIT 1
    `;
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async casExpire(approvalId: string, now: Date): Promise<StoredApproval | null> {
    const expired = await this.sql<DbRow[]>`
      UPDATE action_approvals
      SET status = 'EXPIRED'
      WHERE approval_id = ${approvalId}
        AND status IN ('PENDING', 'APPROVED')
        AND expires_at <= ${now}
      RETURNING ${this.sql.unsafe(SELECT_COLS)}
    `;
    if (expired[0]) return fromDb(expired[0]);
    return this.get(approvalId);
  }

  async casApprove(approvalId: string, approverId: string, now: Date): Promise<StoredApproval | null> {
    const rows = await this.sql<DbRow[]>`
      UPDATE action_approvals
      SET status = 'APPROVED', approver_id = ${approverId}, approved_at = ${now}
      WHERE approval_id = ${approvalId}
        AND status = 'PENDING'
        AND requester_id <> ${approverId}
        AND expires_at > ${now}
      RETURNING ${this.sql.unsafe(SELECT_COLS)}
    `;
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async casReject(approvalId: string, actorId: string, now: Date): Promise<StoredApproval | null> {
    const rows = await this.sql<DbRow[]>`
      UPDATE action_approvals
      SET status = 'REJECTED', approver_id = ${actorId}, approved_at = ${now}
      WHERE approval_id = ${approvalId}
        AND status = 'PENDING'
        AND requester_id <> ${actorId}
        AND expires_at > ${now}
      RETURNING ${this.sql.unsafe(SELECT_COLS)}
    `;
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async casRevoke(approvalId: string, actorId: string, now: Date): Promise<StoredApproval | null> {
    void now;
    const rows = await this.sql<DbRow[]>`
      UPDATE action_approvals
      SET status = 'REVOKED'
      WHERE approval_id = ${approvalId}
        AND status IN ('PENDING', 'APPROVED')
        AND requester_id = ${actorId}
      RETURNING ${this.sql.unsafe(SELECT_COLS)}
    `;
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async casConsume(input: ConsumeCas): Promise<StoredApproval | null> {
    const principalUserId = input.principalUserId ?? null;
    const principalSessionId = input.principalSessionId ?? null;
    const rows = await this.sql<DbRow[]>`
      UPDATE action_approvals
      SET status = 'CONSUMED', consumed_at = ${input.now}
      WHERE approval_id = ${input.approvalId}
        AND status = 'APPROVED'
        AND operation_id = ${input.operationId}
        AND payload_hash = ${input.payloadHash}
        AND target_service = ${input.targetService}
        AND target_id = ${input.targetId}
        AND expected_version = ${input.expectedVersion}
        AND expires_at > ${input.now}
        AND (
          (kind = 'same_person' AND requester_id = ${principalUserId}::text AND session_id = ${principalSessionId}::text)
          OR (kind <> 'same_person' AND ${principalUserId}::text IS NULL AND ${principalSessionId}::text IS NULL)
        )
      RETURNING ${this.sql.unsafe(SELECT_COLS)}
    `;
    return rows[0] ? fromDb(rows[0]) : null;
  }
}
