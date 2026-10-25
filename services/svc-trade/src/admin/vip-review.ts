/**
 * Compliance review of VIP applications (SP-fees-vip-04 part 2, J-cex-spot-10 #7).
 *
 * An operator reads the applications and, with a stated reason, opens a proof file (each opening is audited). A decision
 * needs a second operator: identity's action approval `trade.vip_application_review`, bound to the application, its
 * status (`pending`), the decision, the reason and the trial the approval would grant, consumed once. Approving grants
 * the trial the owner publishes in the fee schedule (`tierProgram.trial {tierId, days}`). With none published, the
 * application is `approved_no_trial` and the grant refuses `vip.trial_unset` by name, nothing invented; once the owner
 * publishes one, `grantTrial` (its own approval, `trade.vip_trial_grant`) grants it and the application is `approved`.
 *
 * A trial is a row keyed `vip-trial:<userId>:<applicationId>`, one per application: the tier read (`feeTierAt`) charges
 * the higher of it and the person's snapshot tier while it lasts. It moves no money and no ledger write is imported.
 * The same approval sent again answers what it decided; an approval consumed for another application refuses.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import type { OwnerFeeSchedule } from '../spot/fee-schedule.js';
import type { VipTrialRules } from '../spot/fee-tiers.js';
import {
  VIEW_COLUMNS,
  openProof,
  toView,
  type ApplicationRow,
  type VipApplicationStatus,
  type VipApplicationView,
} from '../spot/vip-applications.js';
import {
  TradeOpsError,
  consumeApproval,
  payloadHash,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';

export const VIP_REVIEW_ACTION = 'trade.vip_application_review' as const;
export const VIP_TRIAL_GRANT_ACTION = 'trade.vip_trial_grant' as const;

export type VipDecision = 'approve' | 'reject';

export interface VipReviewDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  /** The proof key (`TRADE_VIP_PROOF_KEY`), or null: proofs cannot be opened (`vip.proof_key_unset`). */
  readonly proofKey: Buffer | null;
  /** The owner fee schedule in force at a time. */
  readonly scheduleAt: (at: Date) => Promise<OwnerFeeSchedule>;
  readonly now: () => Date;
}

export interface VipTrialView {
  readonly key: string;
  readonly tierId: string;
  readonly days: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly scheduleVersion: string;
  readonly grantedBy: string;
}

export interface VipEventView {
  readonly status: VipApplicationStatus;
  readonly actorId: string;
  readonly actorRole: 'applicant' | 'compliance';
  readonly approverId: string | null;
  readonly reason: string | null;
  readonly at: string;
}

/** An application as compliance reads it: whose it is, its history and its trial. Never the file. */
export interface VipReviewView extends VipApplicationView {
  readonly userId: string;
  readonly events: readonly VipEventView[];
  readonly trial: VipTrialView | null;
}

export interface VipReviewResult {
  readonly application: VipReviewView;
  /** Why an approved application has no trial (`vip.trial_unset`), or null. */
  readonly trialRefusal: 'vip.trial_unset' | null;
}

type ReviewRow = ApplicationRow & { user_id: string };

interface TrialRow {
  trial_key: string;
  application_id: string;
  tier_id: string;
  days: number;
  starts_at: Date;
  ends_at: Date;
  schedule_version: string;
  granted_by: string;
}

const LIST_MAX = 200;

/** The trial the owner publishes now, or null: none, or no programme. */
function trialRulesOf(schedule: OwnerFeeSchedule): VipTrialRules | null {
  return schedule.published === true ? (schedule.tierProgram?.trial ?? null) : null;
}

const scheduleVersionOf = (schedule: OwnerFeeSchedule): string => (schedule.published === true ? schedule.version : 'unset');

/** What the review approval binds: the decision, its reason and the trial an approval would grant. */
export function vipReviewPayload(input: {
  applicationId: string;
  decision: VipDecision;
  reason: string;
  trial: VipTrialRules | null;
}): Record<string, unknown> {
  return {
    actionType: VIP_REVIEW_ACTION,
    applicationId: input.applicationId,
    decision: input.decision,
    reason: input.reason,
    trial: input.decision === 'approve' ? input.trial : null,
  };
}

