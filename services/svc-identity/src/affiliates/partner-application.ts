/**
 * Partner applications (CM-referral-05, J-campaigns-07 #1-#4).
 *
 * A person with enough qualified invitees applies to become an affiliate partner. A qualified invitee is a person this
 * account introduced directly (a referral edge) whose identity verification was approved at any level. How many are
 * enough is an owner setting with NO DEFAULT (`IDENTITY_PARTNER_MIN_QUALIFIED_INVITEES`): blank refuses the eligibility
 * read and the application with `partner.eligibility_unset`, and no record is written.
 *
 * An operator other than the applicant approves or rejects, always with a reason. A rejection names a reason category
 * and the date the person may apply again: the decision time plus the owner's `IDENTITY_PARTNER_REAPPLY_DAYS` (NO
 * DEFAULT; blank refuses a rejection with `partner.reapply_unset`, leaving the application open). An approved partner
 * reads their own sub-tree, to the programme depth (`programme-depth.ts`).
 *
 * One open or approved application per person (unique index), so two presses file one application. A repeated decision
 * after a lost reply returns the decided row. Partner status moves no money: commission legs are accrued and paid by
 * the existing accrual and payout paths, which the programme depth bounds.
 */

import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { AffiliateProgrammeDepthUnsetError } from './programme-depth.js';

export const PARTNER_REJECT_CATEGORIES = ['not_enough_activity', 'incomplete_application', 'compliance', 'other'] as const;
export type PartnerRejectCategory = (typeof PARTNER_REJECT_CATEGORIES)[number];

export type PartnerState = 'submitted' | 'approved' | 'rejected';

export type PartnerErrorCode =
  | 'partner.eligibility_unset'
  | 'partner.reapply_unset'
  | 'partner.not_eligible'
  | 'partner.reapply_too_soon'
  | 'partner.not_found'
  | 'partner.not_open'
  | 'partner.self_decision'
  | 'partner.not_partner'
  | 'partner.invalid';

export class PartnerError extends Error {
  constructor(
    message: string,
    readonly code: PartnerErrorCode,
  ) {
    super(message);
    this.name = 'PartnerError';
  }
}

export type PartnerApplication = {
  readonly id: string;
  readonly userId: string;
  readonly state: PartnerState;
  readonly qualifiedCount: number;
  readonly requiredCount: number;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly rejectCategory: PartnerRejectCategory | null;
  readonly reapplyAt: Date | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
};

export type PartnerEligibility = {
  readonly requiredCount: number;
  readonly qualifiedCount: number;
  readonly eligible: boolean;
};

export type PartnerSubTreeMember = {
  readonly handle: string;
  /** 1 for a person I introduced, 2 for a person they introduced, and so on. */
  readonly level: number;
  readonly joinedAt: Date;
};

export type PartnerSubTree = {
  readonly depth: number;
  readonly members: readonly PartnerSubTreeMember[];
  /** People further down than the programme depth: counted, never named. */
  readonly beyondDepth: number;
};

type Row = {
  id: string;
  user_id: string;
  state: PartnerState;
  qualified_count: number;
  required_count: number;
  decided_by: string | null;
  decision_reason: string | null;
  reject_category: PartnerRejectCategory | null;
  reapply_at: Date | null;
  created_at: Date;
  decided_at: Date | null;
};

const toApplication = (r: Row): PartnerApplication => ({
  id: r.id,
  userId: r.user_id,
  state: r.state,
  qualifiedCount: r.qualified_count,
  requiredCount: r.required_count,
  decidedBy: r.decided_by,
  decisionReason: r.decision_reason,
  rejectCategory: r.reject_category,
  reapplyAt: r.reapply_at,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const MAX_COUNT = 100_000;
const MAX_REAPPLY_DAYS = 3650;

/** `IDENTITY_PARTNER_MIN_QUALIFIED_INVITEES`, parsed at start. Blank → undefined; malformed stops the service. */
export function parsePartnerMinQualified(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_COUNT) {
    throw new Error(`IDENTITY_PARTNER_MIN_QUALIFIED_INVITEES must be a whole number from 1 to ${MAX_COUNT}`);
  }
  return Number(value);
}

/** `IDENTITY_PARTNER_REAPPLY_DAYS`, parsed at start. Blank → undefined; malformed stops the service. */
export function parsePartnerReapplyDays(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_REAPPLY_DAYS) {
    throw new Error(`IDENTITY_PARTNER_REAPPLY_DAYS must be a whole number of days from 1 to ${MAX_REAPPLY_DAYS}`);
  }
  return Number(value);
}

