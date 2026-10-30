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
  /** Set when a consume names its caller. Null on rows consumed before provenance existed. */
  readonly consumedByService?: string | null;
  readonly consumedByPrincipal?: string | null;
  readonly consumedRequestId?: string | null;
  /** Absent means `four_eyes`. */
  readonly kind?: ActionApprovalKind;
  /** Session a `same_person` row is bound to. Null/absent for four-eyes rows. */
  readonly sessionId?: string | null;
  /**
   * Policy-governed rows only (OPS-change-control-01 CR-1): distinct approvers other than the requester needed before the
   * row is APPROVED, and the version of the owner policy row it was proposed under. Null/absent on every other row, which
   * keeps the fixed one-approver rule.
   */
  readonly approvalsRequired?: number | null;
  readonly policyHash?: string | null;
  /** Distinct non-requester approvals recorded so far. 0 on rows that are not governed. */
  readonly approvalsGiven?: number;
};

/** One recorded approval of a governed row. */
export type ApprovalVote = { readonly approverId: string; readonly approvedAt: Date };

/**
 * Outcome of one approver's vote on a governed row. `recorded` carries the row after the vote: still PENDING below the
 * required count, APPROVED at it. `already_approved` is this approver a second time; `not_pending` covers a missing,
 * decided, expired, ungoverned row or the requester voting.
 */
export type VoteResult =
  | { readonly kind: 'recorded'; readonly row: StoredApproval }
  | { readonly kind: 'already_approved' }
  | { readonly kind: 'not_pending' };

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
  /** Provenance. Absent request id leaves the three columns null (one-shot consume). */
  readonly requestId?: string | null;
  readonly consumedByService?: string | null;
  readonly consumedByPrincipal?: string | null;
};

export interface ActionApprovalStore {
  insert(row: StoredApproval): Promise<StoredApproval>;
  get(approvalId: string): Promise<StoredApproval | null>;
  /** Newest first. The caller's own rows, any status. */
  listByRequester(requesterId: string, limit: number): Promise<StoredApproval[]>;
  /** Newest first. PENDING rows somebody else filed. Audience filtering is the service's job. */
  listPendingExcept(requesterId: string, limit: number): Promise<StoredApproval[]>;
  casExpire(approvalId: string, now: Date): Promise<StoredApproval | null>;
  /** The fixed one-approver rule. Never approves a governed row (it has `approvalsRequired`). */
  casApprove(approvalId: string, approverId: string, now: Date): Promise<StoredApproval | null>;
  /**
   * One approver's vote on a governed row, atomically: the row is locked, the vote recorded once per person, the distinct
   * non-requester votes counted, and the row turned APPROVED (approver = the person whose vote reached the count) when
   * the count reaches `approvalsRequired`. Concurrent votes are serialised on the row, so the count is exact.
   */
  casVote(approvalId: string, approverId: string, now: Date): Promise<VoteResult>;
  /** Recorded votes of one row, oldest first. Empty for a row that is not governed. */
  listVotes(approvalId: string): Promise<ApprovalVote[]>;
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
    ...(row.approvalsRequired != null ? { approvalsRequired: row.approvalsRequired, approvalsGiven: row.approvalsGiven ?? 0 } : {}),
  };
}

/** Consume provenance for a reader who is allowed to see it. Omitted when the row has none. */
export function approvalProvenance(row: StoredApproval): {
  consumedAt?: string;
  consumedByRequestId?: string;
} {
  return {
    ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}),
    ...(row.consumedRequestId ? { consumedByRequestId: row.consumedRequestId } : {}),
  };
}

export class MemoryActionApprovalStore implements ActionApprovalStore {
  private readonly rows = new Map<string, StoredApproval>();
  private readonly votes = new Map<string, ApprovalVote[]>();

  async insert(row: StoredApproval): Promise<StoredApproval> {
    if (this.rows.has(row.approvalId)) throw new Error('action_approval.duplicate');
    this.rows.set(row.approvalId, row);
    return row;
  }

  async get(approvalId: string): Promise<StoredApproval | null> {
    return this.rows.get(approvalId) ?? null;
  }

  async listByRequester(requesterId: string, limit: number): Promise<StoredApproval[]> {
    return [...this.rows.values()]
      .filter((row) => row.requesterId === requesterId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.approvalId.localeCompare(b.approvalId))
      .slice(0, limit);
  }

