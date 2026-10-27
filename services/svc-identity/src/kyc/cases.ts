/**
 * KYC cases (I-kyc-compliance-01, J-identity-08 #6). A case is one verification request and what was decided on it.
 * It opens with its pending `kyc_records` row and moves with that row, in the caller's transaction, so the record and
 * its case never disagree. Each transition appends one `kyc_case_events` row; the relay publishes `kycSubmitted` and
 * `kycRejected` from those rows after commit (approval keeps its own `kycApproved`).
 *
 * The reject reasons are the owner's list (`IDENTITY_KYC_REJECT_REASONS`, NO DEFAULT): a code, the reason the customer
 * reads and what to do about it. Unset, a reject is refused (`kyc.reason_codes_unset`), never sent without a reason.
 */
import type { EventBus } from '@intafaced/events';
import { kycReasonCodeSchema, type KycCase, type KycCaseState } from '@intafaced/contracts/identity-kyc-cases';
import type { Sql } from 'postgres';

export type KycCaseErrorCode = 'kyc.reason_codes_unset' | 'kyc.reason_code_unknown' | 'kyc.case_state';

export class KycCaseError extends Error {
  constructor(
    message: string,
    readonly code: KycCaseErrorCode,
  ) {
    super(message);
    this.name = 'KycCaseError';
  }
}

export interface KycRejectReason {
  readonly code: string;
  readonly reason: string;
  readonly guidance: string;
}
export type KycRejectReasons = ReadonlyMap<string, KycRejectReason>;

/**
 * `IDENTITY_KYC_REJECT_REASONS`: a JSON array of `{ "code", "reason", "guidance" }`. A code is lower case with
 * underscores; `reason` (up to 200 characters) is what the customer reads, `guidance` (up to 500) what to do next.
 * Unset or blank is an empty list. An empty array, a repeated code or a malformed entry stops the service. The capability
 * switch-off reasons (`IDENTITY_KYC_CAPABILITY_REASONS`, I-kyc-compliance-07) have the same shape and are parsed here
 * under their own name.
 */
export function parseKycRejectReasons(raw: string | undefined, setting = 'IDENTITY_KYC_REJECT_REASONS'): KycRejectReasons {
  const out = new Map<string, KycRejectReason>();
  if (raw === undefined || raw.trim() === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${setting} must be a JSON array of { code, reason, guidance }`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${setting} must list at least one reason`);
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${setting}: every entry is an object`);
    const { code, reason, guidance, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length) throw new Error(`${setting}: unknown field ${Object.keys(rest)[0]}`);
    if (!kycReasonCodeSchema.safeParse(code).success) throw new Error(`${setting}: ${JSON.stringify(code)} is not a reason code`);
    const key = code as string;
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 200)
      throw new Error(`${setting}: ${key} needs a reason of 1 to 200 characters`);
    if (typeof guidance !== 'string' || guidance.trim().length === 0 || guidance.length > 500)
      throw new Error(`${setting}: ${key} needs guidance of 1 to 500 characters`);
    if (out.has(key)) throw new Error(`${setting}: ${key} is listed twice`);
    out.set(key, { code: key, reason, guidance });
  }
  return out;
}

/** The owner's reason for `code`, or a typed refusal. Checked before anything is spent or written. */
export function requireRejectReason(reasons: KycRejectReasons, code: string, list = 'reject reasons'): KycRejectReason {
  if (reasons.size === 0) throw new KycCaseError(`The owner has not published a list of ${list}`, 'kyc.reason_codes_unset');
  const reason = reasons.get(code);
  if (!reason) throw new KycCaseError(`${code} is not on the owner's list of ${list}`, 'kyc.reason_code_unknown');
  return reason;
}

/** What a reject tells the customer: the listed code, the reviewer's note and whether the customer sees it. */
export interface KycRejectDecision {
  readonly reasonCode: string;
  readonly customerNote: string | null;
  readonly noteVisible: boolean;
}

/**
 * The fields the four-eyes approval of `kyc.reject` binds: the record and everything the customer will read, so the
 * second operator approves the reason, the note and whether it shows, not only the record.
 */
export function kycRejectApprovalFields(input: { recordId: string } & KycRejectDecision): Record<string, string> {
  return {
    recordId: input.recordId,
    reasonCode: input.reasonCode,
    customerNote: input.customerNote ?? '',
    noteVisible: input.noteVisible ? 'true' : 'false',
  };
}

