import type { Sql } from 'postgres';
import type { DisputeCaseStore } from '../fraud/dispute-case.js';
import type { EvidenceKind } from './disputes.js';
import { MerchantOpsError } from './errors.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * M-disp-02 (spec group merchant-disp-bill-rep): the evidence draft, reason
 * guidance and the response deadline, READ ONLY.
 *
 * Evidence already saves as a draft: `addEvidence` stores rows and nothing is
 * sent until `respond(contest)`. This module answers "what will be sent, what
 * is missing, how long is left" without writing anything.
 *
 * Guidance is keyed on a dispute REASON CATEGORY (the rail's own scheme code is
 * never translated). A stored reason code that is not one of the categories
 * gets the `general` guidance, never a guess at what the scheme meant.
 *
 * The due date is the one the rail carried (`pay.dispute_response_deadlines`);
 * none is invented. No due date stored means `due: null` ("not given by the
 * rail"), never a default window.
 */

export const DISPUTE_REASON_CATEGORIES = [
  'product_not_received',
  'fraudulent',
  'duplicate',
  'subscription_canceled',
  'product_unacceptable',
  'credit_not_processed',
  'general',
] as const;
export type DisputeReasonCategory = (typeof DISPUTE_REASON_CATEGORIES)[number];

const GUIDANCE = {
  product_not_received: {
    meaning: 'The payer says they paid but never received what they bought.',
    recommended: ['shipping_proof', 'customer_communication', 'receipt'],
  },
  fraudulent: {
    meaning: 'The payer says they did not make or allow this payment.',
    recommended: ['identity_check', 'customer_communication', 'receipt'],
  },
  duplicate: {
    meaning: 'The payer says they were charged more than once for the same thing.',
    recommended: ['receipt', 'customer_communication'],
  },
  subscription_canceled: {
    meaning: 'The payer says they cancelled and were charged anyway.',
    recommended: ['terms_accepted', 'customer_communication', 'receipt'],
  },
  product_unacceptable: {
    meaning: 'The payer says what they received was faulty or not as described.',
    recommended: ['receipt', 'customer_communication', 'terms_accepted'],
  },
  credit_not_processed: {
    meaning: 'The payer says a refund or credit they were promised never arrived.',
    recommended: ['terms_accepted', 'customer_communication', 'receipt'],
  },
  general: {
    meaning: 'The payer disputes this payment for a reason the rail did not name in a way we can explain.',
    recommended: ['receipt', 'customer_communication'],
  },
} as const satisfies Record<DisputeReasonCategory, { meaning: string; recommended: readonly EvidenceKind[] }>;

export function disputeReasonCategory(reasonCode: string | null): DisputeReasonCategory {
  const code = (reasonCode ?? '').trim().toLowerCase();
  return (DISPUTE_REASON_CATEGORIES as readonly string[]).includes(code) ? (code as DisputeReasonCategory) : 'general';
}

/** Pure: plain-words meaning and recommended evidence kinds, first is most important. */
export function disputeGuidance(category: DisputeReasonCategory) {
  const g = GUIDANCE[category];
  return { category, meaning: g.meaning, recommended: [...g.recommended] };
}

const DAY_MS = 86_400_000;

/** Pure: whole days left until the rail's due date, or past due. Null due stays null. */
export function disputeCountdown(dueAt: Date | null, now: Date) {
  if (!dueAt) return null;
  const ms = dueAt.getTime() - now.getTime();
  return { dueAt: dueAt.toISOString(), pastDue: ms <= 0, daysLeft: ms <= 0 ? 0 : Math.ceil(ms / DAY_MS) };
}

const notFound = () => new MerchantOpsError('pay.dispute_not_found', 'not_found');

export class DisputeEvidenceDraft {
  constructor(
    private readonly sql: Sql,
    private readonly store: DisputeCaseStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * What `respond(contest)` would send right now, what recommended kinds are
   * missing, and why a submit would be refused. Writes nothing.
   */
  async reviewDraft(caller: MerchantCaller, disputeId: string) {
    assertPermission(caller, 'disputes.read');
    const c = await this.store.get(disputeId);
    if (!c || c.merchantId !== caller.merchantId) throw notFound();
    const evidence = await this.sql<Array<{ id: string; kind: EvidenceKind; file_name: string; note: string | null; created_at: Date }>>`
      SELECT id, kind, file_name, note, created_at
        FROM pay.merchant_dispute_evidence
       WHERE merchant_id = ${caller.merchantId} AND dispute_id = ${c.disputeId}
       ORDER BY created_at, id`;
    const due = await this.sql<Array<{ response_due_at: Date | null }>>`
      SELECT response_due_at FROM pay.dispute_response_deadlines
       WHERE merchant_id = ${caller.merchantId} AND dispute_id = ${c.disputeId}`;
    const countdown = disputeCountdown(due[0]?.response_due_at ?? null, this.now());
    const guidance = disputeGuidance(disputeReasonCategory(c.reasonCode));
    const present = new Set(evidence.map((e) => e.kind));
    const sent = c.status !== 'open';
    /** Only the refusals `respond(contest)` enforces today. A past due date is shown in `due`; refusing on it is left for later. */
    const blockers: Array<'already_sent' | 'no_evidence'> = [];
    if (sent) blockers.push('already_sent');
    if (evidence.length === 0) blockers.push('no_evidence');
    return {
      disputeId: c.disputeId,
      status: c.status,
      state: sent ? ('sent' as const) : evidence.length > 0 ? ('saved_draft' as const) : ('empty' as const),
      items: evidence.map((e) => ({
        evidenceId: e.id,
        kind: e.kind,
        fileName: e.file_name,
        note: e.note,
        addedAt: e.created_at.toISOString(),
      })),
      missingRecommended: guidance.recommended.filter((k) => !present.has(k)),
      guidance,
      due: countdown,
      canSubmit: blockers.length === 0,
      blockers,
    };
  }
}
