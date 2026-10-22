import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { canTransitionDispute, type PayDisputeCaseState, type PayDisputeOpenResult } from '@intafaced/contracts';
import { BankError } from '../errors.js';
import type { ActivityItem } from '../activity/activity-service.js';

/**
 * PP-disputes-safety-01: open a dispute case on one activity line.
 *
 * Keyed `dispute:<userId>:<activityId>` (PD-1): the case id is derived from that key, so the same open twice is the
 * same case and a client cannot choose the id. The reason table is owner-published legal copy: empty refuses
 * `pay.dispute_reasons_unset` (blocker), an unknown code refuses `pay.dispute_reason_unknown`. Eligibility: a pending
 * line refuses `pending`; a fully refunded line refuses `already_refunded`; a card line routes to the issuer and no
 * case is created. The case row is written before any notification; no money moves.
 */
/** A fact about one line: known yes, known no, or unknown. Unknown always refuses (fail closed). */
export type LineFact = 'yes' | 'no' | 'unknown';

export interface DisputeLineFacts {
  /** Whether the card rail owns this line's dispute (chargeback through the issuer). */
  isCardLine(item: ActivityItem): LineFact | Promise<LineFact>;
  /** Whether this line has already been refunded in full. */
  isFullyRefunded(item: ActivityItem): LineFact | Promise<LineFact>;
}

/**
 * Nothing wires these facts yet (no card rail or refund link on the feed), so both are `unknown` and every open
 * refuses `pay.dispute_line_facts_unset`. A permissive `false` would silently fail open the day card lines or refund
 * links land (review MAJOR 2).
 */
export const unknownDisputeLineFacts: DisputeLineFacts = {
  isCardLine: () => 'unknown',
  isFullyRefunded: () => 'unknown',
};

export function disputeCaseKey(userId: string, activityId: string): string {
  return `dispute:${userId}:${activityId}`;
}

/** A UUID (v4 layout) derived from the case key, so a retry recomputes the same id. */
export function disputeCaseId(caseKey: string): string {
  const h = createHash('sha256').update(caseKey).digest('hex');
  const v = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** PD-3 as a function: refuses any transition the table does not list. */
export function transitionDispute(from: PayDisputeCaseState, to: PayDisputeCaseState): PayDisputeCaseState {
  if (!canTransitionDispute(from, to)) {
    throw new BankError(`A dispute case cannot go from ${from} to ${to}`, 'pay.dispute_transition_refused');
  }
  return to;
}

interface CaseRow {
  id: string;
  user_id: string;
  activity_id: string;
  reason_code: string;
  statement: string;
  linked_activity_ids: string[];
  status: PayDisputeCaseState;
  created_at: Date;
}

export class DisputeCases {
  constructor(
    private readonly sql: Sql,
    private readonly facts: DisputeLineFacts = unknownDisputeLineFacts,
  ) {}

  async open(
    userId: string,
    item: ActivityItem,
    input: { reasonCode: string; statement: string; linkedActivityIds: string[] },
  ): Promise<PayDisputeOpenResult> {
    const card = await this.facts.isCardLine(item);
    if (card === 'unknown') {
      throw new BankError('Whether this line is a card line is not known yet; a dispute cannot be routed', 'pay.dispute_line_facts_unset');
    }
    if (card === 'yes') return { routedTo: 'card_issuer', activityId: item.id };

    const key = disputeCaseKey(userId, item.id);
    const existing = await this.sql<CaseRow[]>`
      SELECT id, user_id, activity_id, reason_code, statement, linked_activity_ids, status, created_at
        FROM bank.dispute_cases WHERE case_key = ${key}
    `;
    if (existing[0]) return this.replay(existing[0], input);

    if (item.kind === 'order_hold') throw new BankError('A pending charge cannot be disputed yet (pending)', 'pay.dispute_ineligible');
    const refunded = await this.facts.isFullyRefunded(item);
    if (refunded === 'unknown') {
      throw new BankError('Whether this line was refunded is not known yet; a dispute cannot be opened', 'pay.dispute_line_facts_unset');
    }
    if (refunded === 'yes') {
      throw new BankError('This line was already refunded in full (already_refunded)', 'pay.dispute_ineligible');
    }

    const reasons = await this.sql<Array<{ code: string }>>`SELECT code FROM bank.dispute_reasons`;
    if (reasons.length === 0) {
      throw new BankError('Dispute reasons are not published yet (owner decision: legal copy)', 'pay.dispute_reasons_unset');
    }
    if (!reasons.some((r) => r.code === input.reasonCode)) {
      throw new BankError(`Unknown dispute reason ${input.reasonCode}`, 'pay.dispute_reason_unknown');
    }

    const inserted = await this.sql<CaseRow[]>`
      INSERT INTO bank.dispute_cases (id, case_key, user_id, activity_id, reason_code, statement, linked_activity_ids)
      VALUES (${disputeCaseId(key)}, ${key}, ${userId}, ${item.id}, ${input.reasonCode}, ${input.statement},
              ${this.sql.json(input.linkedActivityIds as never)})
      ON CONFLICT (case_key) DO NOTHING
      RETURNING id, user_id, activity_id, reason_code, statement, linked_activity_ids, status, created_at
    `;
    if (inserted[0]) return this.result(inserted[0]);
    const raced = await this.sql<CaseRow[]>`
      SELECT id, user_id, activity_id, reason_code, statement, linked_activity_ids, status, created_at
        FROM bank.dispute_cases WHERE case_key = ${key}
    `;
    return this.replay(raced[0]!, input);
  }

  private replay(row: CaseRow, input: { reasonCode: string; statement: string; linkedActivityIds: string[] }): PayDisputeOpenResult {
    const sameLinks = JSON.stringify([...row.linked_activity_ids].sort()) === JSON.stringify([...input.linkedActivityIds].sort());
    if (row.reason_code !== input.reasonCode || row.statement !== input.statement || !sameLinks) {
      throw new BankError('This line already has a dispute case with a different reason or statement', 'pay.dispute_conflict');
    }
    return this.result(row);
  }

  private result(row: CaseRow): PayDisputeOpenResult {
    return { routedTo: 'case', caseId: row.id, status: row.status, reasonCode: row.reason_code, createdAt: row.created_at.toISOString() };
  }
}