/** The same reject again (code, note and visibility), which returns the stored result instead of refusing. */
function sameReject(row: { reason_code: string | null; customer_note: string | null; note_visible: boolean }, d: KycRejectDecision) {
  return row.reason_code === d.reasonCode && row.customer_note === d.customerNote && row.note_visible === d.noteVisible;
}

function rejectedAlready(reasonCode: string | null): KycCaseError {
  return new KycCaseError(
    reasonCode === null
      ? 'This case was rejected before reject reasons existed; a reason cannot be added afterwards'
      : `This case is already rejected with ${reasonCode}; a different reason or note needs a new request`,
    'kyc.case_state',
  );
}

interface CaseRow {
  id: string;
  user_id: string;
  record_id: string;
  previous_case_id: string | null;
  state: KycCaseState;
  version: number;
  reason_code: string | null;
  customer_note: string | null;
  note_visible: boolean;
}

/**
 * Open the case for a record just inserted as pending. A resubmission follows the person's newest rejected case at the
 * same level that no other case follows yet. Writes history version 1, to be published as `kycSubmitted`.
 */
export async function openKycCase(tx: Sql, record: { id: string; userId: string; tier: string; createdAt: Date }): Promise<string> {
  const [previous] = await tx<Array<{ id: string }>>`
    SELECT c.id FROM kyc_cases c JOIN kyc_records r ON r.id = c.record_id
    WHERE c.user_id = ${record.userId} AND c.state = 'rejected' AND r.tier = ${record.tier}
      AND NOT EXISTS (SELECT 1 FROM kyc_cases n WHERE n.previous_case_id = c.id)
    ORDER BY c.created_at DESC, c.id DESC LIMIT 1`;
  const [opened] = await tx<Array<{ id: string }>>`
    INSERT INTO kyc_cases (user_id, record_id, previous_case_id, state, version, created_at, updated_at)
    VALUES (${record.userId}, ${record.id}, ${previous?.id ?? null}, 'submitted', 1, ${record.createdAt}, ${record.createdAt})
    RETURNING id`;
  await tx`INSERT INTO kyc_case_events (case_id, version, state, at) VALUES (${opened!.id}, 1, 'submitted', ${record.createdAt})`;
  return opened!.id;
}

/** The record a case moves with, as the transition's caller read it under its own lock. */
export interface KycCaseRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly createdAt: Date;
  readonly reviewedAt: Date | null;
}

/**
 * The record's case, locked. A record that has none (made before cases, or by a test fixture) gets one here in the
 * record's own state, its history marked published so it is never announced late.
 */
async function lockCase(tx: Sql, record: KycCaseRecord): Promise<CaseRow> {
  const state: KycCaseState = record.status === 'pending' ? 'submitted' : record.status;
  const decided = state === 'submitted' ? null : (record.reviewedAt ?? record.createdAt);
  const inserted = await tx<Array<{ id: string }>>`
    INSERT INTO kyc_cases (user_id, record_id, state, version, decided_at, backfilled, created_at, updated_at)
    VALUES (${record.userId}, ${record.id}, ${state}, ${decided ? 2 : 1}, ${decided}, ${decided !== null}, ${record.createdAt},
      ${decided ?? record.createdAt})
    ON CONFLICT (record_id) DO NOTHING RETURNING id`;
  if (inserted[0]) {
    await tx`INSERT INTO kyc_case_events (case_id, version, state, at, published_at)
      VALUES (${inserted[0].id}, 1, 'submitted', ${record.createdAt}, now())`;
    if (decided)
      await tx`INSERT INTO kyc_case_events (case_id, version, state, at, published_at)
        VALUES (${inserted[0].id}, 2, ${state}, ${decided}, now())`;
  }
  const [row] = await tx<CaseRow[]>`
    SELECT id, user_id, record_id, previous_case_id, state, version, reason_code, customer_note, note_visible FROM kyc_cases
    WHERE record_id = ${record.id} FOR UPDATE`;
  return row!;
}

/**
 * Move the record's case to approved, with its history row, and return the case id. Approval announces itself through
 * `kycApproved`.
 */
