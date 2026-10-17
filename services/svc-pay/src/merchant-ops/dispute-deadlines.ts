import type { Sql } from 'postgres';

/**
 * Record the due date a rail event actually carried.
 *
 * `evidenceDueBy === null` means this event did not include one. The first
 * insert stores that fact. A later event may fill a null. A date already
 * stored is left alone: the opening rail date is not replaced by a guess or
 * by a different later timestamp.
 */
export async function recordRailDisputeDeadline(
  sql: Sql,
  input: {
    merchantId: string;
    disputeId: string;
    evidenceDueBy: Date | null;
    railEventId: string;
  },
): Promise<void> {
  const disputeId = input.disputeId.trim();
  const railEventId = input.railEventId.trim();
  if (!disputeId || !railEventId) return;
  await sql`
    INSERT INTO pay.dispute_response_deadlines (merchant_id, dispute_id, response_due_at, rail_event_id)
    VALUES (${input.merchantId}, ${disputeId}, ${input.evidenceDueBy}, ${railEventId})
    ON CONFLICT (merchant_id, dispute_id) DO UPDATE
      SET response_due_at = EXCLUDED.response_due_at,
          rail_event_id = EXCLUDED.rail_event_id,
          recorded_at = now()
    WHERE pay.dispute_response_deadlines.response_due_at IS NULL
      AND EXCLUDED.response_due_at IS NOT NULL
  `;
}
