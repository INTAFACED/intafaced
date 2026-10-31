/**
 * AC-assignments-01 — assignments on course items, and the work learners hand in.
 *
 * Staff save an assignment item's brief over the revision they read: instructions, points as a decimal string, an
 * optional due date, and whether a text answer and a file are off, optional or required. A saved brief releases the item
 * to enrolled learners; withdrawing keeps the brief and every hand-in, and stops new ones.
 *
 * A learner reads and writes only their own rows; the account is always the signed principal. Only a learner with an
 * open enrolment in the published course reads the brief or hands in (`academy.enrolment_required`). A file answer is
 * checked against the owner's upload limits (any blank refuses `academy.upload_limits_unset`), its leading bytes against
 * its declared type, and is stored in our own object store, keyed by its SHA-256 per learner and item, so the same file
 * is the same row. A hand-in is version n of the learner's work, keyed `submit:<item>:<account>:<n>`: the version comes
 * from the read the learner handed in against, so a retry after a lost reply returns the stored row and is never a second
 * hand-in. Late is worked out on each read against the due date and never stored. The course has no late rule until
 * gradebook setup (AC-assignments-04), so none is shown. No money moves here.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { ACADEMY_ASSIGNMENT_FILE_INLINE_MAX_BYTES } from '@intafaced/contracts';
import type {
  AcademyAdminAssignment,
  AcademyAnswerMode,
  AcademyAssignmentView,
  AcademySaveAssignmentInput,
  AcademySubmissionFile,
  AcademySubmissionState,
  AcademySubmitAssignmentInput,
  AcademyUploadAssignmentFileInput,
  AcademyWithdrawAssignmentInput,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { assertItemOpen } from './course-release.js';
import { dueFor } from './course-item-rules.js';
import { latePolicyOf } from './late-policy.js';
import { isVideoStorageConfigured, signPutObjectUrl, type VideoStorageConfig } from '../video/storage.js';
import { canonicalPrice } from './courses.js';
import { FILE_SIGNATURES, signatureMatches } from './media.js';
import { reviewStepsOf } from './peer-review.js';
import { learnerGradeOf } from './grading.js';

/** Hand-ins shown on the learner's page, newest first. */
const SUBMISSIONS_SHOWN = 50;

export type SubmissionFileLimits = { readonly maxBytes: number | null; readonly types: readonly string[] | null };

/** Stores a learner's file bytes at a signed PUT address; answers with the store's status. Swapped in tests. */
export type PutObjectFn = (url: string, bytes: Uint8Array, contentType: string) => Promise<number>;

export const putOverHttp: PutObjectFn = async (url, bytes, contentType) => {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  await res.body?.cancel().catch(() => undefined);
  return res.status;
};

type BriefRow = {
  item_id: string;
  course_id: string;
  title: string;
  kind: string;
  revision: number | null;
  instructions: string | null;
  points: string | null;
  due_at: Date | null;
  text_mode: AcademyAnswerMode | null;
  file_mode: AcademyAnswerMode | null;
  saved_by: string | null;
  saved_at: Date | null;
  withdrawn_at: Date | null;
  withdraw_reason: string | null;
};

type LearnerRow = BriefRow & { course_slug: string; course_title: string; course_state: string; enrolled: boolean };

type FileRow = { id: string; file_name: string; content_type: string; bytes: string | number | bigint };

type SubmissionRow = {
  version: number;
  state: AcademySubmissionState;
  text: string | null;
  submitted_at: Date;
  file_id: string | null;
  file_name: string | null;
  content_type: string | null;
  bytes: string | number | bigint | null;
};

const fileOf = (row: FileRow): AcademySubmissionFile => ({
  id: row.id,
  fileName: row.file_name,
  contentType: row.content_type,
  bytes: Number(row.bytes),
});

