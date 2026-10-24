/**
 * Reviewed rebind (CM-referral-01, ENGINE RF-3; J-campaigns-05 #5 and #6).
 *
 * A person who can no longer attach a referrer through a link (their attach window is closed or unset, or they already
 * have a referrer) asks for a change, with a reason. Identity files a four-eyes action approval of type
 * `referral.rebind` with the person as requester, so the person can never approve it (`action_approval.same_person`
 * for anyone who is both). An operator who is a different person approves or rejects it; approval is consumed once
 * (request id `referral.rebind:<request>`) and changes the relationship from that time on. Stored accruals are not
 * touched: an accrual names its beneficiary when it is written. The request row is the audit record of who asked, why,
 * who decided, why, and when it applied.
 *
 * Crash points: a request saved before its approval was filed is filed on the person's next ask; an approval consumed
 * before the relationship changed is replayed by the same request id on the next decide, which then applies.
 */

import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { ActionApprovalError, type ActionApprovalService } from '../auth/action-approval-service.js';
import { identityActionPayloadHash } from '../auth/privileged-dual-control.js';
import { attachWindowStatus } from './attach-window.js';
import { REFERRAL_GRAPH_LOCK_CLASS, REFERRAL_GRAPH_LOCK_OBJ } from './referral-service.js';
import { DEFAULT_MAX_REFERRAL_DEPTH, ReferralError, chainDepth, chainHasCycle, wouldCreateCycle } from './referral-tree.js';

export const REFERRAL_REBIND_ACTION_TYPE = 'referral.rebind';
const TARGET_SERVICE = 'svc-identity';
const POLICY_VERSION = 'CM-referral-01';

export type RebindState = 'submitted' | 'under_review' | 'approved' | 'rejected' | 'withdrawn' | 'expired';

export type RebindRequest = {
  readonly id: string;
  readonly userId: string;
  readonly fromReferrerId: string | null;
  readonly toReferrerId: string;
  readonly reason: string;
  readonly state: RebindState;
  readonly approvalId: string | null;
  readonly approvalExpiresAt: Date | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly appliedAt: Date | null;
};

type Row = {
  id: string;
  user_id: string;
  from_referrer_id: string | null;
  to_referrer_id: string;
  reason: string;
  state: RebindState;
  approval_id: string | null;
  approval_operation_id: string | null;
  approval_expires_at: Date | null;
  decided_by: string | null;
  decision_reason: string | null;
  created_at: Date;
  decided_at: Date | null;
  applied_at: Date | null;
};

const toRequest = (r: Row): RebindRequest => ({
  id: r.id,
  userId: r.user_id,
  fromReferrerId: r.from_referrer_id,
  toReferrerId: r.to_referrer_id,
  reason: r.reason,
  state: r.state,
  approvalId: r.approval_id,
  approvalExpiresAt: r.approval_expires_at,
  decidedBy: r.decided_by,
  decisionReason: r.decision_reason,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  appliedAt: r.applied_at,
});

const targetIdOf = (id: string) => `${REFERRAL_REBIND_ACTION_TYPE}:${id}`;
/** What the approver signs off on: this person, moving from this referrer (or none) to that one. */
export const rebindPayloadHash = (r: Pick<Row, 'id' | 'user_id' | 'from_referrer_id' | 'to_referrer_id'>) =>
  identityActionPayloadHash(targetIdOf(r.id), {
    userId: r.user_id,
    fromReferrerId: r.from_referrer_id ?? '',
    toReferrerId: r.to_referrer_id,
  });
const STALE_REASON = 'The referrer changed after this request was made; nothing changed. Ask again if still needed.';

const OPEN: readonly RebindState[] = ['submitted', 'under_review'];

export class ReferralRebindService {
  constructor(
    private readonly sql: Sql,
    private readonly approvals: Pick<ActionApprovalService, 'propose' | 'approve' | 'reject' | 'revoke' | 'consume'>,
    private readonly options: { readonly attachWindowSeconds: number | undefined; readonly maxDepth?: number },
  ) {}

  private get maxDepth(): number {
    return this.options.maxDepth ?? DEFAULT_MAX_REFERRAL_DEPTH;
  }

  /** Refuses a new parent that would close a cycle or pass the depth cap, judged without the person's current edge. */
  private assertFits(parent: Map<string, string>, userId: string, toReferrerId: string): void {
    const without = new Map(parent);
    without.delete(userId);
    if (wouldCreateCycle(without, userId, toReferrerId)) {
      throw new ReferralError('Referral would create a cycle', 'referral.cycle');
    }
    const depth = chainDepth(without, toReferrerId);
    if (depth + 1 > this.maxDepth) {
      throw new ReferralError(`Referral depth exceeds max ${this.maxDepth} (referrer chain is already ${depth})`, 'referral.depth');
    }
  }

