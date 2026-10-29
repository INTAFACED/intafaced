/**
 * Applying to lead and the founders' lead desk (CB-copy-12, CB-ops-01, J-copy-bots-otc-10).
 *
 * A customer applies under a display name; one open application per person, so a second submit answers the open one.
 * Founders read the queue oldest first. Approving needs the lead criteria (an owner value; unset refuses
 * `trade.copy_lead_criteria_unset`) and a second founder: the first files identity's action approval
 * `trade.copy_lead_approve`, bound to the application, its display name and the criteria in force, and the second
 * approves it there and confirms here, which consumes it once and lists the applicant through the operator leader
 * directory (a self-reported record, nothing computed). A rejection names its reason. Suspending a listed lead is the
 * directory's own `setLeaderState`, audited there.
 *
 * Nothing here moves money or imports a ledger write. Criteria are shown to the founders, not enforced: the applicant's
 * own track record is not measured yet, so the desk says so instead of inventing one.
 */
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  TradeOpsError,
  consumeApproval,
  payloadHash,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  writeOperatorAudit,
  type ApprovalBook,
} from '../admin/common.js';
import { CopyError } from './errors.js';
import type { LeaderDirectory } from './leader-directory.js';

export const COPY_LEAD_APPROVE_ACTION = 'trade.copy_lead_approve' as const;

export type LeadApplicationStatus = 'pending' | 'awaiting_second' | 'approved' | 'rejected';

export interface LeadCriteria {
  readonly minTrackRecordDays: number;
  readonly setBy: string;
  readonly setAt: string;
}

/** What the applicant reads of their own application. */
export interface MyLeadApplication {
  readonly applicationId: string;
  readonly state: 'submitted' | 'approved' | 'rejected';
  readonly displayName: string;
  readonly submittedAt: string;
  readonly reason: string | null;
}

export interface LeadApplicationView {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly status: LeadApplicationStatus;
  readonly appliedAt: string;
  readonly approvalId: string | null;
  readonly proposedBy: string | null;
  readonly decidedBy: string | null;
  readonly approverId: string | null;
  readonly reason: string | null;
  readonly leaderRef: string | null;
  readonly decidedAt: string | null;
}

export interface LeadListingView {
  readonly leaderRef: string;
  readonly displayName: string;
  readonly state: 'unlisted' | 'listed' | 'suspended' | 'delisted';
  readonly listedAt: string | null;
  readonly stateChangedAt: string;
}

export interface LeadAuditView {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly operatorId: string;
  readonly subject: string;
  readonly reason: string | null;
}

export interface LeadDeskDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  readonly directory: LeaderDirectory;
  readonly now: () => Date;
}

interface ApplicationRow {
  id: string;
  user_id: string;
  display_name: string;
  status: LeadApplicationStatus;
  approval_id: string | null;
  proposed_by: string | null;
  decided_by: string | null;
  approver_id: string | null;
  reason: string | null;
  leader_ref: string | null;
  created_at: Date;
  decided_at: Date | null;
}

const LIST_MAX = 200;
const NAME_MAX = 80;

/** What the approval binds: the application, the name it lists under and the criteria the founders measured it by. */
export function leadApprovalPayload(input: {
  applicationId: string;
  displayName: string;
  minTrackRecordDays: number;
}): Record<string, unknown> {
  return {
    actionType: COPY_LEAD_APPROVE_ACTION,
    applicationId: input.applicationId,
    displayName: input.displayName,
    minTrackRecordDays: input.minTrackRecordDays,
  };
}