/** The brief's columns, read the same way by the staff and the learner reads. */
const briefColumns = (sql: Sql | TransactionSql) => sql`
  i.id AS item_id, i.course_id, i.title, i.kind, a.revision, a.instructions, a.points::text AS points, a.due_at,
  a.text_mode, a.file_mode, a.saved_by, a.saved_at, a.withdrawn_at, a.withdraw_reason
`;

export class CourseAssignments {
  constructor(
    private readonly sql: Sql,
    private readonly storage: VideoStorageConfig | null,
    private readonly limits: SubmissionFileLimits,
    private readonly put: PutObjectFn = putOverHttp,
  ) {}

  /** An assignment item as staff see it: its brief (null until first saved), who saved it, and how many handed in. */
  async adminView(itemId: string): Promise<AcademyAdminAssignment> {
    return this.adminIn(this.sql, itemId);
  }

  /** The brief, over the revision read. Each save is the next revision; a withdrawn assignment is not edited. */
  async save(input: AcademySaveAssignmentInput & { operatorId: string; now: Date }): Promise<AcademyAdminAssignment> {
    return this.sql.begin(async (tx) => {
      const row = await this.lockBrief(tx, input.itemId);
      const revision = row.revision ?? 0;
      if (revision !== input.revision)
        throw new AcademyError(`the assignment is at revision ${revision}, not ${input.revision}`, 'academy.revision_stale');
      if (row.withdrawn_at) throw new AcademyError('a withdrawn assignment is not edited', 'academy.assignment_closed');
      await tx`
        INSERT INTO academy.course_assignments
          (item_id, revision, instructions, points, due_at, text_mode, file_mode, saved_by, saved_at)
        VALUES (${row.item_id}, ${revision + 1}, ${input.instructions}, ${input.points}, ${input.dueAt}, ${input.text}, ${input.file},
                ${input.operatorId}, ${input.now})
        ON CONFLICT (item_id) DO UPDATE SET
          revision = EXCLUDED.revision, instructions = EXCLUDED.instructions, points = EXCLUDED.points, due_at = EXCLUDED.due_at,
          text_mode = EXCLUDED.text_mode, file_mode = EXCLUDED.file_mode, saved_by = EXCLUDED.saved_by, saved_at = EXCLUDED.saved_at
      `;
      return this.adminIn(tx, row.item_id);
    });
  }

  /** Learners can no longer hand in; the brief and every hand-in stay. A repeat answers with the withdrawn assignment. */
  async withdraw(input: AcademyWithdrawAssignmentInput & { operatorId: string; now: Date }): Promise<AcademyAdminAssignment> {
    return this.sql.begin(async (tx) => {
      const row = await this.lockBrief(tx, input.itemId);
      if (row.revision === null) throw new AcademyError('the assignment has no brief to withdraw', 'academy.assignment_not_found');
      await tx`
        UPDATE academy.course_assignments
        SET withdrawn_at = ${input.now}, withdrawn_by = ${input.operatorId}, withdraw_reason = ${input.reason}
        WHERE item_id = ${row.item_id} AND withdrawn_at IS NULL
      `;
      return this.adminIn(tx, row.item_id);
    });
  }

  /** The assignment as the enrolled learner sees it, with their own hand-ins, newest first. Writes nothing. */
  async learnerView(input: { itemId: string; userId: string }): Promise<AcademyAssignmentView> {
    return this.learnerIn(this.sql, input.itemId, input.userId);
  }

