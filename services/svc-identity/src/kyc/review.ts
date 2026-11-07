/**
 * The verification review queue (I-kyc-compliance-02, J-identity-20 #1 #2). Compliance works open cases oldest first, a
 * page of the owner's page size at a time (`IDENTITY_KYC_QUEUE_PAGE_SIZE`, NO DEFAULT: unset refuses
 * `kyc.queue_page_size_unset`). A case has at most one reviewer: a claim is one compare-and-set update, so of two reviewers
 * claiming at once exactly one wins and the other is refused `kyc.case_assigned`. Reviewers keep internal notes on a case,
 * append-only; they are never in anything the customer reads (`kyc.history` has no notes). Decisions stay on `kyc.approve`
 * and `kyc.reject`, with their second factor and second person.
 */
import type {
  KycAppeal,
  KycReviewAssignment,
  KycReviewCase,
  KycReviewList,
  KycReviewNote,
  KycReviewQueueRow,
} from '@intafaced/contracts/identity-kyc-cases';
import type { Sql } from 'postgres';
import { listKycCases, type KycRejectReasons } from './cases.js';

export type KycReviewErrorCode =
  | 'kyc.queue_page_size_unset'
  | 'kyc.queue_cursor_invalid'
  | 'kyc.case_unknown'
  | 'kyc.case_assigned'
  | 'kyc.case_not_assigned'
  | 'kyc.case_state'
  | 'kyc.case_final'
  | 'kyc.appeal_closed'
  | 'kyc.appeal_open'
  | 'kyc.appeal_none'
  | 'kyc.same_reviewer';

export class KycReviewError extends Error {
  constructor(
    message: string,
    readonly code: KycReviewErrorCode,
  ) {
    super(message);
    this.name = 'KycReviewError';
  }
}

/** `IDENTITY_KYC_QUEUE_PAGE_SIZE`: a whole number from 1 to 200. Unset or blank is null (the queue refuses); anything else stops the service. */
export function parseKycQueuePageSize(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 1 || n > 200)
    throw new Error('IDENTITY_KYC_QUEUE_PAGE_SIZE must be a whole number from 1 to 200');
  return n;
}

/** The queue's page marker: the last row's (submitted at, case id), so a page never repeats or skips a case. */
export function encodeQueueCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeQueueCursor(cursor: string): { at: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id, ...rest] = raw.split('|');
  const at = new Date(iso ?? '');
  if (rest.length || !id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(at.getTime()) || at.toISOString() !== iso)
    throw new KycReviewError('This page marker is not one the queue gave', 'kyc.queue_cursor_invalid');
  return { at, id };
}

interface QueueRow {
  id: string;
  record_id: string;
  user_id: string;
  tier: KycReviewQueueRow['tier'];
  jurisdiction: string;
  created_at: Date;
  assigned_to: string | null;
  assigned_at: Date | null;
}

/** `IDENTITY_KYC_RFI_DAYS`: whole days from 1 to 365. Unset or blank is null: a request for information sets no deadline. */
export function parseKycRfiDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 365)
    throw new Error('IDENTITY_KYC_RFI_DAYS must be a whole number of days from 1 to 365');
  return Number(t);
}

/** `IDENTITY_KYC_APPEAL_WINDOW_SECONDS`: whole seconds from 1 to 31,622,400 (a year). Unset or blank is null: appeals are closed. */
export function parseKycAppealWindowSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const t = raw.trim();
  const n = Number(t);
  if (!/^\d+$/.test(t) || n < 1 || n > 31_622_400)
    throw new Error('IDENTITY_KYC_APPEAL_WINDOW_SECONDS must be a whole number of seconds from 1 to 31622400');
  return n;
}

interface AppealRow {
  id: string;
  case_id: string;
  body: string;
  submitted_at: Date;
  decision: 'upheld' | 'overturned' | null;
  decided_at: Date | null;
}