/** What the trial grant approval binds. */
export function vipTrialGrantPayload(input: { applicationId: string; reason: string; trial: VipTrialRules }): Record<string, unknown> {
  return { actionType: VIP_TRIAL_GRANT_ACTION, applicationId: input.applicationId, reason: input.reason, trial: input.trial };
}

export class VipReviewAdmin {
  constructor(private readonly deps: VipReviewDeps) {}

  /** Applications newest first, optionally by status, with the trial the owner publishes now and whether proofs open. */
  async list(
    principal: Principal,
    input: { status?: VipApplicationStatus | null; limit?: number },
  ): Promise<{ applications: VipReviewView[]; trialRules: VipTrialRules | null; proofKeyed: boolean }> {
    requireOperator(principal);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), LIST_MAX);
    const status = input.status ?? null;
    const rows = await this.deps.sql<ReviewRow[]>`
      SELECT ${this.deps.sql.unsafe(VIEW_COLUMNS)}, user_id::text AS user_id FROM trade.vip_applications
       ${status ? this.deps.sql`WHERE status = ${status}` : this.deps.sql``}
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    const schedule = await this.deps.scheduleAt(this.deps.now());
    return { applications: await this.present(rows), trialRules: trialRulesOf(schedule), proofKeyed: this.deps.proofKey !== null };
  }

  /** One application's proof file, opened for a stated reason. Every opening is audited. */
  async proof(
    principal: Principal,
    input: { applicationId: string; reason: string },
  ): Promise<{ fileName: string; contentType: string; sha256: string; bytesBase64: string }> {
    requireOperator(principal);
    const reason = requireReason(input.reason);
    const key = this.deps.proofKey;
    if (!key) throw new TradeOpsError('vip.proof_key_unset', 'the proof file key is not set, so no proof can be opened');
    const [row] = await this.deps.sql<
      Array<{
        id: string;
        user_id: string;
        proof_file_name: string;
        proof_content_type: string;
        proof_sha256: string;
        proof_ciphertext: Buffer;
        proof_nonce: Buffer;
      }>
    >`
      SELECT id, user_id::text AS user_id, proof_file_name, proof_content_type, proof_sha256, proof_ciphertext, proof_nonce
        FROM trade.vip_applications WHERE id = ${input.applicationId}`;
    if (!row) throw new TradeOpsError('vip_application_not_found', 'no such application');
    let bytes: Buffer;
    try {
      bytes = openProof(key, { id: row.id, sha256: row.proof_sha256, ciphertext: row.proof_ciphertext, nonce: row.proof_nonce });
    } catch {
      throw new TradeOpsError('vip.proof_unreadable', 'the proof file does not open with the key set, or does not match its digest');
    }
    await writeOperatorAudit(
      this.deps.sql,
      {
        kind: 'vip_application.proof_view',
        operatorId: principal.userId,
        accountId: row.user_id,
        objectId: row.id,
        approverId: null,
        reason,
        detail: { sha256: row.proof_sha256 },
      },
      this.deps.now(),
    );
    return {
      fileName: row.proof_file_name,
      contentType: row.proof_content_type,
      sha256: row.proof_sha256,
      bytesBase64: bytes.toString('base64'),
    };
  }

  /**
   * Decide a pending application with a second operator's approval. Approve grants the trial the owner publishes, or
   * leaves the application `approved_no_trial` and says `vip.trial_unset`. The same approval again answers the decision.
   */
  async review(
    principal: Principal,
    input: { applicationId: string; decision: VipDecision; reason: string; approvalId: string; operationId: string },
  ): Promise<VipReviewResult> {
    requireOperatorWrite(principal);
    const reason = requireReason(input.reason);
    const replay = await this.replay(input.approvalId, input.applicationId);
    if (replay) return replay;
    const current = await this.row(input.applicationId);
    if (current.status !== 'pending') {
      throw new TradeOpsError('vip.application_decided', `the application is ${current.status}, not waiting for review`);
    }
    const at = this.deps.now();
    const schedule = await this.deps.scheduleAt(at);
    const trial = input.decision === 'approve' ? trialRulesOf(schedule) : null;
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType: VIP_REVIEW_ACTION,
      targetId: input.applicationId,
      expectedVersion: 'pending',
      payloadHash: payloadHash(vipReviewPayload({ applicationId: input.applicationId, decision: input.decision, reason, trial })),
      operationId: input.operationId,
    });
    this.twoPeople(principal, consumed.approverId);
    const status: VipApplicationStatus = input.decision === 'reject' ? 'rejected' : trial ? 'approved' : 'approved_no_trial';
    await this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const [locked] = await q<Array<{ status: VipApplicationStatus }>>`
        SELECT status FROM trade.vip_applications WHERE id = ${input.applicationId} FOR UPDATE`;
      if (locked?.status !== 'pending') {
        throw new TradeOpsError('vip.application_decided', `the application is ${locked?.status ?? 'gone'}, not waiting for review`);
      }
      await q`UPDATE trade.vip_applications SET status = ${status}, updated_at = ${at.toISOString()} WHERE id = ${input.applicationId}`;
      await q`
        INSERT INTO trade.vip_application_events (application_id, status, actor_id, actor_role, reason, approver_id, approval_id, created_at)
        VALUES (${input.applicationId}, ${status}, ${principal.userId}, 'compliance', ${reason}, ${consumed.approverId},
                ${input.approvalId}, ${at.toISOString()})`;
      if (trial) await this.insertTrial(q, current.user_id, input.applicationId, trial, scheduleVersionOf(schedule), principal.userId, at);
      await writeOperatorAudit(
        q,
        {
          kind: 'vip_application.review',
          operatorId: principal.userId,
          accountId: current.user_id,
          objectId: input.applicationId,
          approverId: consumed.approverId,
          reason,
          detail: { decision: input.decision, status, trial },
        },
        at,
      );
    });
    return this.result(input.applicationId);
  }

  /**
   * Grant the trial the owner now publishes to an application approved while none was (`approved_no_trial`), with a
   * second operator's approval. Still none published: refuses `vip.trial_unset` and the application stays as it is.
   */
  async grantTrial(
    principal: Principal,
    input: { applicationId: string; reason: string; approvalId: string; operationId: string },
  ): Promise<VipReviewResult> {
    requireOperatorWrite(principal);
    const reason = requireReason(input.reason);
    const replay = await this.replay(input.approvalId, input.applicationId);
    if (replay) return replay;
    const current = await this.row(input.applicationId);
    if (current.status !== 'approved_no_trial') {
      throw new TradeOpsError(
        'vip.trial_not_owed',
        `the application is ${current.status}: only one approved without a trial is granted one`,
      );
    }
    const at = this.deps.now();
    const schedule = await this.deps.scheduleAt(at);
    const trial = trialRulesOf(schedule);
    if (!trial) {
      throw new TradeOpsError('vip.trial_unset', 'the owner has not published a VIP trial (tier and days), so none can be granted');
    }
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType: VIP_TRIAL_GRANT_ACTION,
      targetId: input.applicationId,
      expectedVersion: 'approved_no_trial',
      payloadHash: payloadHash(vipTrialGrantPayload({ applicationId: input.applicationId, reason, trial })),
      operationId: input.operationId,
    });
    this.twoPeople(principal, consumed.approverId);
    await this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const [locked] = await q<Array<{ status: VipApplicationStatus }>>`
        SELECT status FROM trade.vip_applications WHERE id = ${input.applicationId} FOR UPDATE`;
      if (locked?.status !== 'approved_no_trial') {
        throw new TradeOpsError('vip.trial_not_owed', `the application is ${locked?.status ?? 'gone'}: it is not owed a trial`);
      }
      await this.insertTrial(q, current.user_id, input.applicationId, trial, scheduleVersionOf(schedule), principal.userId, at);
      await q`UPDATE trade.vip_applications SET status = 'approved', updated_at = ${at.toISOString()} WHERE id = ${input.applicationId}`;
      await q`
        INSERT INTO trade.vip_application_events (application_id, status, actor_id, actor_role, reason, approver_id, approval_id, created_at)
        VALUES (${input.applicationId}, 'approved', ${principal.userId}, 'compliance', ${reason}, ${consumed.approverId},
                ${input.approvalId}, ${at.toISOString()})`;
      await writeOperatorAudit(
        q,
        {
          kind: 'vip_application.trial_grant',
          operatorId: principal.userId,
          accountId: current.user_id,
          objectId: input.applicationId,
          approverId: consumed.approverId,
          reason,
          detail: { trial },
        },
        at,
      );
    });
    return this.result(input.applicationId);
  }

  /** The approver may not also be the one who applies it: two people, or the approval proves nothing. */
  private twoPeople(principal: Principal, approverId: string): void {
    if (approverId.trim().toLowerCase() === principal.userId.trim().toLowerCase()) {
      throw new TradeOpsError('approval_mismatch', 'the operator who approved this cannot also apply it');
    }
  }

  /** The decision an approval already made for this application, or null; one made for another refuses. */
  private async replay(approvalId: string, applicationId: string): Promise<VipReviewResult | null> {
    const [event] = await this.deps.sql<Array<{ application_id: string }>>`
      SELECT application_id::text AS application_id FROM trade.vip_application_events WHERE approval_id = ${approvalId}`;
    if (!event) return null;
    if (event.application_id !== applicationId) throw new TradeOpsError('approval_reused', 'approval was already consumed');
    return this.result(applicationId);
  }

  private async insertTrial(
    q: Sql,
    userId: string,
    applicationId: string,
    trial: VipTrialRules,
    scheduleVersion: string,
    grantedBy: string,
    at: Date,
  ): Promise<void> {
    // The tier is one the programme names above regular (fee-tiers.ts refuses any other); the row id is not a key, the
    // trial is keyed by `trial_key`, one per application.
    await q`
      INSERT INTO trade.vip_trials (id, trial_key, user_id, application_id, tier_id, days, starts_at, ends_at, schedule_version, granted_by)
      VALUES (${randomUUID()}, ${`vip-trial:${userId}:${applicationId}`}, ${userId}, ${applicationId}, ${trial.tierId}, ${trial.days},
              ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz + make_interval(days => ${trial.days}::int),
              ${scheduleVersion}, ${grantedBy})`;
  }

  private async row(applicationId: string): Promise<ReviewRow> {
    const [row] = await this.deps.sql<ReviewRow[]>`
      SELECT ${this.deps.sql.unsafe(VIEW_COLUMNS)}, user_id::text AS user_id FROM trade.vip_applications WHERE id = ${applicationId}`;
    if (!row) throw new TradeOpsError('vip_application_not_found', 'no such application');
    return row;
  }

  private async result(applicationId: string): Promise<VipReviewResult> {
    const [application] = await this.present([await this.row(applicationId)]);
    return { application: application!, trialRefusal: application!.status === 'approved_no_trial' ? 'vip.trial_unset' : null };
  }

  private async present(rows: readonly ReviewRow[]): Promise<VipReviewView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [events, trials] = await Promise.all([
      this.deps.sql<
        Array<{
          application_id: string;
          status: VipApplicationStatus;
          actor_id: string;
          actor_role: 'applicant' | 'compliance';
          approver_id: string | null;
          reason: string | null;
          created_at: Date;
        }>
      >`
        SELECT application_id::text AS application_id, status, actor_id, actor_role, approver_id, reason, created_at
          FROM trade.vip_application_events WHERE application_id IN ${this.deps.sql(ids)} ORDER BY id`,
      this.deps.sql<TrialRow[]>`
        SELECT trial_key, application_id::text AS application_id, tier_id, days, starts_at, ends_at, schedule_version, granted_by
          FROM trade.vip_trials WHERE application_id IN ${this.deps.sql(ids)}`,
    ]);
    return rows.map((row) => {
      const trial = trials.find((t) => t.application_id === row.id);
      return {
        ...toView(row),
        userId: row.user_id,
        events: events
          .filter((event) => event.application_id === row.id)
          .map((event) => ({
            status: event.status,
            actorId: event.actor_id,
            actorRole: event.actor_role,
            approverId: event.approver_id,
            reason: event.reason,
            at: event.created_at.toISOString(),
          })),
        trial: trial
          ? {
              key: trial.trial_key,
              tierId: trial.tier_id,
              days: trial.days,
              startsAt: trial.starts_at.toISOString(),
              endsAt: trial.ends_at.toISOString(),
              scheduleVersion: trial.schedule_version,
              grantedBy: trial.granted_by,
            }
          : null,
      };
    });
  }
}
