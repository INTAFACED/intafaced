import type { Sql } from 'postgres';
import type { CaseView } from './desk-schemas.js';
import type { ScreeningCaseStatus, ScreeningFactor } from './decision.js';
import type { ScreeningSubjectKind } from './store.js';

/** Row access for the compliance desk. SQL only; every rule is in desk-service.ts. */
export interface CaseRow {
  subject_kind: ScreeningSubjectKind;
  subject_key: string;
  status: ScreeningCaseStatus;
  factors: Array<{ code: string }>;
  provider: string | null;
  party_ref: string | null;
  amount: string | null;
  asset_id: string | null;
  created_at: Date;
  updated_at: Date;
  decision: 'released' | 'upheld' | null;
  decided_by: string | null;
  approver_id: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
  release_expires_at: Date | null;
  release_consumed_at: Date | null;
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export const caseView = (r: CaseRow): CaseView => ({
  subjectKind: r.subject_kind,
  caseId: r.subject_key,
  status: r.status,
  factors: r.factors.map((f) => f.code),
  provider: r.provider,
  partyRef: r.party_ref,
  amount: r.amount,
  assetId: r.asset_id,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  decision: r.decision,
  decidedBy: r.decided_by,
  approverId: r.approver_id,
  decisionReason: r.decision_reason,
  decidedAt: iso(r.decided_at),
  releaseExpiresAt: iso(r.release_expires_at),
  releaseSpentAt: iso(r.release_consumed_at),
});

export async function getCase(sql: Sql, kind: ScreeningSubjectKind, key: string, forUpdate = false): Promise<CaseRow | null> {
  const rows = forUpdate
    ? await sql<CaseRow[]>`SELECT * FROM pay.screening_cases WHERE subject_kind = ${kind} AND subject_key = ${key} FOR UPDATE`
    : await sql<CaseRow[]>`SELECT * FROM pay.screening_cases WHERE subject_kind = ${kind} AND subject_key = ${key}`;
  return rows[0] ?? null;
}

/** Newest update first; the cursor is the last row's `updated_at` and key, so a page never repeats or skips a row. */
export async function listCases(
  sql: Sql,
  q: { limit: number; status?: string | undefined; kind?: string | undefined; after?: { at: Date; key: string } | undefined },
): Promise<CaseRow[]> {
  return sql<CaseRow[]>`
    SELECT * FROM pay.screening_cases
     WHERE (${q.status ?? null}::text IS NULL OR status = ${q.status ?? null})
       AND (${q.kind ?? null}::text IS NULL OR subject_kind = ${q.kind ?? null})
       AND (${q.after?.at ?? null}::timestamptz IS NULL OR (updated_at, subject_key) < (${q.after?.at ?? null}::timestamptz, ${q.after?.key ?? null}::text))
     ORDER BY updated_at DESC, subject_key DESC
     LIMIT ${q.limit}`;
}

export interface EventRow {
  id: string;
  seq: string;
  action: 'release' | 'uphold' | 'rescreen' | 'release_spent';
  actor_id: string;
  approver_id: string | null;
  from_status: ScreeningCaseStatus;
  to_status: ScreeningCaseStatus;
  reason: string;
  created_at: Date;
}

export async function listEvents(sql: Sql, kind: ScreeningSubjectKind, key: string): Promise<EventRow[]> {
  return sql<EventRow[]>`
    SELECT id, seq, action, actor_id, approver_id, from_status, to_status, reason, created_at
      FROM pay.screening_case_events WHERE subject_kind = ${kind} AND subject_key = ${key} ORDER BY seq DESC LIMIT 200`;
}

export async function appendEvent(
  sql: Sql,
  e: {
    kind: ScreeningSubjectKind;
    key: string;
    action: EventRow['action'];
    actorId: string;
    approverId: string | null;
    from: ScreeningCaseStatus;
    to: ScreeningCaseStatus;
    decision: 'released' | 'upheld' | null;
    reason: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO pay.screening_case_events (subject_kind, subject_key, action, actor_id, approver_id, from_status, to_status, decision, reason)
    VALUES (${e.kind}, ${e.key}, ${e.action}, ${e.actorId}, ${e.approverId}, ${e.from}, ${e.to}, ${e.decision}, ${e.reason})`;
}

export async function writeDecision(
  sql: Sql,
  d: {
    kind: ScreeningSubjectKind;
    key: string;
    decision: 'released' | 'upheld';
    actorId: string;
    approverId: string | null;
    reason: string;
    releaseExpiresAt: Date | null;
  },
): Promise<void> {
  await sql`
    UPDATE pay.screening_cases
       SET decision = ${d.decision}, decided_by = ${d.actorId}, approver_id = ${d.approverId}, decision_reason = ${d.reason},
           decided_at = now(), release_expires_at = ${d.releaseExpiresAt}, updated_at = now()
     WHERE subject_kind = ${d.kind} AND subject_key = ${d.key}`;
}

export async function writeRescreen(
  sql: Sql,
  d: { kind: ScreeningSubjectKind; key: string; status: ScreeningCaseStatus; factors: readonly ScreeningFactor[]; provider: string },
): Promise<void> {
  await sql`
    UPDATE pay.screening_cases
       SET status = ${d.status}, factors = ${sql.json(d.factors.map((f) => ({ code: f.code })))}, provider = ${d.provider}, updated_at = now()
     WHERE subject_kind = ${d.kind} AND subject_key = ${d.key}`;
}