  /**
   * A file for the learner's next hand-in: checked against the owner's limits and its declared type, then stored. The
   * same file from the same learner for the same item is the same row, so a retry stores nothing twice.
   */
  async uploadFile(input: AcademyUploadAssignmentFileInput & { userId: string; now: Date }): Promise<AcademySubmissionFile> {
    const row = await this.learnerRow(this.sql, input.itemId, input.userId);
    if (row.withdrawn_at) throw new AcademyError('staff withdrew this assignment', 'academy.assignment_closed');
    if (row.file_mode === 'off') throw new AcademyError('this assignment takes no file', 'academy.upload_type_refused');
    const { types } = this.requireLimits();
    const maxBytes = this.fileMaxBytes()!;
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.byteLength === 0) throw new AcademyError('the file is empty', 'academy.upload_incomplete');
    if (bytes.byteLength > maxBytes)
      throw new AcademyError(`the file is ${bytes.byteLength} bytes; the limit is ${maxBytes}`, 'academy.upload_too_large');
    if (!types.includes(input.contentType) || !FILE_SIGNATURES[input.contentType])
      throw new AcademyError(`${input.contentType} is not an accepted file type`, 'academy.upload_type_refused');
    if (!signatureMatches(bytes.subarray(0, 16), FILE_SIGNATURES[input.contentType]!))
      throw new AcademyError(`the file was declared ${input.contentType} but its content is not`, 'academy.file_type_mismatch');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const [stored] = await this.sql<FileRow[]>`
      SELECT id, file_name, content_type, bytes FROM academy.assignment_files
      WHERE item_id = ${row.item_id} AND user_id = ${input.userId} AND sha256 = ${sha256}
    `;
    if (stored) return fileOf(stored);
    if (!isVideoStorageConfigured(this.storage))
      throw new AcademyError('File storage is not configured', 'academy.video_storage_unconfigured');
    const objectKey = `courses/${row.course_id}/items/${row.item_id}/submissions/${input.userId}/${sha256}`;
    const { uploadUrl } = signPutObjectUrl(this.storage, objectKey, input.now);
    const status = await this.put(uploadUrl, bytes, input.contentType);
    if (status < 200 || status >= 300) throw new AcademyError('the file did not reach storage; send it again', 'academy.upload_incomplete');
    // Only after the bytes are stored is the row written; two racing uploads of the same file share one row.
    const [created] = await this.sql<FileRow[]>`
      INSERT INTO academy.assignment_files (item_id, user_id, sha256, file_name, content_type, bytes, object_key, created_at)
      VALUES (${row.item_id}, ${input.userId}, ${sha256}, ${input.fileName}, ${input.contentType}, ${bytes.byteLength}, ${objectKey}, ${input.now})
      ON CONFLICT (item_id, user_id, sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
      RETURNING id, file_name, content_type, bytes
    `;
    return fileOf(created!);
  }

  /**
   * Version `version` of the learner's hand-in, keyed `submit:<item>:<account>:<version>`. A version already stored is
   * answered as it stands; one that skips ahead or falls behind the next free version refuses as stale. What the brief
   * requires is checked before anything is written.
   */
  async submit(input: AcademySubmitAssignmentInput & { userId: string; now: Date }): Promise<AcademyAssignmentView> {
    return this.sql.begin(async (tx) => {
      const row = await this.learnerRow(tx, input.itemId, input.userId, true);
      // One statement, one snapshot: a racing send that commits between two reads would otherwise read as stale.
      const [counted] = await tx<Array<{ stored: boolean; next: number }>>`
        SELECT coalesce(bool_or(version = ${input.version}), false) AS stored,
          coalesce(max(version), 0)::int + 1 AS next
        FROM academy.assignment_submissions
        WHERE item_id = ${row.item_id} AND user_id = ${input.userId}
      `;
      if (counted!.stored) return this.viewOf(tx, row, input.userId);
      const next = counted!.next;
      if (input.version !== next)
        throw new AcademyError(
          `the next hand-in is version ${next}, not ${input.version}; read the assignment again`,
          'academy.submission_version_stale',
        );
      if (row.withdrawn_at) throw new AcademyError('staff withdrew this assignment', 'academy.assignment_closed');
      const text = input.text?.trim() ? input.text : null;
      if (text !== null && row.text_mode === 'off')
        throw new AcademyError('this assignment takes no text answer', 'academy.submission_incomplete');
      if (input.fileId !== null && row.file_mode === 'off')
        throw new AcademyError('this assignment takes no file', 'academy.submission_incomplete');
      const missing = [
        ...(row.text_mode === 'required' && text === null ? ['text'] : []),
        ...(row.file_mode === 'required' && input.fileId === null ? ['file'] : []),
      ];
      if (missing.length > 0 || (text === null && input.fileId === null))
        throw new AcademyError(`academy.submission_incomplete missing=${missing.join(',') || 'answer'}`, 'academy.submission_incomplete');
      if (input.fileId !== null) {
        const [file] = await tx`
          SELECT 1 FROM academy.assignment_files WHERE id = ${input.fileId} AND item_id = ${row.item_id} AND user_id = ${input.userId}
        `;
        if (!file) throw new AcademyError('that file was not uploaded for this assignment', 'academy.media_not_found');
      }
      // A retry racing the first send waits on the key, then finds the first one's row: one hand-in either way.
      await tx`
        INSERT INTO academy.assignment_submissions (item_id, user_id, version, state, text, file_id, submitted_at)
        VALUES (${row.item_id}, ${input.userId}, ${input.version}, 'submitted', ${text}, ${input.fileId}, ${input.now})
        ON CONFLICT (item_id, user_id, version) DO NOTHING
      `;
      return this.viewOf(tx, row, input.userId);
    });
  }

  /** The largest file a learner hands in: the owner's limit, bounded by what travels inline. Null while the owner's is unset. */
  private fileMaxBytes(): number | null {
    return this.limits.maxBytes === null ? null : Math.min(this.limits.maxBytes, ACADEMY_ASSIGNMENT_FILE_INLINE_MAX_BYTES);
  }

  private requireLimits(): { maxBytes: number; types: readonly string[] } {
    if (this.limits.maxBytes === null || !this.limits.types || this.limits.types.length === 0)
      throw new AcademyError('the owner has not set the upload size limit and the accepted file types', 'academy.upload_limits_unset');
    return { maxBytes: this.limits.maxBytes, types: this.limits.types };
  }

  private async adminIn(sql: Sql | TransactionSql, itemId: string): Promise<AcademyAdminAssignment> {
    const row = await this.brief(sql, itemId);
    const [counted] = await sql<Array<{ n: number }>>`
      SELECT count(DISTINCT user_id)::int AS n FROM academy.assignment_submissions WHERE item_id = ${itemId}
    `;
    return {
      itemId: row.item_id,
      courseId: row.course_id,
      title: row.title,
      revision: row.revision ?? 0,
      brief: row.revision === null ? null : this.briefOf(row),
      savedBy: row.saved_by,
      savedAt: row.saved_at?.toISOString() ?? null,
      withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
      withdrawReason: row.withdraw_reason,
      learnersHandedIn: counted!.n,
      review: await reviewStepsOf(sql, row.item_id),
    };
  }

  private briefOf(row: BriefRow) {
    return {
      instructions: row.instructions!,
      points: canonicalPrice(row.points)!,
      dueAt: row.due_at?.toISOString() ?? null,
      text: row.text_mode!,
      file: row.file_mode!,
    };
  }

  private async brief(sql: Sql | TransactionSql, itemId: string, lock = false): Promise<BriefRow> {
    const [row] = await sql<BriefRow[]>`
      SELECT ${briefColumns(sql)}
      FROM academy.course_items i LEFT JOIN academy.course_assignments a ON a.item_id = i.id
      WHERE i.id = ${itemId}
      ${lock ? sql`FOR UPDATE OF i` : sql``}
    `;
    if (!row) throw new AcademyError('no outline item with that id', 'academy.outline_item_unknown');
    if (row.kind !== 'assignment') throw new AcademyError(`a ${row.kind} is not an assignment`, 'academy.assignment_not_found');
    return row;
  }

  private lockBrief(tx: TransactionSql, itemId: string): Promise<BriefRow> {
    return this.brief(tx, itemId, true);
  }

  /** The item, its course and the caller's enrolment, refusing what the learner may not open. Peer review reads it too. */
  async learnerRow(sql: Sql | TransactionSql, itemId: string, userId: string, lock = false): Promise<LearnerRow> {
    const [row] = await sql<LearnerRow[]>`
      SELECT ${briefColumns(sql)}, c.slug AS course_slug, c.title AS course_title, c.state AS course_state,
        EXISTS (SELECT 1 FROM academy.course_enrolments e
          WHERE e.course_id = c.id AND e.user_id = ${userId} AND e.left_at IS NULL) AS enrolled
      FROM academy.course_items i
      JOIN academy.courses c ON c.id = i.course_id
      LEFT JOIN academy.course_assignments a ON a.item_id = i.id
      WHERE i.id = ${itemId}
      ${lock ? sql`FOR SHARE OF i` : sql``}
    `;
    // A draft course, an item that is not an assignment and one with no brief are the same as no assignment at all.
    if (!row || row.kind !== 'assignment' || row.revision === null || row.course_state !== 'published')
      throw new AcademyError('no assignment is open at that address', 'academy.assignment_not_found');
    if (!row.enrolled) throw new AcademyError(`academy.enrolment_required course=${row.course_slug}`, 'academy.enrolment_required');
    // A section scheduled for later, or an unmet prerequisite, keeps the assignment closed (AC-release-access-01, 02).
    await assertItemOpen(sql, row.item_id, userId, new Date());
    return row;
  }

  private async learnerIn(sql: Sql | TransactionSql, itemId: string, userId: string): Promise<AcademyAssignmentView> {
    return this.viewOf(sql, await this.learnerRow(sql, itemId, userId), userId);
  }

  /** The learner's view from the row already read: the brief and their own hand-ins, newest first. */
  private async viewOf(sql: Sql | TransactionSql, row: LearnerRow, userId: string): Promise<AcademyAssignmentView> {
    const itemId = row.item_id;
    const rows = await sql<SubmissionRow[]>`
      SELECT s.version, s.state, s.text, s.submitted_at, f.id AS file_id, f.file_name, f.content_type, f.bytes
      FROM academy.assignment_submissions s LEFT JOIN academy.assignment_files f ON f.id = s.file_id
      WHERE s.item_id = ${itemId} AND s.user_id = ${userId}
      ORDER BY s.version DESC
      LIMIT ${SUBMISSIONS_SHOWN}
    `;
    const brief = this.briefOf(row);
    // A later due date staff granted this learner (AC-release-access-02): their hand-ins are late only after it.
    const [extension] = await sql<Array<{ due_at: Date; reason: string }>>`
      SELECT due_at, reason FROM academy.course_item_extensions WHERE item_id = ${itemId} AND user_id = ${userId}
    `;
    const dueAt = dueFor(row.due_at, extension?.due_at ?? null);
    return {
      itemId: row.item_id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      title: row.title,
      ...brief,
      latePolicy: await latePolicyOf(sql, row.course_id),
      fileLimits: { maxBytes: this.fileMaxBytes(), types: this.limits.types ? [...this.limits.types] : null },
      withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
      submissions: rows.map((s) => ({
        version: s.version,
        state: s.state,
        text: s.text,
        file:
          s.file_id === null ? null : fileOf({ id: s.file_id, file_name: s.file_name!, content_type: s.content_type!, bytes: s.bytes! }),
        submittedAt: s.submitted_at.toISOString(),
        late: dueAt !== null && s.submitted_at.getTime() > dueAt.getTime(),
      })),
      grade: await learnerGradeOf(sql, itemId, userId),
      nextVersion: (rows[0]?.version ?? 0) + 1,
      extension: extension ? { dueAt: extension.due_at.toISOString(), reason: extension.reason } : null,
    };
  }
}