  async listPendingExcept(requesterId: string, limit: number): Promise<StoredApproval[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === 'PENDING' && row.requesterId !== requesterId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.approvalId.localeCompare(b.approvalId))
      .slice(0, limit);
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
    if (row.approvalsRequired != null) return null;
    if (row.requesterId === approverId) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    const next: StoredApproval = { ...row, status: 'APPROVED', approverId, approvedAt: now };
    this.rows.set(approvalId, next);
    return next;
  }

  async casVote(approvalId: string, approverId: string, now: Date): Promise<VoteResult> {
    const row = this.rows.get(approvalId);
    if (!row || row.status !== 'PENDING' || row.approvalsRequired == null) return { kind: 'not_pending' };
    if (row.requesterId.toLowerCase() === approverId.toLowerCase()) return { kind: 'not_pending' };
    if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'not_pending' };
    const votes = this.votes.get(approvalId) ?? [];
    if (votes.some((v) => v.approverId.toLowerCase() === approverId.toLowerCase())) return { kind: 'already_approved' };
    const nextVotes = [...votes, { approverId, approvedAt: now }];
    this.votes.set(approvalId, nextVotes);
    const given = nextVotes.filter((v) => v.approverId.toLowerCase() !== row.requesterId.toLowerCase()).length;
    const reached = given >= row.approvalsRequired;
    const next: StoredApproval = reached
      ? { ...row, approvalsGiven: given, status: 'APPROVED', approverId, approvedAt: now }
      : { ...row, approvalsGiven: given };
    this.rows.set(approvalId, next);
    return { kind: 'recorded', row: next };
  }

  async listVotes(approvalId: string): Promise<ApprovalVote[]> {
    return [...(this.votes.get(approvalId) ?? [])];
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
    if (row.approvalsRequired != null) {
      const given = (this.votes.get(row.approvalId) ?? []).filter((v) => v.approverId.toLowerCase() !== row.requesterId.toLowerCase());
      if (given.length < row.approvalsRequired) return null;
    }
    const next: StoredApproval = {
      ...row,
      status: 'CONSUMED',
      consumedAt: input.now,
      consumedByService: input.consumedByService ?? null,
      consumedByPrincipal: input.consumedByPrincipal ?? null,
      consumedRequestId: input.requestId ?? null,
    };
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
  consumed_by_service: string | null;
  consumed_by_principal: string | null;
  consumed_request_id: string | null;
  kind: ActionApprovalKind;
  session_id: string | null;
  approvals_required: number | null;
  approvals_given: number;
  policy_hash: string | null;
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
    consumedByService: row.consumed_by_service,
    consumedByPrincipal: row.consumed_by_principal,
    consumedRequestId: row.consumed_request_id,
    kind: row.kind,
    sessionId: row.session_id,
    approvalsRequired: row.approvals_required,
    approvalsGiven: row.approvals_given,
    policyHash: row.policy_hash,
  };
}

const SELECT_COLS = `approval_id, action_type, target_service, target_id, expected_version, payload_hash,
  requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at, consumed_at,
  consumed_by_service, consumed_by_principal, consumed_request_id, kind, session_id,
  approvals_required, approvals_given, policy_hash`;

export class SqlActionApprovalStore implements ActionApprovalStore {
  constructor(private readonly sql: Sql) {}

