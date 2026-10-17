/**
 * pay.fraud — manual review queue (SPEC-PAY-VERTICALS §3 · D26-P1-P5).
 *
 * Scoring returns `review`; this queue is where a human decision lands.
 * Moves no value. Never invents blocklist content or auto-resolves without
 * an explicit actor + outcome.
 */

import type { FraudDecision, FraudReason } from './evaluate.js';

export type FraudReviewStatus = 'open' | 'claimed' | 'allowed' | 'declined';

export interface FraudReviewCase {
  readonly id: string;
  readonly merchantId: string;
  readonly paymentId: string | null;
  /** Stable ref for one case per held or flagged payment. Null when the caller named no payment. */
  readonly paymentRef: string | null;
  readonly amount: string;
  readonly assetId: string;
  readonly decision: FraudDecision;
  readonly reason: string;
  readonly status: FraudReviewStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
}

export class FraudReviewError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'pay.fraud_review_not_review'
      | 'pay.fraud_review_not_found'
      | 'pay.fraud_review_closed'
      | 'pay.fraud_review_claimed'
      | 'pay.fraud_review_actor_required'
      | 'pay.fraud_review_list_limit_unset'
      | 'pay.fraud_review_missing_case',
  ) {
    super(message);
    this.name = 'FraudReviewError';
  }
}

/** fraud.listOpenReviews page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertFraudReviewListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new FraudReviewError(
      'fraud.listOpenReviews page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.fraud_review_list_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new FraudReviewError(
      'fraud.listOpenReviews page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.fraud_review_list_limit_unset',
    );
  }
  return Math.min(200, n);
}

export interface EnqueueFraudReviewInput {
  readonly id: string;
  readonly merchantId: string;
  readonly amount: string;
  readonly assetId: string;
  readonly decision: FraudDecision;
  readonly paymentId?: string | null;
  readonly createdBy?: string | null;
  readonly now?: Date;
}

export interface ClaimFraudReviewInput {
  readonly id: string;
  readonly actorId: string;
  readonly now?: Date;
}

export interface ResolveFraudReviewInput {
  readonly id: string;
  readonly outcome: 'allow' | 'decline';
  readonly actorId: string;
  readonly note?: string | null;
  readonly now?: Date;
}

export interface FraudReviewQueue {
  enqueue(input: EnqueueFraudReviewInput): FraudReviewCase;
  get(id: string): FraudReviewCase | null;
  listOpen(merchantId?: string, limit?: number): readonly FraudReviewCase[];
  claim(input: ClaimFraudReviewInput): FraudReviewCase;
  resolve(input: ResolveFraudReviewInput): FraudReviewCase;
}

/** Process-local queue. Production reads and writes `PostgresFraudReviewQueue`. */
export class MemoryFraudReviewQueue implements FraudReviewQueue {
  private readonly cases = new Map<string, FraudReviewCase>();
  /** Memory cases are merchant fraud reviews. A found id with another merchant or source is not found. */
  private readonly sources = new Map<string, 'fraud.review'>();

  enqueue(input: EnqueueFraudReviewInput): FraudReviewCase {
    if (input.id.trim().toLowerCase().startsWith('held:')) {
      throw new FraudReviewError('Case ids starting with held: are reserved for system holds', 'pay.fraud_review_not_review');
    }
    if (input.decision.outcome !== 'review') {
      throw new FraudReviewError('Only evaluate outcomes of review may enter the fraud review queue', 'pay.fraud_review_not_review');
    }
    if (input.decision.reasons.length === 0) {
      throw new FraudReviewError('Review cases require explainable reasons (SPEC §3)', 'pay.fraud_review_not_review');
    }
    const existing = this.cases.get(input.id);
    if (existing) {
      if (existing.merchantId !== input.merchantId || this.sources.get(input.id) !== 'fraud.review') {
        throw new FraudReviewError(`No fraud review case ${input.id}`, 'pay.fraud_review_not_found');
      }
      return existing;
    }

    const createdAt = (input.now ?? new Date()).toISOString();
    const createdBy = input.createdBy?.trim() || 'enqueue';
    const row: FraudReviewCase = {
      id: input.id,
      merchantId: input.merchantId,
      paymentId: input.paymentId ?? null,
      paymentRef: input.paymentId ?? null,
      amount: input.amount,
      assetId: input.assetId,
      decision: Object.freeze({
        outcome: input.decision.outcome,
        reasons: Object.freeze([...input.decision.reasons]) as readonly FraudReason[],
        skippedDisabled: Object.freeze([...input.decision.skippedDisabled]),
      }),
      reason: input.decision.reasons.map((r) => r.detail).join('; '),
      status: 'open',
      createdBy,
      createdAt,
      claimedBy: null,
      claimedAt: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
    };
    this.cases.set(row.id, row);
    this.sources.set(row.id, 'fraud.review');
    return row;
  }

  get(id: string): FraudReviewCase | null {
    return this.cases.get(id) ?? null;
  }

  listOpen(merchantId?: string, limit?: number): readonly FraudReviewCase[] {
    const n = assertFraudReviewListLimit(limit);
    return [...this.cases.values()]
      .filter((c) => (c.status === 'open' || c.status === 'claimed') && (merchantId === undefined || c.merchantId === merchantId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, n);
  }

  claim(input: ClaimFraudReviewInput): FraudReviewCase {
    const actor = input.actorId?.trim();
    if (!actor) {
      throw new FraudReviewError('actorId is required to claim a fraud review', 'pay.fraud_review_actor_required');
    }
    const current = this.cases.get(input.id);
    if (!current) {
      throw new FraudReviewError(`No fraud review case ${input.id}`, 'pay.fraud_review_not_found');
    }
    if (current.status === 'claimed') {
      if (current.claimedBy === actor) return current;
      throw new FraudReviewError(`Fraud review ${input.id} is claimed by ${current.claimedBy}`, 'pay.fraud_review_claimed');
    }
    if (current.status !== 'open') {
      throw new FraudReviewError(`Fraud review ${input.id} is already ${current.status}`, 'pay.fraud_review_closed');
    }
    const next: FraudReviewCase = {
      ...current,
      status: 'claimed',
      claimedBy: actor,
      claimedAt: (input.now ?? new Date()).toISOString(),
    };
    this.cases.set(next.id, next);
    return next;
  }

  resolve(input: ResolveFraudReviewInput): FraudReviewCase {
    const actor = input.actorId?.trim();
    if (!actor) {
      throw new FraudReviewError('actorId is required to resolve a fraud review', 'pay.fraud_review_actor_required');
    }
    const current = this.cases.get(input.id);
    if (!current) {
      throw new FraudReviewError(`No fraud review case ${input.id}`, 'pay.fraud_review_not_found');
    }
    const wanted = input.outcome === 'allow' ? 'allowed' : 'declined';
    if (current.status === wanted) return current;
    if (current.status !== 'open' && current.status !== 'claimed') {
      throw new FraudReviewError(`Fraud review ${input.id} is already ${current.status}`, 'pay.fraud_review_closed');
    }
    const next: FraudReviewCase = {
      ...current,
      status: input.outcome === 'allow' ? 'allowed' : 'declined',
      resolvedAt: (input.now ?? new Date()).toISOString(),
      resolvedBy: actor,
      resolutionNote: input.note?.trim() ? input.note.trim() : null,
    };
    this.cases.set(next.id, next);
    return next;
  }
}

/** Process-local default. The pay router uses PostgresFraudReviewQueue when it has a database client. */
export const defaultFraudReviewQueue = new MemoryFraudReviewQueue();