function view(row: ApplicationRow): LeadApplicationView {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    status: row.status,
    appliedAt: row.created_at.toISOString(),
    approvalId: row.approval_id,
    proposedBy: row.proposed_by,
    decidedBy: row.decided_by,
    approverId: row.approver_id,
    reason: row.reason,
    leaderRef: row.leader_ref,
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

function mine(row: ApplicationRow): MyLeadApplication {
  return {
    applicationId: row.id,
    state: row.status === 'approved' ? 'approved' : row.status === 'rejected' ? 'rejected' : 'submitted',
    displayName: row.display_name,
    submittedAt: row.created_at.toISOString(),
    reason: row.status === 'rejected' ? row.reason : null,
  };
}

function displayNameOf(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new CopyError(`Display name is required (1–${NAME_MAX} characters)`, 'trade.copy_lead_name_invalid');
  }
  return name;
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export class LeadDesk {
  constructor(private readonly deps: LeadDeskDeps) {}

  /** The applicant's newest application, or null. */
  async mine(principal: Principal): Promise<MyLeadApplication | null> {
    const [row] = await this.deps.sql<ApplicationRow[]>`
      SELECT * FROM trade.copy_lead_applications WHERE user_id = ${principal.userId} ORDER BY created_at DESC, id DESC LIMIT 1`;
    return row ? mine(row) : null;
  }

  /**
   * Apply to lead. An open application answers itself when the name is the same and refuses when it is not; an
   * approved one refuses; after a rejection a new application waits on the owner's re-apply wait, which is unset.
   */
  async apply(principal: Principal, input: { displayName: string }): Promise<MyLeadApplication> {
    const displayName = displayNameOf(input.displayName);
    const userId = principal.userId;
    return this.deps.sql.begin(async (tx) => {
      // One applicant at a time per person: the lock key is the person, so two submits cannot both insert.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`copy-lead-apply:${userId}`}))`;
      const [latest] = await tx<ApplicationRow[]>`
        SELECT * FROM trade.copy_lead_applications WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 1`;
      if (latest && (latest.status === 'pending' || latest.status === 'awaiting_second')) {
        if (latest.display_name !== displayName) {
          throw new CopyError('An application is already waiting under another name', 'trade.copy_lead_application_open');
        }
        return mine(latest);
      }
      if (latest?.status === 'approved') throw new CopyError('You already lead', 'trade.copy_lead_already_leading');
      // A person already in the leader directory (listed, suspended or delisted there) is not listed again by an
      // application: an approval would overwrite that record and could undo a suspension.
      if (await this.inDirectory(tx, userId)) throw new CopyError('You already lead', 'trade.copy_lead_already_leading');
      // How long a rejected person waits before applying again is the owner's to set, and it is not set: blank refuses.
      if (latest?.status === 'rejected') {
        throw new CopyError('The wait before applying again is not set by the platform', 'trade.copy_lead_reapply_wait_unset');
      }
      const now = this.deps.now();
      const [row] = await tx<ApplicationRow[]>`
        INSERT INTO trade.copy_lead_applications (id, user_id, display_name, status, created_at, updated_at)
        VALUES (${randomUUID()}, ${userId}, ${displayName}, 'pending', ${now.toISOString()}, ${now.toISOString()})
        RETURNING *`;
      return mine(row!);
    });
  }

  /** Open applications oldest first, with the criteria in force (null: unset). */
  async queue(principal: Principal): Promise<{ applications: LeadApplicationView[]; criteria: LeadCriteria | null }> {
    requireOperator(principal);
    const rows = await this.deps.sql<ApplicationRow[]>`
      SELECT * FROM trade.copy_lead_applications WHERE status IN ('pending', 'awaiting_second')
      ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX}`;
    return { applications: rows.map(view), criteria: await this.criteria() };
  }

  async criteria(): Promise<LeadCriteria | null> {
    const [row] = await this.deps.sql<Array<{ min_track_record_days: number; set_by: string; created_at: Date }>>`
      SELECT min_track_record_days, set_by, created_at FROM trade.copy_lead_criteria ORDER BY created_at DESC, id DESC LIMIT 1`;
    return row ? { minTrackRecordDays: row.min_track_record_days, setBy: row.set_by, setAt: row.created_at.toISOString() } : null;
  }

  /** Set the criteria. The same request id twice is one row. */
  async setCriteria(principal: Principal, input: { minTrackRecordDays: number; clientRequestId: string }): Promise<LeadCriteria> {
    requireOperatorWrite(principal);
    const days = input.minTrackRecordDays;
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      throw new TradeOpsError('copy_lead_criteria_invalid', 'Minimum track record must be a whole number of days, 0 to 3650');
    }
    const requestId = `copy-lead-criteria:${input.clientRequestId.trim()}`;
    const now = this.deps.now();
    const inserted = await this.deps.sql`
      INSERT INTO trade.copy_lead_criteria (id, min_track_record_days, set_by, client_request_id, created_at)
      VALUES (${randomUUID()}, ${days}, ${principal.userId}, ${requestId}, ${now.toISOString()})
      ON CONFLICT (client_request_id) DO NOTHING`;
    if (inserted.count === 1) {
      await writeOperatorAudit(
        this.deps.sql,
        {
          kind: 'copy_lead.criteria',
          operatorId: principal.userId,
          accountId: null,
          objectId: requestId,
          approverId: null,
          reason: null,
          detail: { minTrackRecordDays: days },
        },
        now,
      );
    }
    const criteria = await this.criteria();
    if (!criteria) throw new TradeOpsError('copy_lead_criteria_invalid', 'criteria were not saved');
    return criteria;
  }

  /**
   * The first founder's approval: record the identity approval they filed, bound to this application now. Refuses
   * while the criteria are unset, before anything is recorded.
   */
  async propose(principal: Principal, input: { applicationId: string; approvalId: string }): Promise<LeadApplicationView> {
    requireOperatorWrite(principal);
    if (!(await this.criteria())) throw new CopyError('The lead criteria are not set', 'trade.copy_lead_criteria_unset');
    const approvalId = input.approvalId.trim();
    if (!approvalId) throw new TradeOpsError('approval_missing', 'approval is missing');
    return this.deps.sql.begin(async (tx) => {
      const row = await this.locked(tx, input.applicationId);
      if (row.status === 'awaiting_second' && row.approval_id === approvalId) return view(row);
      // A waiting application takes a newly filed approval in place of the old one (it expired, or the criteria
      // changed so the old one no longer matches); the confirm then consumes only the new one.
      if (row.status !== 'pending' && row.status !== 'awaiting_second') {
        throw new CopyError(`The application is ${row.status}`, 'trade.copy_lead_application_decided');
      }
      const now = this.deps.now();
      const [next] = await tx<ApplicationRow[]>`
        UPDATE trade.copy_lead_applications
        SET status = 'awaiting_second', approval_id = ${approvalId}, proposed_by = ${principal.userId}, updated_at = ${now.toISOString()}
        WHERE id = ${row.id} RETURNING *`;
      await writeOperatorAudit(
        tx as unknown as Sql,
        {
          id: randomUUIDFor(`propose:${row.id}:${approvalId}`),
          kind: 'copy_lead.propose',
          operatorId: principal.userId,
          accountId: row.user_id,
          objectId: row.id,
          approverId: null,
          reason: null,
          detail: { approvalId, displayName: row.display_name },
        },
        now,
      );
      return view(next!);
    });
  }

  /**
   * The second founder confirms: consume the approval once (bound to this application, name and criteria; identity
   * refuses the proposer as approver), list the applicant, and mark the application approved. Sending the same
   * approval again answers the approved application.
   */
  async approve(
    principal: Principal,
    input: { applicationId: string; approvalId: string; operationId: string },
  ): Promise<LeadApplicationView> {
    requireOperatorWrite(principal);
    const criteria = await this.criteria();
    if (!criteria) throw new CopyError('The lead criteria are not set', 'trade.copy_lead_criteria_unset');
    const approvalId = input.approvalId.trim();
    return this.deps.sql.begin(async (tx) => {
      const row = await this.locked(tx, input.applicationId);
      if (row.status === 'approved' && row.approval_id === approvalId) return view(row);
      if (row.status !== 'awaiting_second' || row.approval_id !== approvalId) {
        throw new CopyError('This application is not waiting for that approval', 'trade.copy_lead_application_decided');
      }
      if (row.proposed_by && row.proposed_by.trim().toLowerCase() === principal.userId.trim().toLowerCase()) {
        throw new TradeOpsError('approval_mismatch', 'The founder who approved first cannot confirm. A second founder must.');
      }
      // Someone already in the directory is not listed again; the one exception is this application's own listing,
      // written by an earlier confirm that stopped before it recorded the decision.
      if (await this.inDirectory(tx, row.user_id, `copy-lead-approve:${row.id}`)) {
        throw new CopyError('The applicant is already in the leader directory', 'trade.copy_lead_already_leading');
      }
      // Identity answers a retry of this same confirm (same operation) with the approval it consumed; any other use of
      // the approval is refused there, so a spent approval never lists anyone here.
      const { approverId } = await consumeApproval(this.deps.approvals, {
        approvalId,
        actionType: COPY_LEAD_APPROVE_ACTION,
        targetId: row.id,
        expectedVersion: 'pending',
        payloadHash: payloadHash(
          leadApprovalPayload({ applicationId: row.id, displayName: row.display_name, minTrackRecordDays: criteria.minTrackRecordDays }),
        ),
        operationId: input.operationId,
      });
      // The listing is idempotent on the application: a retry after a crash lists the same leader once.
      const listed = await this.deps.directory.upsertListing(principal, {
        clientRequestId: `copy-lead-approve:${row.id}`,
        leaderUserId: row.user_id,
        displayName: row.display_name,
        recordKind: 'self_reported',
        state: 'listed',
      });
      const now = this.deps.now();
      const [next] = await tx<ApplicationRow[]>`
        UPDATE trade.copy_lead_applications
        SET status = 'approved', approver_id = ${approverId}, decided_by = ${principal.userId}, leader_ref = ${listed.leaderRef},
            decided_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
        WHERE id = ${row.id} RETURNING *`;
      await writeOperatorAudit(
        tx as unknown as Sql,
        {
          id: randomUUIDFor(`approve:${row.id}`),
          kind: 'copy_lead.approve',
          operatorId: principal.userId,
          accountId: row.user_id,
          objectId: row.id,
          approverId,
          reason: null,
          detail: { approvalId, leaderRef: listed.leaderRef, displayName: row.display_name },
        },
        now,
      );
      return view(next!);
    });
  }

  /** Reject an open application with a reason the applicant reads. */
  async reject(principal: Principal, input: { applicationId: string; reason: string }): Promise<LeadApplicationView> {
    requireOperatorWrite(principal);
    const reason = requireReason(input.reason);
    return this.deps.sql.begin(async (tx) => {
      const row = await this.locked(tx, input.applicationId);
      if (row.status === 'rejected' && row.reason === reason) return view(row);
      if (row.status !== 'pending' && row.status !== 'awaiting_second') {
        throw new CopyError(`The application is ${row.status}`, 'trade.copy_lead_application_decided');
      }
      const now = this.deps.now();
      const [next] = await tx<ApplicationRow[]>`
        UPDATE trade.copy_lead_applications
        SET status = 'rejected', reason = ${reason}, decided_by = ${principal.userId}, decided_at = ${now.toISOString()},
            updated_at = ${now.toISOString()}
        WHERE id = ${row.id} RETURNING *`;
      await writeOperatorAudit(
        tx as unknown as Sql,
        {
          id: randomUUIDFor(`reject:${row.id}`),
          kind: 'copy_lead.reject',
          operatorId: principal.userId,
          accountId: row.user_id,
          objectId: row.id,
          approverId: null,
          reason,
        },
        now,
      );
      return view(next!);
    });
  }

  /** Every leader in the directory whatever its state, newest change first. */
  async leads(principal: Principal): Promise<LeadListingView[]> {
    requireOperator(principal);
    const rows = await this.deps.sql<
      Array<{ leader_ref: string; display_name: string; state: LeadListingView['state']; listed_at: Date | null; state_changed_at: Date }>
    >`
      SELECT leader_ref, display_name, state, listed_at, state_changed_at FROM trade.copy_leader_listings
      ORDER BY state_changed_at DESC, leader_ref ASC LIMIT ${LIST_MAX}`;
    return rows.map((r) => ({
      leaderRef: r.leader_ref,
      displayName: r.display_name,
      state: r.state,
      listedAt: r.listed_at?.toISOString() ?? null,
      stateChangedAt: r.state_changed_at.toISOString(),
    }));
  }

  /** The desk's audit, newest first: directory changes (listing, suspending) and lead decisions. */
  async audit(principal: Principal): Promise<LeadAuditView[]> {
    requireOperator(principal);
    const rows = await this.deps.sql<
      Array<{ id: string; at: Date; action: string; operator_id: string; subject: string; reason: string | null }>
    >`
      SELECT * FROM (
        SELECT audit_id::text AS id, occurred_at AS at, 'leader.' || action AS action, operator_id, leader_ref AS subject, reason
        FROM trade.copy_leader_listing_audit
        UNION ALL
        SELECT id::text AS id, occurred_at AS at, kind AS action, operator_id, object_id AS subject, reason
        FROM trade.operator_audit WHERE kind LIKE 'copy_lead.%'
      ) feed ORDER BY at DESC, id DESC LIMIT ${LIST_MAX}`;
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      action: r.action,
      operatorId: r.operator_id,
      subject: r.subject,
      reason: r.reason,
    }));
  }

  /** Whether the person has a leader directory record, other than one written under the request id `except`. */
  private async inDirectory(tx: TransactionSql, userId: string, except?: string): Promise<boolean> {
    const [row] = await tx<Array<{ leader_ref: string }>>`
      SELECT l.leader_ref FROM trade.copy_leader_listings l
      WHERE l.leader_user_id = ${userId}
        AND NOT EXISTS (SELECT 1 FROM trade.copy_leader_ops_requests r WHERE r.client_request_id = ${except ?? ''})
      LIMIT 1`;
    return row !== undefined;
  }

  private async locked(tx: TransactionSql, applicationId: string): Promise<ApplicationRow> {
    if (!isUuid(applicationId)) throw new CopyError('No such application', 'trade.copy_lead_application_not_found');
    const [row] = await tx<ApplicationRow[]>`
      SELECT * FROM trade.copy_lead_applications WHERE id = ${applicationId} FOR UPDATE`;
    if (!row) throw new CopyError('No such application', 'trade.copy_lead_application_not_found');
    return row;
  }
}

/** A stable audit id for a business key, so a retried decision writes its audit row once. */
function randomUUIDFor(key: string): string {
  const hex = payloadHash({ copyLeadAudit: key }).slice('sha256:'.length, 'sha256:'.length + 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