  async insert(row: StoredApproval): Promise<StoredApproval> {
    const saved = await this.sql<DbRow[]>`
      INSERT INTO action_approvals (
        approval_id, action_type, target_service, target_id, expected_version, payload_hash,
        requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at, consumed_at,
        kind, session_id, approvals_required, policy_hash
      ) VALUES (
        ${row.approvalId}, ${row.actionType}, ${row.targetService}, ${row.targetId}, ${row.expectedVersion}, ${row.payloadHash},
        ${row.requesterId}, ${row.approverId}, ${row.policyVersion}, ${row.operationId}, ${row.status},
        ${row.createdAt}, ${row.expiresAt}, ${row.approvedAt}, ${row.consumedAt},
        ${row.kind ?? 'four_eyes'}, ${row.sessionId ?? null}, ${row.approvalsRequired ?? null}, ${row.policyHash ?? null}
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

  async listByRequester(requesterId: string, limit: number): Promise<StoredApproval[]> {
    const rows = await this.sql<DbRow[]>`
      SELECT ${this.sql.unsafe(SELECT_COLS)} FROM action_approvals
      WHERE requester_id = ${requesterId}
      ORDER BY created_at DESC, approval_id ASC
      LIMIT ${limit}
    `;
    return rows.map(fromDb);
  }

  async listPendingExcept(requesterId: string, limit: number): Promise<StoredApproval[]> {
    const rows = await this.sql<DbRow[]>`
      SELECT ${this.sql.unsafe(SELECT_COLS)} FROM action_approvals
      WHERE status = 'PENDING' AND requester_id <> ${requesterId}
      ORDER BY created_at DESC, approval_id ASC
      LIMIT ${limit}
    `;
    return rows.map(fromDb);
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
        AND approvals_required IS NULL
        AND requester_id <> ${approverId}
        AND expires_at > ${now}
      RETURNING ${this.sql.unsafe(SELECT_COLS)}
    `;
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async casVote(approvalId: string, approverId: string, now: Date): Promise<VoteResult> {
    return this.sql.begin(async (tx): Promise<VoteResult> => {
      // The row lock serialises every vote on this request, so two approvers at once are counted exactly.
      const locked = await tx<DbRow[]>`
        SELECT ${tx.unsafe(SELECT_COLS)} FROM action_approvals WHERE approval_id = ${approvalId} FOR UPDATE
      `;
      const row = locked[0];
      if (
        !row ||
        row.status !== 'PENDING' ||
        row.approvals_required === null ||
        row.requester_id.toLowerCase() === approverId.toLowerCase() ||
        new Date(row.expires_at).getTime() <= now.getTime()
      ) {
        return { kind: 'not_pending' };
      }
      const inserted = await tx<{ approval_id: string }[]>`
        INSERT INTO action_approval_votes (approval_id, approver_id, approved_at)
        VALUES (${approvalId}, ${approverId}, ${now})
        ON CONFLICT DO NOTHING
        RETURNING approval_id
      `;
      if (!inserted[0]) return { kind: 'already_approved' };
      const updated = await tx<DbRow[]>`
        WITH given AS (
          SELECT count(*)::int AS n FROM action_approval_votes v
          WHERE v.approval_id = ${approvalId} AND lower(v.approver_id) <> lower(${row.requester_id})
        )
        UPDATE action_approvals a
        SET approvals_given = given.n,
            status = CASE WHEN given.n >= a.approvals_required THEN 'APPROVED' ELSE a.status END,
            approver_id = CASE WHEN given.n >= a.approvals_required THEN ${approverId} ELSE a.approver_id END,
            approved_at = CASE WHEN given.n >= a.approvals_required THEN ${now}::timestamptz ELSE a.approved_at END
        FROM given
        WHERE a.approval_id = ${approvalId} AND a.status = 'PENDING'
        RETURNING ${tx.unsafe(SELECT_COLS)}
      `;
      if (!updated[0]) return { kind: 'not_pending' };
      return { kind: 'recorded', row: fromDb(updated[0]) };
    });
  }

  async listVotes(approvalId: string): Promise<ApprovalVote[]> {
    const rows = await this.sql<{ approver_id: string; approved_at: Date }[]>`
      SELECT approver_id, approved_at FROM action_approval_votes
      WHERE approval_id = ${approvalId}
      ORDER BY approved_at ASC, approver_id ASC
    `;
    return rows.map((r) => ({
      approverId: r.approver_id,
      approvedAt: r.approved_at instanceof Date ? r.approved_at : new Date(r.approved_at),
    }));
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
    return sqlCasConsume(this.sql, input);
  }
}

/** Lock the row in the caller's transaction before deciding whether it may be consumed. */
export async function sqlGetApprovalForUpdate(sql: Sql, approvalId: string): Promise<StoredApproval | null> {
  const rows = await sql<DbRow[]>`
    SELECT ${sql.unsafe(SELECT_COLS)} FROM action_approvals WHERE approval_id = ${approvalId} LIMIT 1 FOR UPDATE
  `;
  return rows[0] ? fromDb(rows[0]) : null;
}

/** Consume on the given connection, so a caller can use the same transaction as its own write. */
export async function sqlCasConsume(sql: Sql, input: ConsumeCas): Promise<StoredApproval | null> {
  const principalUserId = input.principalUserId ?? null;
  const principalSessionId = input.principalSessionId ?? null;
  const requestId = input.requestId ?? null;
  const consumedByService = requestId === null ? null : (input.consumedByService ?? null);
  const consumedByPrincipal = requestId === null ? null : (input.consumedByPrincipal ?? null);
  const rows = await sql<DbRow[]>`
    UPDATE action_approvals
    SET status = 'CONSUMED',
        consumed_at = ${input.now},
        consumed_by_service = ${consumedByService},
        consumed_by_principal = ${consumedByPrincipal},
        consumed_request_id = ${requestId}
    WHERE approval_id = ${input.approvalId}
      AND status = 'APPROVED'
      AND operation_id = ${input.operationId}
      AND payload_hash = ${input.payloadHash}
      AND target_service = ${input.targetService}
      AND target_id = ${input.targetId}
      AND expected_version = ${input.expectedVersion}
      AND expires_at > ${input.now}
      AND (
        approvals_required IS NULL
        OR (
          SELECT count(*) FROM action_approval_votes v
          WHERE v.approval_id = action_approvals.approval_id AND lower(v.approver_id) <> lower(action_approvals.requester_id)
        ) >= approvals_required
      )
      AND (
        (kind = 'same_person' AND requester_id = ${principalUserId}::text AND session_id = ${principalSessionId}::text)
        OR (kind <> 'same_person' AND ${principalUserId}::text IS NULL AND ${principalSessionId}::text IS NULL)
      )
    RETURNING ${sql.unsafe(SELECT_COLS)}
  `;
  return rows[0] ? fromDb(rows[0]) : null;
}