function reasonOf(reason: string): string {
  const why = reason.trim();
  if (why.length < 3 || why.length > 500) throw new PartnerError('A reason of 3 to 500 characters is required', 'partner.invalid');
  return why;
}

export class PartnerApplicationService {
  constructor(
    private readonly sql: Sql,
    private readonly options: {
      readonly minQualifiedInvitees: number | undefined;
      readonly reapplyDays: number | undefined;
      readonly programmeDepth: number | undefined;
    },
  ) {}

  private required(): number {
    const n = this.options.minQualifiedInvitees;
    if (n === undefined) {
      throw new PartnerError(
        'The number of qualified invitees a partner needs is not set; no application can be made',
        'partner.eligibility_unset',
      );
    }
    return n;
  }

  /** People this account introduced directly whose verification was approved at any level. */
  private async qualifiedCount(sql: Sql, userId: string): Promise<number> {
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(DISTINCT e.user_id)::int AS n
      FROM referral_edges e
      JOIN kyc_records k ON k.user_id = e.user_id AND k.status = 'approved' AND k.tier <> 'none'
      WHERE e.referrer_id = ${userId}
    `;
    return row?.n ?? 0;
  }

  async eligibility(userId: string): Promise<PartnerEligibility> {
    const requiredCount = this.required();
    const qualifiedCount = await this.qualifiedCount(this.sql, userId);
    return { requiredCount, qualifiedCount, eligible: qualifiedCount >= requiredCount };
  }

  private async latestRow(sql: Sql, userId: string): Promise<Row | null> {
    const rows = await sql<Row[]>`
      SELECT * FROM partner_applications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /** Files one application. An open or approved one comes back as it is; pressing twice files one. */
  async apply(userId: string, now: Date = new Date()): Promise<PartnerApplication> {
    const requiredCount = this.required();
    const latest = await this.latestRow(this.sql, userId);
    if (latest && latest.state !== 'rejected') return toApplication(latest);
    if (latest?.reapply_at && now.getTime() < latest.reapply_at.getTime()) {
      throw new PartnerError(`You may apply again from ${latest.reapply_at.toISOString()}`, 'partner.reapply_too_soon');
    }
    const qualifiedCount = await this.qualifiedCount(this.sql, userId);
    if (qualifiedCount < requiredCount) {
      throw new PartnerError(
        `${qualifiedCount} qualified invitees of the ${requiredCount} a partner needs; nothing was filed`,
        'partner.not_eligible',
      );
    }
    const inserted = await this.sql<Row[]>`
      INSERT INTO partner_applications (id, user_id, state, qualified_count, required_count)
      VALUES (${randomUUID()}, ${userId}, 'submitted', ${qualifiedCount}, ${requiredCount})
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (inserted[0]) return toApplication(inserted[0]);
    // Another press won the unique index: return its application.
    const winner = await this.latestRow(this.sql, userId);
    if (!winner) throw new PartnerError('No application was filed', 'partner.not_found');
    return toApplication(winner);
  }

  async latestOf(userId: string): Promise<PartnerApplication | null> {
    const row = await this.latestRow(this.sql, userId);
    return row ? toApplication(row) : null;
  }

  /** Applications waiting for an operator, oldest first. */
  async queue(limit: number): Promise<PartnerApplication[]> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM partner_applications WHERE state = 'submitted' ORDER BY created_at LIMIT ${limit}
    `;
    return rows.map(toApplication);
  }

  /**
   * An operator decides, with a reason. The applicant can never decide their own. A rejection needs a category and the
   * owner's reapply wait. A repeat of the same decision returns the decided row; a different one is refused.
   */
  async decide(
    operatorId: string,
    applicationId: string,
    decision: 'approve' | 'reject',
    reason: string,
    category?: PartnerRejectCategory,
    now: Date = new Date(),
  ): Promise<PartnerApplication> {
    const why = reasonOf(reason);
    const [row] = await this.sql<Row[]>`SELECT * FROM partner_applications WHERE id = ${applicationId}`;
    if (!row) throw new PartnerError('No such partner application', 'partner.not_found');
    if (row.user_id === operatorId) throw new PartnerError('An applicant cannot decide their own application', 'partner.self_decision');
    const target: PartnerState = decision === 'approve' ? 'approved' : 'rejected';
    if (row.state === target) return toApplication(row);
    if (row.state !== 'submitted') throw new PartnerError('This application is already decided', 'partner.not_open');

    let rows: Row[];
    if (decision === 'approve') {
      rows = await this.sql<Row[]>`
        UPDATE partner_applications
        SET state = 'approved', decided_by = ${operatorId}, decision_reason = ${why}, decided_at = ${now}
        WHERE id = ${applicationId} AND state = 'submitted' RETURNING *
      `;
    } else {
      if (!category || !PARTNER_REJECT_CATEGORIES.includes(category)) {
        throw new PartnerError('A rejection names one reason category', 'partner.invalid');
      }
      const days = this.options.reapplyDays;
      if (days === undefined) {
        throw new PartnerError(
          'The wait before a rejected person may apply again is not set; nothing was decided',
          'partner.reapply_unset',
        );
      }
      const reapplyAt = new Date(now.getTime() + days * 86_400_000);
      rows = await this.sql<Row[]>`
        UPDATE partner_applications
        SET state = 'rejected', decided_by = ${operatorId}, decision_reason = ${why}, reject_category = ${category},
            reapply_at = ${reapplyAt}, decided_at = ${now}
        WHERE id = ${applicationId} AND state = 'submitted' RETURNING *
      `;
    }
    if (rows[0]) return toApplication(rows[0]);
    // Another operator decided between the read and the write.
    const [after] = await this.sql<Row[]>`SELECT * FROM partner_applications WHERE id = ${applicationId}`;
    if (after?.state === target) return toApplication(after);
    throw new PartnerError('This application is already decided', 'partner.not_open');
  }

  /**
   * An approved partner's own downline, level by level to the programme depth. Only people below this account appear;
   * anyone deeper is counted, never named. Blank depth refuses.
   */
  async subTree(userId: string): Promise<PartnerSubTree> {
    const depth = this.options.programmeDepth;
    if (depth === undefined) throw new AffiliateProgrammeDepthUnsetError();
    const latest = await this.latestRow(this.sql, userId);
    if (latest?.state !== 'approved') throw new PartnerError('Only an approved partner has a partner portal', 'partner.not_partner');
    // Walk down from this account only; the cap stops a corrupt graph from looping.
    const rows = await this.sql<Array<{ handle: string; level: number; joined_at: Date }>>`
      WITH RECURSIVE down(user_id, level, attributed_at) AS (
        SELECT e.user_id, 1, e.attributed_at FROM referral_edges e WHERE e.referrer_id = ${userId}
        UNION ALL
        SELECT e.user_id, d.level + 1, e.attributed_at
        FROM referral_edges e JOIN down d ON e.referrer_id = d.user_id
        WHERE d.level < 50 AND e.user_id <> ${userId}
      )
      SELECT u.handle::text AS handle, d.level, d.attributed_at AS joined_at
      FROM down d JOIN users u ON u.id = d.user_id
      ORDER BY d.level, u.handle
    `;
    const members = rows.filter((r) => r.level <= depth).map((r) => ({ handle: r.handle, level: r.level, joinedAt: r.joined_at }));
    return { depth, members, beyondDepth: rows.length - members.length };
  }
}
