/**
 * The verification review queue (I-kyc-compliance-02, J-identity-20 #1 #2). Compliance works open cases oldest first, a
 * page of the owner's page size at a time (`IDENTITY_KYC_QUEUE_PAGE_SIZE`, NO DEFAULT: unset refuses
 * `kyc.queue_page_size_unset`). A case has at most one reviewer: a claim is one compare-and-set update, so of two reviewers
 * claiming at once exactly one wins and the other is refused `kyc.case_assigned`. Reviewers keep internal notes on a case,
 * append-only; they are never in anything the customer reads (`kyc.history` has no notes). Decisions stay on `kyc.approve`
 * and `kyc.reject`, with their second factor and second person.
 */
import type {
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
  | 'kyc.case_state';

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

export interface KycReviewDeskOptions {
  readonly pageSize: number | null;
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
      Array<{ user_id: string; status: KycReviewCase['recordStatus']; assigned_to: string | null; assigned_at: Date | null }>
    >`
      SELECT c.user_id, r.status, c.assigned_to, c.assigned_at
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

  private async notes(caseId: string): Promise<KycReviewNote[]> {
    const rows = await this.sql<Array<{ id: string; author_id: string; body: string; created_at: Date }>>`
      SELECT id, author_id, body, created_at FROM kyc_case_notes WHERE case_id = ${caseId} ORDER BY created_at ASC, id ASC`;
    return rows.map((r) => ({ id: r.id, authorId: r.author_id, body: r.body, at: r.created_at.toISOString() }));
  }
}
