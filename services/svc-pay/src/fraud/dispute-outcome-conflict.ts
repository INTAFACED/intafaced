import type { Sql } from 'postgres';
import { writeAudit } from '../control/audit.js';
import type { DisputeCaseStatus, RailResolutionOutcome } from './dispute-case.js';

/** Founder audit kind for a rail delivery that disagrees with a closed dispute. */
export const DISPUTE_OUTCOME_CONFLICT_KIND = 'pay.dispute_outcome_conflict';

/**
 * One append-only row per rail event. A retry of the same delivery does not
 * add another row. The dispute case itself is left on its first close.
 */
export async function recordDisputeOutcomeConflict(
  sql: Sql,
  input: {
    merchantId: string;
    disputeId: string;
    railEventId: string;
    railId: string;
    storedStatus: DisputeCaseStatus;
    outcome: RailResolutionOutcome;
  },
): Promise<void> {
  const existing = await sql<Array<{ id: string }>>`
    SELECT id FROM pay.control_audit
     WHERE kind = ${DISPUTE_OUTCOME_CONFLICT_KIND}
       AND after->>'railEventId' = ${input.railEventId}
     LIMIT 1
  `;
  if (existing.length > 0) return;
  await writeAudit(sql, {
    scope: 'merchant',
    scopeId: input.merchantId,
    merchantId: input.merchantId,
    kind: DISPUTE_OUTCOME_CONFLICT_KIND,
    outcome: 'conflict',
    actorId: `rail:${input.railId}`,
    reason: 'a later rail delivery named a different outcome for a dispute that was already closed',
    before: { status: input.storedStatus },
    after: {
      disputeId: input.disputeId,
      railEventId: input.railEventId,
      outcome: input.outcome,
    },
  });
}
