import type { Sql } from 'postgres';
import type { ProtocolComplianceReport, ProtocolComplianceReview } from '@intafaced/contracts/protocol-address-risk';
import { LABEL_REPUTATION, LABEL_VALUE, type ApproveOutcome, type AskOutcome, type ComplianceStore } from './compliance.js';

/**
 * Postgres `ComplianceStore` over `protocol.address_reports`, `protocol.address_label_reviews`, `protocol.address_labels`
 * and `protocol.address_label_history` (20261107073648, 20261112090000). An approval takes the review's row lock, so two
 * approvals racing on one review publish it once; the table's own check refuses an approver who is the requester.
 */
type ReportRow = {
  id: string;
  chain_id: number;
  address: string;
  kind: ProtocolComplianceReport['kind'];
  reporter_id: string;
  note: string | null;
  evidence_url: string | null;
  status: ProtocolComplianceReport['status'];
  duplicates_refused: number;
  created_at: Date | string;
};
type ReviewRow = {
  id: string;
  report_id: string;
  kind: ProtocolComplianceReview['kind'];
  reason: string;
  status: ProtocolComplianceReview['status'];
  requester_id: string;
  approver_id: string | null;
  asked_at: Date | string;
  decided_at: Date | string | null;
};

// The service's client is shared with drizzle, which reads timestamps back as text.
const iso = (value: Date | string) => new Date(value).toISOString();
const toReview = (r: ReviewRow): ProtocolComplianceReview => ({
  id: r.id,
  kind: r.kind,
  reason: r.reason,
  status: r.status,
  requesterId: r.requester_id,
  approverId: r.approver_id,
  askedAt: iso(r.asked_at),
  decidedAt: r.decided_at === null ? null : iso(r.decided_at),
});
const REVIEW_COLUMNS = 'id, report_id, kind, reason, status, requester_id, approver_id, asked_at, decided_at';

export class PostgresComplianceStore implements ComplianceStore {
  constructor(private readonly sql: Sql) {}

  async queue(chainId: number, limit: number): Promise<ProtocolComplianceReport[]> {
    const reports = await this.sql<ReportRow[]>`
      SELECT id, chain_id, address, kind, reporter_id, note, evidence_url, status, duplicates_refused, created_at
      FROM protocol.address_reports WHERE chain_id = ${chainId} ORDER BY created_at DESC, id LIMIT ${limit}`;
    if (reports.length === 0) return [];
    const reviews = await this.sql<ReviewRow[]>`
      SELECT ${this.sql.unsafe(REVIEW_COLUMNS)} FROM protocol.address_label_reviews
      WHERE report_id IN ${this.sql(reports.map((r) => r.id))} ORDER BY asked_at, id`;
    return reports.map((r) => ({
      id: r.id,
      chainId: r.chain_id,
      address: r.address,
      kind: r.kind,
      reporterId: r.reporter_id,
      note: r.note,
      evidenceUrl: r.evidence_url,
      status: r.status,
      duplicatesRefused: r.duplicates_refused,
      createdAt: iso(r.created_at),
      reviews: reviews.filter((v) => v.report_id === r.id).map(toReview),
    }));
  }

  async ask(input: {
    chainId: number;
    reportId: string;
    kind: ProtocolComplianceReview['kind'];
    reason: string;
    requesterId: string;
  }): Promise<AskOutcome> {
    const [report] = await this.sql<{ id: string }[]>`
      SELECT id FROM protocol.address_reports WHERE id = ${input.reportId} AND chain_id = ${input.chainId}`;
    if (!report) return { kind: 'report_unknown' };
    const rows = await this.sql<ReviewRow[]>`
      INSERT INTO protocol.address_label_reviews (report_id, kind, reason, requester_id)
      VALUES (${input.reportId}, ${input.kind}, ${input.reason}, ${input.requesterId})
      ON CONFLICT (report_id, kind) WHERE status = 'pending' DO NOTHING
      RETURNING ${this.sql.unsafe(REVIEW_COLUMNS)}`;
    const row = rows[0];
    return row ? { kind: 'asked', review: toReview(row) } : { kind: 'pending' };
  }

  async approve(input: { chainId: number; reviewId: string; approverId: string }): Promise<ApproveOutcome> {
    return this.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const [review] = await q<(ReviewRow & { address: string; evidence_url: string | null })[]>`
        SELECT v.id, v.report_id, v.kind, v.reason, v.status, v.requester_id, v.approver_id, v.asked_at, v.decided_at,
               r.address, r.evidence_url
        FROM protocol.address_label_reviews v JOIN protocol.address_reports r ON r.id = v.report_id
        WHERE v.id = ${input.reviewId} AND r.chain_id = ${input.chainId}
        FOR UPDATE OF v`;
      if (!review) return { kind: 'review_unknown' } as const;
      if (review.status === 'published') return { kind: 'published', review: toReview(review) } as const;
      if (review.requester_id === input.approverId) return { kind: 'same_reviewer' } as const;
      const [label] = await q<{ id: string; version: number }[]>`
        INSERT INTO protocol.address_labels (chain_id, address, kind, value, source, reputation, reason, evidence_url, set_by)
        VALUES (${input.chainId}, ${review.address}, ${review.kind}, ${LABEL_VALUE[review.kind]}, 'user_report',
                ${LABEL_REPUTATION[review.kind]}, ${review.reason}, ${review.evidence_url}, ${input.approverId})
        ON CONFLICT (chain_id, lower(address), kind) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source,
          reputation = EXCLUDED.reputation, reason = EXCLUDED.reason, evidence_url = EXCLUDED.evidence_url,
          set_by = EXCLUDED.set_by, version = protocol.address_labels.version + 1, updated_at = now()
        RETURNING id, version`;
      await q`
        INSERT INTO protocol.address_label_history (label_id, version, value, reputation, reason, evidence_url, set_by)
        VALUES (${label!.id}, ${label!.version}, ${LABEL_VALUE[review.kind]}, ${LABEL_REPUTATION[review.kind]}, ${review.reason},
                ${review.evidence_url}, ${input.approverId})`;
      await q`UPDATE protocol.address_reports SET status = 'published', updated_at = now() WHERE id = ${review.report_id}`;
      const [done] = await q<ReviewRow[]>`
        UPDATE protocol.address_label_reviews SET status = 'published', approver_id = ${input.approverId}, decided_at = now()
        WHERE id = ${input.reviewId} RETURNING ${q.unsafe(REVIEW_COLUMNS)}`;
      return { kind: 'published', review: toReview(done!) } as const;
    });
  }
}