function toAppeal(r: AppealRow): KycAppeal {
  return {
    id: r.id,
    caseId: r.case_id,
    body: r.body,
    submittedAt: r.submitted_at.toISOString(),
    decision: r.decision,
    decidedAt: r.decided_at?.toISOString() ?? null,
  };
}

const APPEAL_COLUMNS = 'id, case_id, body, submitted_at, decision, decided_at';

export interface KycReviewDeskOptions {
  readonly pageSize: number | null;
  /** The owner's appeal window after a rejection, in seconds. Null: appeals are closed. */
  readonly appealWindowSeconds?: number | null;
  /** The owner's deadline for a request for information, in days. Null: no deadline is set and the page says so. */
  readonly rfiDays?: number | null;
  readonly reasons: KycRejectReasons;
}

export class KycReviewDesk {
  constructor(
    private readonly sql: Sql,
    private readonly options: KycReviewDeskOptions,
  ) {}

  /** One page of open cases, oldest first. */
  async list(cursor: string | null | undefined): Promise<KycReviewList> {
    const pageSize = this.options.pageSize;
    if (pageSize === null) throw new KycReviewError('The owner has not set the review queue page size', 'kyc.queue_page_size_unset');
    const after = cursor ? decodeQueueCursor(cursor) : null;
    const rows = await this.sql<QueueRow[]>`
      SELECT c.id, c.record_id, c.user_id, r.tier, r.jurisdiction, c.created_at, c.assigned_to, c.assigned_at
      FROM kyc_cases c JOIN kyc_records r ON r.id = c.record_id
      WHERE c.state = 'submitted' AND r.status = 'pending'
        ${after ? this.sql`AND (c.created_at, c.id) > (${after.at}, ${after.id})` : this.sql``}
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT ${pageSize + 1}`;
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      pageSize,
      cases: page.map((r) => ({
        caseId: r.id,
        recordId: r.record_id,
        userId: r.user_id,
        tier: r.tier,
        jurisdiction: r.jurisdiction,
        submittedAt: r.created_at.toISOString(),
        assignedTo: r.assigned_to,
        assignedAt: r.assigned_at?.toISOString() ?? null,
      })),
      nextCursor: rows.length > pageSize && last ? encodeQueueCursor(last.created_at, last.id) : null,
    };
  }

  /** The person a case is about, or `kyc.case_unknown`. Read before a claim so nobody claims their own case. */
  async caseOwner(caseId: string): Promise<string> {
    const [row] = await this.sql<Array<{ user_id: string }>>`SELECT user_id FROM kyc_cases WHERE id = ${caseId}`;
    if (!row) throw new KycReviewError('No such verification case', 'kyc.case_unknown');
    return row.user_id;
  }

  /**
   * Claim or release a case. A claim is one compare-and-set: it takes a submitted case nobody holds (or the caller already
   * holds, which returns the stored claim). A case someone else holds refuses `kyc.case_assigned`; a decided case
   * `kyc.case_state`. Only the reviewer who holds a case releases it.
   */
  async assign(caseId: string, reviewerId: string, action: 'claim' | 'release', at = new Date()): Promise<KycReviewAssignment> {
    const rows =
      action === 'claim'
        ? await this.sql<Array<{ id: string; assigned_to: string | null; assigned_at: Date | null }>>`
            UPDATE kyc_cases SET assigned_to = ${reviewerId}, assigned_at = COALESCE(assigned_at, ${at}), updated_at = ${at}
            WHERE id = ${caseId} AND state = 'submitted' AND (assigned_to IS NULL OR assigned_to = ${reviewerId})
            RETURNING id, assigned_to, assigned_at`
        : await this.sql<Array<{ id: string; assigned_to: string | null; assigned_at: Date | null }>>`
            UPDATE kyc_cases SET assigned_to = NULL, assigned_at = NULL, updated_at = ${at}
            WHERE id = ${caseId} AND state = 'submitted' AND assigned_to = ${reviewerId}
            RETURNING id, assigned_to, assigned_at`;
    const done = rows[0];
    if (done) return { caseId: done.id, assignedTo: done.assigned_to, assignedAt: done.assigned_at?.toISOString() ?? null };
    const [row] = await this.sql<Array<{ state: string; assigned_to: string | null }>>`
      SELECT state, assigned_to FROM kyc_cases WHERE id = ${caseId}`;
    if (!row) throw new KycReviewError('No such verification case', 'kyc.case_unknown');
    if (row.state !== 'submitted')
      throw new KycReviewError(`This case is ${row.state}; only an open case can be claimed or released`, 'kyc.case_state');
    if (action === 'release') throw new KycReviewError('You do not hold this case, so you cannot release it', 'kyc.case_not_assigned');
    throw new KycReviewError('Another reviewer has already claimed this case', 'kyc.case_assigned');
  }

  /** One case for review: the case as the person sees it, its claim, the owner's reject reasons and the internal notes. */
  async read(caseId: string): Promise<KycReviewCase> {
    const [row] = await this.sql<
      Array<{
        user_id: string;
        status: KycReviewCase['recordStatus'];
        assigned_to: string | null;
        assigned_at: Date | null;
        final: boolean;
      }>
    >`
      SELECT c.user_id, r.status, c.assigned_to, c.assigned_at, c.final
      FROM kyc_cases c JOIN kyc_records r ON r.id = c.record_id WHERE c.id = ${caseId}`;
    if (!row) throw new KycReviewError('No such verification case', 'kyc.case_unknown');
    const cases = await listKycCases(this.sql, row.user_id, 200, this.options.reasons);
    const found = cases.find((c) => c.id === caseId);
    if (!found) throw new KycReviewError('No such verification case', 'kyc.case_unknown');
    return {
      userId: row.user_id,
      recordStatus: row.status,
      case: found,
      assignedTo: row.assigned_to,
      assignedAt: row.assigned_at?.toISOString() ?? null,
      reasonCodes: [...this.options.reasons.values()].map((r) => ({ code: r.code, reason: r.reason })),
      notes: await this.notes(caseId),
      final: row.final,
      appeals: await this.appeals(caseId),
    };
  }

  /** Append one internal note. Notes are never edited or removed, and never shown to the customer. */
  async addNote(caseId: string, authorId: string, body: string, at = new Date()): Promise<KycReviewNote> {
    await this.caseOwner(caseId);
    const [row] = await this.sql<Array<{ id: string; created_at: Date }>>`
      INSERT INTO kyc_case_notes (case_id, author_id, body, created_at) VALUES (${caseId}, ${authorId}, ${body}, ${at})
      RETURNING id, created_at`;
    return { id: row!.id, authorId, body, at: row!.created_at.toISOString() };
  }

  /**
   * The customer appeals their own rejected case, once per rejection, within the owner's window after the decision. A final
   * rejection refuses `kyc.case_final`; outside the window, or with no window set, `kyc.appeal_closed`. Another person's case
   * is `kyc.case_unknown`, so nobody learns it exists. The same appeal again returns the stored one.
   */
  async submitAppeal(userId: string, caseId: string, body: string, at = new Date()): Promise<KycAppeal> {
    return await this.sql.begin(async (tx) => {
      const [c] = await tx<Array<{ user_id: string; state: string; version: number; final: boolean; decided_at: Date | null }>>`
        SELECT user_id, state, version, final, decided_at FROM kyc_cases WHERE id = ${caseId} FOR UPDATE`;
      if (!c || c.user_id !== userId) throw new KycReviewError('No such verification case', 'kyc.case_unknown');
      if (c.final) throw new KycReviewError('This rejection is final; it takes no more appeals', 'kyc.case_final');
      if (c.state !== 'rejected') throw new KycReviewError(`This case is ${c.state}; only a rejection can be appealed`, 'kyc.case_state');
      const window = this.options.appealWindowSeconds ?? null;
      if (window === null) throw new KycReviewError('Appeals are closed: the owner has not set an appeal window', 'kyc.appeal_closed');
      if (!c.decided_at || at.getTime() > c.decided_at.getTime() + window * 1000)
        throw new KycReviewError('The time to appeal this rejection has passed', 'kyc.appeal_closed');
      const [prior] = await tx<AppealRow[]>`
        SELECT ${tx.unsafe(APPEAL_COLUMNS)} FROM kyc_case_appeals WHERE case_id = ${caseId} AND case_version = ${c.version}`;
      if (prior) {
        if (prior.body === body) return toAppeal(prior);
        throw new KycReviewError('This rejection already has an appeal', 'kyc.appeal_open');
      }
      const [row] = await tx<AppealRow[]>`
        INSERT INTO kyc_case_appeals (case_id, case_version, user_id, body, submitted_at)
        VALUES (${caseId}, ${c.version}, ${userId}, ${body}, ${at})
        RETURNING ${tx.unsafe(APPEAL_COLUMNS)}`;
      return toAppeal(row!);
    });
  }

  /**
   * A reviewer decides the open appeal on a rejected case. The reviewer who rejected it may not (`kyc.same_reviewer`). A final
   * rejection refuses `kyc.case_final`; no open appeal, `kyc.appeal_none`. Upholding makes the rejection final. Overturning
   * sends the request back to the queue (record pending, case submitted, one history step), unless a newer request follows it.
   */
  async decideAppeal(caseId: string, reviewerId: string, decision: 'upheld' | 'overturned', at = new Date()): Promise<KycAppeal> {
    return await this.sql.begin(async (tx) => {
      const [c] = await tx<Array<{ record_id: string; state: string; version: number; final: boolean; decided_by: string | null }>>`
        SELECT record_id, state, version, final, decided_by FROM kyc_cases WHERE id = ${caseId} FOR UPDATE`;
      if (!c) throw new KycReviewError('No such verification case', 'kyc.case_unknown');
      if (c.final) throw new KycReviewError('This rejection is final; its appeal is decided', 'kyc.case_final');
      if (c.state !== 'rejected') throw new KycReviewError(`This case is ${c.state}; only a rejection has an appeal`, 'kyc.case_state');
      const [open] = await tx<AppealRow[]>`
        SELECT ${tx.unsafe(APPEAL_COLUMNS)} FROM kyc_case_appeals
        WHERE case_id = ${caseId} AND case_version = ${c.version} AND decision IS NULL FOR UPDATE`;
      if (!open) throw new KycReviewError('This case has no appeal waiting for a decision', 'kyc.appeal_none');
      if (c.decided_by !== null && c.decided_by === reviewerId)
        throw new KycReviewError('You rejected this case; a different reviewer decides its appeal', 'kyc.same_reviewer');
      if (decision === 'upheld') {
        await tx`UPDATE kyc_cases SET final = true, updated_at = ${at} WHERE id = ${caseId}`;
      } else {
        const [follows] = await tx<Array<{ id: string }>>`SELECT id FROM kyc_cases WHERE previous_case_id = ${caseId} LIMIT 1`;
        if (follows) throw new KycReviewError('A newer request follows this case, so it cannot be reopened', 'kyc.case_state');
        const version = c.version + 1;
        await tx`UPDATE kyc_cases SET state = 'submitted', version = ${version}, decided_by = NULL, decided_at = NULL,
          assigned_to = NULL, assigned_at = NULL, updated_at = ${at} WHERE id = ${caseId}`;
        await tx`INSERT INTO kyc_case_events (case_id, version, state, at) VALUES (${caseId}, ${version}, 'submitted', ${at})`;
        await tx`UPDATE kyc_records SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL WHERE id = ${c.record_id}`;
      }
      const [row] = await tx<AppealRow[]>`
        UPDATE kyc_case_appeals SET decision = ${decision}, decided_by = ${reviewerId}, decided_at = ${at} WHERE id = ${open.id}
        RETURNING ${tx.unsafe(APPEAL_COLUMNS)}`;
      return toAppeal(row!);
    });
  }

  /**
   * A reviewer asks the customer for named items on an open case (I-kyc-compliance-03). The case moves to `info_requested`
   * with one task per item, each due by the owner's deadline (none when unset), in one transaction with its history row,
   * which the relay publishes as kycInfoRequested. Only an open (submitted) case can ask: anything else is `kyc.case_state`.
   * The same request again returns the stored tasks.
   */
  async requestInfo(
    caseId: string,
    reviewerId: string,
    items: ReadonlyArray<{ key: string; hint: string }>,
    at = new Date(),
  ): Promise<Array<{ key: string; hint: string; state: 'requested' | 'provided'; dueAt: string | null }>> {
    const keys = new Set(items.map((i) => i.key));
    if (keys.size !== items.length) throw new KycReviewError('Each item is asked for once', 'kyc.case_state');
    return await this.sql.begin(async (tx) => {
      const [c] = await tx<Array<{ state: string; version: number }>>`SELECT state, version FROM kyc_cases WHERE id = ${caseId} FOR UPDATE`;
      if (!c) throw new KycReviewError('No such verification case', 'kyc.case_unknown');
      const read = async (version: number) =>
        (
          await tx<Array<{ item_key: string; hint: string; state: 'requested' | 'provided'; due_at: Date | null }>>`
            SELECT item_key, hint, state, due_at FROM kyc_case_requests WHERE case_id = ${caseId} AND case_version = ${version}
            ORDER BY created_at, item_key`
        ).map((r) => ({ key: r.item_key, hint: r.hint, state: r.state, dueAt: r.due_at?.toISOString() ?? null }));
      if (c.state === 'info_requested') {
        const stored = await read(c.version);
        const same = stored.length === items.length && items.every((i) => stored.some((t) => t.key === i.key && t.hint === i.hint));
        if (same) return stored;
        throw new KycReviewError('This case already waits on the customer for information', 'kyc.case_state');
      }
      if (c.state !== 'submitted')
        throw new KycReviewError(`This case is ${c.state}; only an open case can ask for information`, 'kyc.case_state');
      const version = c.version + 1;
      const days = this.options.rfiDays ?? null;
      const dueAt = days === null ? null : new Date(at.getTime() + days * 86_400_000);
      await tx`UPDATE kyc_cases SET state = 'info_requested', version = ${version}, updated_at = ${at} WHERE id = ${caseId}`;
      await tx`INSERT INTO kyc_case_events (case_id, version, state, reason_code, at)
        VALUES (${caseId}, ${version}, 'info_requested', ${items[0]!.key}, ${at})`;
      for (const item of items)
        await tx`INSERT INTO kyc_case_requests (case_id, case_version, item_key, hint, due_at, requested_by, created_at)
          VALUES (${caseId}, ${version}, ${item.key}, ${item.hint}, ${dueAt}, ${reviewerId}, ${at})`;
      return await read(version);
    });
  }

  private async appeals(caseId: string): Promise<KycAppeal[]> {
    const rows = await this.sql<AppealRow[]>`
      SELECT ${this.sql.unsafe(APPEAL_COLUMNS)} FROM kyc_case_appeals WHERE case_id = ${caseId} ORDER BY submitted_at ASC, id ASC`;
    return rows.map(toAppeal);
  }

  private async notes(caseId: string): Promise<KycReviewNote[]> {
    const rows = await this.sql<Array<{ id: string; author_id: string; body: string; created_at: Date }>>`
      SELECT id, author_id, body, created_at FROM kyc_case_notes WHERE case_id = ${caseId} ORDER BY created_at ASC, id ASC`;
    return rows.map((r) => ({ id: r.id, authorId: r.author_id, body: r.body, at: r.created_at.toISOString() }));
  }
}
