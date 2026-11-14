import type {
  AddressReputation,
  ProtocolAddressLabel,
  ProtocolComplianceRefusal,
  ProtocolComplianceReport,
  ProtocolComplianceReview,
} from '@intafaced/contracts/protocol-address-risk';
import type { MemoryAddressRiskStore } from './risk.js';

/**
 * The compliance queue (D-developer-compliance-01, J-dex-protocol-30 #1 #2). An operator reads every report with who
 * filed it and how many duplicates by the same person were refused. A label is published by two different people: the
 * first asks, which leaves a pending review; a second person approves, and the label (a new version when one of that kind
 * exists), its history row, the review and the report's status change in one transaction. The person who asked can never
 * approve. A label is a record about an address, not a verdict, and nothing here holds or moves value.
 */
export class ComplianceRefusedError extends Error {
  constructor(
    readonly code: ProtocolComplianceRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ComplianceRefusedError';
  }
}

type LabelKind = ProtocolAddressLabel['kind'];

/** The reputation a published label of each kind carries. A name or a type says who or what, never how safe. */
export const LABEL_REPUTATION: Readonly<Record<LabelKind, AddressReputation>> = {
  phishing: 'UNSAFE',
  sanctioned: 'UNSAFE',
  risk: 'CAUTION',
  name: 'UNKNOWN',
  exchange: 'UNKNOWN',
  contract_type: 'UNKNOWN',
};

/** The label's shown value: the kind in words. */
export const LABEL_VALUE: Readonly<Record<LabelKind, string>> = {
  phishing: 'Phishing',
  sanctioned: 'Sanctioned',
  risk: 'Risk',
  name: 'Name',
  exchange: 'Exchange',
  contract_type: 'Contract type',
};

export type AskOutcome = { kind: 'asked'; review: ProtocolComplianceReview } | { kind: 'report_unknown' } | { kind: 'pending' };
export type ApproveOutcome =
  { kind: 'published'; review: ProtocolComplianceReview } | { kind: 'review_unknown' } | { kind: 'same_reviewer' };

export interface ComplianceStore {
  /** The chain's reports, newest first, each with its label reviews. */
  queue(chainId: number, limit: number): Promise<ProtocolComplianceReport[]>;
  /** A pending review, unless one for this report and kind is already pending (the business key). */
  ask(input: { chainId: number; reportId: string; kind: LabelKind; reason: string; requesterId: string }): Promise<AskOutcome>;
  /** In one transaction: the review, the label and its history row, and the report. A published review approves as itself. */
  approve(input: { chainId: number; reviewId: string; approverId: string }): Promise<ApproveOutcome>;
}

export const QUEUE_LIMIT = 200;

export async function readQueue(store: ComplianceStore, chainId: number, now: Date) {
  return { asOf: now.toISOString(), chainId, reports: await store.queue(chainId, QUEUE_LIMIT) };
}

export async function askLabel(
  store: ComplianceStore,
  input: { chainId: number; reportId: string; kind: LabelKind; reason: string; requesterId: string },
): Promise<ProtocolComplianceReview> {
  const outcome = await store.ask({ ...input, reason: input.reason.trim() });
  if (outcome.kind === 'report_unknown')
    throw new ComplianceRefusedError('protocol.compliance.report_unknown', 'That report is not in the queue on this network.');
  if (outcome.kind === 'pending')
    throw new ComplianceRefusedError(
      'protocol.compliance.review_pending',
      'A label of this kind is already waiting for a second reviewer on this report.',
    );
  return outcome.review;
}

export async function approveLabel(
  store: ComplianceStore,
  input: { chainId: number; reviewId: string; approverId: string },
): Promise<ProtocolComplianceReview> {
  const outcome = await store.approve(input);
  if (outcome.kind === 'review_unknown')
    throw new ComplianceRefusedError('protocol.compliance.review_unknown', 'That label review is not in the queue on this network.');
  if (outcome.kind === 'same_reviewer')
    throw new ComplianceRefusedError(
      'protocol.compliance.same_reviewer',
      'You asked for this label, so a different person must approve it. Nothing was published.',
    );
  return outcome.review;
}

/** In-memory store for tests, over the address risk store's own rows. Same rules as the Postgres one. */
export class MemoryComplianceStore implements ComplianceStore {
  private readonly reviews: (ProtocolComplianceReview & { reportId: string })[] = [];
  private seq = 0;
  constructor(private readonly risk: MemoryAddressRiskStore) {}

  async queue(chainId: number, limit: number): Promise<ProtocolComplianceReport[]> {
    return this.risk.reports
      .filter((r) => r.chainId === chainId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        chainId: r.chainId,
        address: r.address,
        kind: r.kind,
        reporterId: r.reporterId,
        note: r.note,
        evidenceUrl: r.evidenceUrl,
        status: r.status,
        duplicatesRefused: r.duplicatesRefused,
        createdAt: r.createdAt.toISOString(),
        reviews: this.reviews.filter((v) => v.reportId === r.id).map(({ reportId: _r, ...review }) => review),
      }));
  }

  async ask(input: { chainId: number; reportId: string; kind: LabelKind; reason: string; requesterId: string }): Promise<AskOutcome> {
    const report = this.risk.reports.find((r) => r.id === input.reportId && r.chainId === input.chainId);
    if (!report) return { kind: 'report_unknown' };
    if (this.reviews.some((v) => v.reportId === input.reportId && v.kind === input.kind && v.status === 'pending'))
      return { kind: 'pending' };
    const review = {
      id: `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`,
      reportId: input.reportId,
      kind: input.kind,
      reason: input.reason,
      status: 'pending' as ProtocolComplianceReview['status'],
      requesterId: input.requesterId,
      approverId: null as string | null,
      askedAt: new Date().toISOString(),
      decidedAt: null as string | null,
    };
    this.reviews.push(review);
    const { reportId: _r, ...out } = review;
    return { kind: 'asked', review: out };
  }

  async approve(input: { chainId: number; reviewId: string; approverId: string }): Promise<ApproveOutcome> {
    const review = this.reviews.find((v) => v.id === input.reviewId);
    const report = review && this.risk.reports.find((r) => r.id === review.reportId && r.chainId === input.chainId);
    if (!review || !report) return { kind: 'review_unknown' };
    const { reportId: _r, ...out } = review;
    if (review.status === 'published') return { kind: 'published', review: out };
    if (review.requesterId === input.approverId) return { kind: 'same_reviewer' };
    const at = new Date();
    review.status = 'published';
    review.approverId = input.approverId;
    review.decidedAt = at.toISOString();
    const prior = this.risk.labelRows.find((l) => l.chainId === report.chainId && l.address === report.address && l.kind === review.kind);
    const label = {
      kind: review.kind,
      value: LABEL_VALUE[review.kind],
      source: 'user_report' as const,
      reputation: LABEL_REPUTATION[review.kind],
      reason: review.reason,
      evidenceUrl: report.evidenceUrl,
      version: (prior?.version ?? 0) + 1,
      setAt: at,
    };
    if (prior) Object.assign(prior, label);
    else this.risk.addLabel(report.chainId, report.address, label);
    report.status = 'published';
    const { reportId: _again, ...done } = review;
    return { kind: 'published', review: done };
  }
}
