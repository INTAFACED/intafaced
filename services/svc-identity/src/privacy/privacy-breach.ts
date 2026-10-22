/**
 * Privacy breach log (RC-identity-11): `privacy.breach.open` records the incident time and the affected-user count
 * (counts only, never a user list) and, in the same transaction, one notice request in the outbox for svc-notify.
 * Keyed on the incident id: opening the same incident twice keeps one record and one notice; the same id with other
 * values refuses. Deadlines are owner values and are not invented here.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';

export const PRIVACY_BREACH_INVALID = 'identity.privacy_breach_invalid' as const;
export const PRIVACY_BREACH_CONFLICT = 'identity.privacy_breach_conflict' as const;
export const PRIVACY_BREACH_NOTICE_KIND = 'privacy.breach_opened';

const INCIDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class PrivacyBreachError extends Error {
  constructor(readonly code: typeof PRIVACY_BREACH_INVALID | typeof PRIVACY_BREACH_CONFLICT) {
    super(code);
  }
}

export type BreachInput = { incidentId: string; occurredAt: string; affectedCount: number };
export type BreachRecord = { incidentId: string; occurredAt: string; affectedCount: number; openedAt: string; changed: boolean };

type Row = { incident_id: string; occurred_at: Date; affected_count: number; opened_at: Date };

export async function openBreach(sql: Sql, actorId: string, input: BreachInput, now: () => Date = () => new Date()): Promise<BreachRecord> {
  const incidentId = input.incidentId.trim();
  const occurredAt = new Date(input.occurredAt);
  if (
    !INCIDENT.test(incidentId) ||
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.getTime() > now().getTime() ||
    !Number.isSafeInteger(input.affectedCount) ||
    input.affectedCount < 0 ||
    input.affectedCount > 2_147_483_647
  ) {
    throw new PrivacyBreachError(PRIVACY_BREACH_INVALID);
  }
  return transaction(sql, async (tx) => {
    const inserted = await tx<Row[]>`
      INSERT INTO identity.privacy_breaches (incident_id, occurred_at, affected_count, opened_by)
      VALUES (${incidentId}, ${occurredAt}, ${input.affectedCount}, ${actorId})
      ON CONFLICT (incident_id) DO NOTHING
      RETURNING incident_id, occurred_at, affected_count, opened_at`;
    if (inserted[0]) {
      const row = inserted[0];
      await tx`
        INSERT INTO identity.privacy_breach_notices (incident_id, payload)
        VALUES (${incidentId}, ${tx.json({
          kind: PRIVACY_BREACH_NOTICE_KIND,
          incidentId,
          occurredAt: row.occurred_at.toISOString(),
          affectedCount: row.affected_count,
        } as never)})`;
      return view(row, true);
    }
    const [existing] = await tx<Row[]>`
      SELECT incident_id, occurred_at, affected_count, opened_at FROM identity.privacy_breaches WHERE incident_id = ${incidentId}`;
    if (!existing || existing.occurred_at.getTime() !== occurredAt.getTime() || existing.affected_count !== input.affectedCount) {
      throw new PrivacyBreachError(PRIVACY_BREACH_CONFLICT);
    }
    return view(existing, false);
  });
}

function view(row: Row, changed: boolean): BreachRecord {
  return {
    incidentId: row.incident_id,
    occurredAt: row.occurred_at.toISOString(),
    affectedCount: row.affected_count,
    openedAt: row.opened_at.toISOString(),
    changed,
  };
}