export async function approveKycCase(tx: Sql, record: KycCaseRecord, decision: { by: string; at: Date }): Promise<string> {
  const row = await lockCase(tx, record);
  if (row.state === 'approved') return row.id;
  const version = row.version + 1;
  await tx`UPDATE kyc_cases SET state = 'approved', version = ${version}, decided_by = ${decision.by}, decided_at = ${decision.at},
    updated_at = ${decision.at} WHERE id = ${row.id}`;
  await tx`INSERT INTO kyc_case_events (case_id, version, state, at, published_at)
    VALUES (${row.id}, ${version}, 'approved', ${decision.at}, ${decision.at})`;
  return row.id;
}

/**
 * Move the record's case to rejected with a listed reason, with its history row (published as `kycRejected`). Pass
 * the record as the caller read it under its lock, before it moved. The same reject again (code, note and visibility)
 * is the same decision and returns; anything else on a rejected case is refused (`kyc.case_state`), so a retry never
 * rewrites what the customer read, nor reports a note as sent that never was. Returns the case id.
 */
export async function rejectKycCase(
  tx: Sql,
  record: KycCaseRecord,
  decision: { by: string; at: Date } & KycRejectDecision,
): Promise<string> {
  const row = await lockCase(tx, record);
  if (row.state === 'rejected') {
    if (sameReject(row, decision)) return row.id;
    throw rejectedAlready(row.reason_code);
  }
  if (row.state !== 'submitted')
    throw new KycCaseError(`This case is ${row.state}; only a submitted case can be rejected`, 'kyc.case_state');
  const version = row.version + 1;
  await tx`UPDATE kyc_cases SET state = 'rejected', version = ${version}, reason_code = ${decision.reasonCode},
    customer_note = ${decision.customerNote}, note_visible = ${decision.noteVisible}, decided_by = ${decision.by},
    decided_at = ${decision.at}, updated_at = ${decision.at} WHERE id = ${row.id}`;
  await tx`INSERT INTO kyc_case_events (case_id, version, state, reason_code, at)
    VALUES (${row.id}, ${version}, 'rejected', ${decision.reasonCode}, ${decision.at})`;
  return row.id;
}

/**
 * Before a reject spends its four-eyes approval: a record that is no longer pending would be refused afterwards, so it
 * is refused here first (`kyc.case_state`). The same reject again passes, to return the stored result. The decision's
 * own transaction checks again under its lock.
 */
export async function assertRejectable(sql: Sql, recordId: string, decision: KycRejectDecision): Promise<void> {
  const [row] = await sql<
    Array<{ status: string; reason_code: string | null; customer_note: string | null; note_visible: boolean | null }>
  >`
    SELECT r.status, c.reason_code, c.customer_note, c.note_visible
    FROM kyc_records r LEFT JOIN kyc_cases c ON c.record_id = r.id WHERE r.id = ${recordId}`;
  if (!row || row.status === 'pending') return;
  if (row.status === 'rejected') {
    if (sameReject({ ...row, note_visible: row.note_visible ?? false }, decision)) return;
    throw rejectedAlready(row.reason_code);
  }
  throw new KycCaseError(`This request is ${row.status}; only a pending request can be rejected`, 'kyc.case_state');
}

/**
 * A person's cases, newest first, with their history and the owner's current text for each reason, read in one
 * statement so a case and its steps always agree. An approval whose level has lapsed (`kyc_records.expires_at` passed)
 * reads as expired, with an expired step at the lapse time; nothing is written for it.
 */