  private async parentMap(sql: Sql): Promise<Map<string, string>> {
    const rows = await sql<Array<{ user_id: string; referrer_id: string }>>`SELECT user_id, referrer_id FROM referral_edges`;
    return new Map(rows.map((r) => [r.user_id, r.referrer_id]));
  }

  private async load(sql: Sql, id: string): Promise<Row | null> {
    const rows = await sql<Row[]>`SELECT * FROM referral_rebind_requests WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  /** The stored approval's status and decider (identity's own table), or null. */
  private async approvalOf(approvalId: string): Promise<{ status: string; approver_id: string | null } | null> {
    const rows = await this.sql<Array<{ status: string; approver_id: string | null }>>`
      SELECT status, approver_id FROM action_approvals WHERE approval_id = ${approvalId}
    `;
    return rows[0] ?? null;
  }

  /**
   * Marks a person's open requests whose review time lapsed as expired, so they may ask again. A request whose approval
   * was already consumed is not lapsed: its change is applied by the next decide.
   */
  private async expireLapsed(sql: Sql, userId: string): Promise<void> {
    await sql`
      UPDATE referral_rebind_requests r SET state = 'expired', decided_at = now()
      WHERE r.user_id = ${userId} AND r.state = 'under_review' AND r.approval_expires_at <= now()
        AND NOT EXISTS (SELECT 1 FROM action_approvals a WHERE a.approval_id = r.approval_id AND a.status = 'CONSUMED')
    `;
  }

  /**
   * Files the four-eyes approval for a saved request and moves it to review, holding the row so two asks cannot file
   * two approvals. A typed refusal from the approval service (for example its lifetime unset) removes the saved request,
   * so nothing is left behind; any other failure leaves it saved, and the person's next ask files it.
   */
  private async file(id: string): Promise<Row> {
    let refused: ActionApprovalError | null = null;
    const filed = await transaction(
      this.sql,
      async (tx) => {
        const [row] = await tx<Row[]>`SELECT * FROM referral_rebind_requests WHERE id = ${id} FOR UPDATE`;
        if (!row || row.state !== 'submitted' || row.approval_id) return row ?? null;
        let approval;
        try {
          approval = await this.approvals.propose(row.user_id, {
            actionType: REFERRAL_REBIND_ACTION_TYPE,
            targetService: TARGET_SERVICE,
            targetId: targetIdOf(row.id),
            expectedVersion: '1',
            payloadHash: rebindPayloadHash(row),
            policyVersion: POLICY_VERSION,
          });
        } catch (err) {
          if (!(err instanceof ActionApprovalError)) throw err;
          await tx`DELETE FROM referral_rebind_requests WHERE id = ${id}`;
          refused = err;
          return null;
        }
        const [next] = await tx<Row[]>`
          UPDATE referral_rebind_requests
          SET state = 'under_review', approval_id = ${approval.approvalId}, approval_operation_id = ${approval.operationId},
              approval_expires_at = ${new Date(approval.expiresAt)}
          WHERE id = ${id}
          RETURNING *
        `;
        return next!;
      },
      { isolation: 'read committed', maxAttempts: 1 },
    );
    if (refused) throw refused;
    if (!filed) throw new ReferralError('No such referrer change request', 'referral.rebind_not_found');
    return filed;
  }

  /** Closes a request whose starting referrer no longer holds; the reviewer approved a change from someone else. */
  private async markStale(requestId: string): Promise<void> {
    await this.sql`
      UPDATE referral_rebind_requests SET state = 'expired', decision_reason = ${STALE_REASON}, decided_at = now()
      WHERE id = ${requestId} AND state = 'under_review'
    `;
  }

  /** The person asks to be attached to `toReferrerId`. Asking again for the same referrer returns the open request. */
  async request(userId: string, toReferrerId: string, reason: string): Promise<RebindRequest> {
    const why = reason.trim();
    if (why.length < 3 || why.length > 500) throw new ReferralError('A reason of 3 to 500 characters is required', 'referral.invalid');
    if (userId === toReferrerId) throw new ReferralError('Self-referral is refused', 'referral.self');

    const saved = await transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${REFERRAL_GRAPH_LOCK_CLASS}, ${REFERRAL_GRAPH_LOCK_OBJ})`;
        const users = await tx<Array<{ id: string; created_at: Date; now: Date }>>`
          SELECT id, created_at, now() AS now FROM users WHERE id IN (${userId}, ${toReferrerId})
        `;
        const me = users.find((u) => u.id === userId);
        if (!me || !users.some((u) => u.id === toReferrerId)) {
          throw new ReferralError('Referrer is not a known user', 'referral.unknown_referrer');
        }
        await this.expireLapsed(tx, userId);
        const [open] = await tx<Row[]>`
          SELECT * FROM referral_rebind_requests WHERE user_id = ${userId} AND state IN ${tx(OPEN)}
        `;
        if (open) {
          if (open.to_referrer_id === toReferrerId) return open;
          throw new ReferralError('A referrer change request is already open for this account', 'referral.rebind_open');
        }
        const parent = await this.parentMap(tx);
        const current = parent.get(userId) ?? null;
        if (current === toReferrerId) throw new ReferralError('Referral already set for this user', 'referral.already_set');
        if (current === null && attachWindowStatus(me.created_at, this.options.attachWindowSeconds, me.now).state === 'open') {
          throw new ReferralError(
            'The attach window is still open; attach through the invitation link instead',
            'referral.rebind_not_needed',
          );
        }
        this.assertFits(parent, userId, toReferrerId);
        const [row] = await tx<Row[]>`
          INSERT INTO referral_rebind_requests (id, user_id, from_referrer_id, to_referrer_id, reason, state)
          VALUES (${randomUUID()}, ${userId}, ${current}, ${toReferrerId}, ${why}, 'submitted')
          RETURNING *
        `;
        return row!;
      },
      { isolation: 'read committed', maxAttempts: 10 },
    );
    return toRequest(saved.state === 'submitted' && !saved.approval_id ? await this.file(saved.id) : saved);
  }

  /** The person's latest request, or null. */
  async latestOf(userId: string): Promise<RebindRequest | null> {
    await this.expireLapsed(this.sql, userId);
    const rows = await this.sql<Row[]>`
      SELECT * FROM referral_rebind_requests WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0] ? toRequest(rows[0]) : null;
  }

  /** Requests waiting for a second person, oldest first. */
  async queue(limit: number): Promise<RebindRequest[]> {
    const rows = await this.sql<Row[]>`
      SELECT r.* FROM referral_rebind_requests r
      WHERE r.state = 'under_review'
        AND (r.approval_expires_at > now()
          OR EXISTS (SELECT 1 FROM action_approvals a WHERE a.approval_id = r.approval_id AND a.status = 'CONSUMED'))
      ORDER BY r.created_at LIMIT ${limit}
    `;
    return rows.map(toRequest);
  }

  /** The person withdraws their own open request. */
  async withdraw(userId: string, requestId: string): Promise<RebindRequest> {
    const row = await this.load(this.sql, requestId);
    if (!row || row.user_id !== userId) throw new ReferralError('No such referrer change request', 'referral.rebind_not_found');
    if (row.state === 'withdrawn') return toRequest(row);
    if (!OPEN.includes(row.state)) throw new ReferralError('This request is already decided', 'referral.rebind_not_open');
    if (row.approval_id) {
      try {
        await this.approvals.revoke(userId, row.approval_id);
      } catch (err) {
        // Revoked by an earlier withdraw whose reply was lost: finish it. Rejected or consumed: a reviewer decided first.
        const revoked = err instanceof ActionApprovalError && (await this.approvalOf(row.approval_id))?.status === 'REVOKED';
        if (!revoked) {
          if (err instanceof ActionApprovalError)
            throw new ReferralError('A reviewer already decided this request', 'referral.rebind_not_open');
          throw err;
        }
      }
    }
    const rows = await this.sql<Row[]>`
      UPDATE referral_rebind_requests SET state = 'withdrawn', decided_at = now()
      WHERE id = ${requestId} AND state IN ${this.sql(OPEN)} RETURNING *
    `;
    return toRequest(rows[0] ?? (await this.load(this.sql, requestId))!);
  }

  /**
   * A second person decides. Reject records the decision; approve approves, consumes once and applies the new referrer
   * from now on. A repeat after a lost reply returns the decided request.
   */
  async decide(operatorId: string, requestId: string, decision: 'approve' | 'reject', reason: string): Promise<RebindRequest> {
    const why = reason.trim();
    if (why.length < 3 || why.length > 500) throw new ReferralError('A reason of 3 to 500 characters is required', 'referral.invalid');
    const row = await this.load(this.sql, requestId);
    if (!row) throw new ReferralError('No such referrer change request', 'referral.rebind_not_found');
    if (row.state === (decision === 'approve' ? 'approved' : 'rejected')) return toRequest(row);
    if (row.state !== 'under_review' || !row.approval_id || !row.approval_operation_id) {
      throw new ReferralError('This request is not waiting for review', 'referral.rebind_not_open');
    }
    // A reviewer who would gain or lose future commission by this change is not a second person for it.
    if (operatorId === row.to_referrer_id || operatorId === row.from_referrer_id) {
      throw new ReferralError('A referrer named in this request cannot decide it', 'referral.rebind_interested');
    }
    const approvalId = row.approval_id;

    if (decision === 'reject') {
      let decidedBy = operatorId;
      try {
        await this.expiring(row, () => this.approvals.reject(operatorId, approvalId));
      } catch (err) {
        // Rejected by an earlier attempt whose reply was lost: record that rejection.
        const stored = err instanceof ActionApprovalError ? await this.approvalOf(approvalId) : null;
        if (stored?.status !== 'REJECTED') throw err;
        decidedBy = stored.approver_id ?? operatorId;
      }
      const rows = await this.sql<Row[]>`
        UPDATE referral_rebind_requests
        SET state = 'rejected', decided_by = ${decidedBy}, decision_reason = ${why}, decided_at = now()
        WHERE id = ${requestId} AND state = 'under_review' RETURNING *
      `;
      return toRequest(rows[0] ?? (await this.load(this.sql, requestId))!);
    }

    const parent = await this.parentMap(this.sql);
    if ((parent.get(row.user_id) ?? null) !== row.from_referrer_id) {
      await this.markStale(requestId);
      throw new ReferralError(STALE_REASON, 'referral.rebind_stale');
    }
    this.assertFits(parent, row.user_id, row.to_referrer_id);
    const payloadHash = rebindPayloadHash(row);
    try {
      await this.expiring(row, () => this.approvals.approve(operatorId, approvalId, payloadHash));
    } catch (err) {
      // Approved (or consumed) by an earlier attempt whose reply was lost: the consume below replays it.
      const settled =
        err instanceof ActionApprovalError && (err.code === 'action_approval.not_pending' || err.code === 'action_approval.consumed');
      if (!settled) throw err;
    }
    const consumed = await this.approvals.consume(TARGET_SERVICE, {
      approvalId,
      operationId: row.approval_operation_id,
      payloadHash,
      targetService: TARGET_SERVICE,
      targetId: targetIdOf(row.id),
      expectedVersion: '1',
      requestId: targetIdOf(row.id),
    });
    const applied = await this.apply(requestId, consumed.approverId ?? operatorId, why);
    if (applied.state !== 'approved') throw new ReferralError(STALE_REASON, 'referral.rebind_stale');
    return toRequest(applied);
  }

  /** Runs an approval step; an approval that lapsed marks the request expired before the refusal goes out. */
  private async expiring<T>(row: Row, step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (err) {
      if (err instanceof ActionApprovalError && err.code === 'action_approval.expired') await this.expireLapsed(this.sql, row.user_id);
      throw err;
    }
  }

  /** Changes the relationship from now on, under the graph lock, and closes the request. Idempotent. */
  private async apply(requestId: string, approverId: string, why: string): Promise<Row> {
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${REFERRAL_GRAPH_LOCK_CLASS}, ${REFERRAL_GRAPH_LOCK_OBJ})`;
        const [row] = await tx<Row[]>`SELECT * FROM referral_rebind_requests WHERE id = ${requestId} FOR UPDATE`;
        if (!row) throw new ReferralError('No such referrer change request', 'referral.rebind_not_found');
        if (row.state === 'approved') return row;
        if (row.state !== 'under_review') throw new ReferralError('This request is not waiting for review', 'referral.rebind_not_open');
        const parent = await this.parentMap(tx);
        const current = parent.get(row.user_id) ?? null;
        if (current !== row.from_referrer_id) {
          // The relationship moved since the request (a link attach or another change): the approval does not apply.
          const [stale] = await tx<Row[]>`
            UPDATE referral_rebind_requests SET state = 'expired', decision_reason = ${STALE_REASON}, decided_at = now()
            WHERE id = ${requestId} RETURNING *
          `;
          return stale!;
        }
        this.assertFits(parent, row.user_id, row.to_referrer_id);
        if (current === null) {
          await tx`INSERT INTO referral_edges (user_id, referrer_id, attributed_at) VALUES (${row.user_id}, ${row.to_referrer_id}, now())`;
        } else {
          await tx`UPDATE referral_edges SET referrer_id = ${row.to_referrer_id}, attributed_at = now() WHERE user_id = ${row.user_id}`;
        }
        if (chainHasCycle(await this.parentMap(tx), row.user_id)) {
          throw new ReferralError('Referral would create a cycle', 'referral.cycle');
        }
        const [done] = await tx<Row[]>`
          UPDATE referral_rebind_requests
          SET state = 'approved', decided_by = ${approverId}, decision_reason = ${why},
              decided_at = now(), applied_at = now()
          WHERE id = ${requestId} RETURNING *
        `;
        return done!;
      },
      { isolation: 'read committed', maxAttempts: 10 },
    );
  }
}