export async function listKycCases(sql: Sql, userId: string, limit: number, reasons: KycRejectReasons): Promise<KycCase[]> {
  const rows = await sql<
    Array<{
      id: string;
      record_id: string;
      tier: KycCase['tier'];
      jurisdiction: string;
      state: KycCaseState;
      version: number;
      previous_case_id: string | null;
      created_at: Date;
      decided_at: Date | null;
      expires_at: Date | null;
      lapsed: boolean;
      reason_code: string | null;
      customer_note: string | null;
      note_visible: boolean;
      history: Array<{ version: number; state: KycCaseState; at: string }>;
    }>
  >`
    SELECT c.id, c.record_id, r.tier, r.jurisdiction, c.state, c.version, c.previous_case_id, c.created_at, c.decided_at,
           r.expires_at, (c.state = 'approved' AND r.expires_at IS NOT NULL AND r.expires_at <= now()) AS lapsed,
           c.reason_code, c.customer_note, c.note_visible,
           COALESCE((SELECT json_agg(json_build_object('version', e.version, 'state', e.state, 'at', e.at) ORDER BY e.version)
                     FROM kyc_case_events e WHERE e.case_id = c.id), '[]'::json) AS history
    FROM kyc_cases c JOIN kyc_records r ON r.id = c.record_id
    WHERE c.user_id = ${userId}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit}`;
  return rows.map((c) => {
    const listed = c.reason_code ? reasons.get(c.reason_code) : undefined;
    const history = c.history.map((e) => ({ version: e.version, state: e.state, at: new Date(e.at).toISOString() }));
    if (c.lapsed && c.expires_at) history.push({ version: c.version + 1, state: 'expired', at: c.expires_at.toISOString() });
    return {
      id: c.id,
      recordId: c.record_id,
      tier: c.tier,
      jurisdiction: c.jurisdiction,
      state: c.lapsed ? 'expired' : c.state,
      // A lapsed approval's last step is the expired one, so the case reads at that step's version.
      version: c.lapsed ? c.version + 1 : c.version,
      followsCaseId: c.previous_case_id,
      submittedAt: c.created_at.toISOString(),
      decidedAt: c.decided_at?.toISOString() ?? null,
      expiresAt: c.expires_at?.toISOString() ?? null,
      reason: c.reason_code ? { code: c.reason_code, text: listed?.reason ?? null, guidance: listed?.guidance ?? null } : null,
      note: c.note_visible && c.customer_note ? c.customer_note : null,
      history,
    };
  });
}

export interface KycCaseRelayDeps {
  readonly sql: Sql;
  readonly bus: Pick<EventBus, 'publish'>;
  readonly now: () => Date;
}

/**
 * Publish the history rows not yet published, case by case, oldest first. One case per short transaction: a try-lock
 * on the case id is the claim (it never waits on, or holds, the row a decision locks), its rows go out in version
 * order, and each is marked only after its publish returns, so a crash in between publishes again with the same
 * business key and never loses one, and a case's events never pass each other. A case whose publish throws is left for
 * the next run and the other cases still go out; the first error is thrown once the run is over.
 */
export async function relayKycCaseEvents(deps: KycCaseRelayDeps, limit = 50): Promise<number> {
  const due = await deps.sql<Array<{ case_id: string }>>`
    SELECT case_id FROM kyc_case_events WHERE published_at IS NULL GROUP BY case_id ORDER BY min(at), case_id LIMIT ${limit}`;
  let published = 0;
  let failure: unknown;
  for (const { case_id } of due) {
    try {
      published += await relayCase(deps, case_id);
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== undefined) throw failure;
  return published;
}

async function relayCase(deps: KycCaseRelayDeps, caseId: string): Promise<number> {
  return deps.sql.begin(async (tx) => {
    // The claim is a lock on the case id, not on its row: a decision locks the row, and a slow publish here must never
    // hold up a reviewer whose approval is already spent. Rows a decision appends meanwhile go out on the next run.
    const [claim] = await tx<Array<{ claimed: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended('identity.kyc_case_relay:' || ${caseId}, 0)) AS claimed`;
    // Another run holds it: the next run sends what is still due.
    if (!claim?.claimed) return 0;
    const [held] = await tx<Array<{ user_id: string; previous_case_id: string | null }>>`
      SELECT user_id, previous_case_id FROM kyc_cases WHERE id = ${caseId}`;
    if (!held) return 0;
    const rows = await tx<Array<{ id: string; version: number; state: KycCaseState; reason_code: string | null; at: Date }>>`
      SELECT id, version, state, reason_code, at FROM kyc_case_events
      WHERE case_id = ${caseId} AND published_at IS NULL ORDER BY version`;
    let sent = 0;
    for (const row of rows) {
      const at = new Date(row.at).toISOString();
      if (row.state === 'submitted') {
        await deps.bus.publish(
          'kycSubmitted',
          { userId: held.user_id, caseId, version: row.version, previousCaseId: held.previous_case_id, submittedAt: at },
          { idempotencyKey: `identity.kyc.submitted:${caseId}:${row.version}` },
        );
        sent += 1;
      } else if (row.state === 'rejected' && row.reason_code) {
        await deps.bus.publish(
          'kycRejected',
          { userId: held.user_id, caseId, version: row.version, reasonCode: row.reason_code, rejectedAt: at },
          { idempotencyKey: `identity.kyc.rejected:${caseId}:${row.version}` },
        );
        sent += 1;
      }
      await tx`UPDATE kyc_case_events SET published_at = ${deps.now()} WHERE id = ${row.id}`;
    }
    return sent;
  });
}
