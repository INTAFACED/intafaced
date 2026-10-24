/**
 * AC-assignments-03 — rubrics and peer or self review on an assignment.
 *
 * Staff save an assignment's review steps over the revision read: peer review with how many classmates each learner
 * reviews, a self review, and the rubric both are scored against. A rubric row is never changed: other criteria are a
 * new rubric, so a review keeps the criteria it was scored against. On a published course a peer step needs its count
 * (`academy.peer_count_unset`); a draft may be saved without one, and is then not published.
 *
 * A learner reviews only after handing in. Peer work is handed out under one lock per assignment, least-reviewed author
 * first, then the earliest hand-in: never the learner's own work, never the same author twice. While no classmate's work
 * is free the learner waits (a stage, not an error). After the peer reviews comes the self review of the learner's own
 * latest hand-in. Each review is one row keyed `peer:<assignment>:<reviewer>:<author>`, written when the work is handed
 * out and completed once with the marks: the same marks again answer as stored, other marks refuse. The reviewer sees
 * the work under an alias and never the author's account or file name; a file is read back through svc-academy, never
 * from a store address that carries the account. Training examples, cohort-only pairing and rubric import by
 * file are later parts of this slice. No money moves here.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import type {
  AcademyPeerReviewFile,
  AcademyReviewState,
  AcademyReviewSteps,
  AcademyReviewTask,
  AcademyRubricCriterion,
  AcademySaveReviewStepsInput,
  AcademySubmitPeerReviewInput,
} from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { AcademyError } from '../errors.js';
import { isVideoStorageConfigured, signGetObjectUrl, type VideoStorageConfig } from '../video/storage.js';
import type { CourseAssignments } from './assignments.js';

/** Reads an object's bytes at a signed GET address; answers with the store's status. Swapped in tests. */
export type GetObjectFn = (url: string) => Promise<{ status: number; bytes: Uint8Array }>;

export const getOverHttp: GetObjectFn = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, bytes: new Uint8Array() };
  }
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
};

type Db = Sql | TransactionSql;

type StepsRow = {
  revision: number;
  peer: boolean;
  peer_count: number | null;
  self: boolean;
  rubric_id: string | null;
  criteria: AcademyRubricCriterion[] | null;
};

type ReviewRow = {
  id: string;
  author_id: string;
  version: number;
  marks: string[] | null;
  criteria: AcademyRubricCriterion[];
  text: string | null;
  file_name: string | null;
  content_type: string | null;
  bytes: string | number | bigint | null;
  ordinal: number;
};

/** A rubric level as hundredths: "1.5" is 150n. Levels carry at most two places (ACADEMY_RUBRIC_LEVEL). */
function hundredths(level: string): bigint {
  // The ledger's decimal parser, scaled from 18 places down to 2; a level has at most 2, so this is exact.
  return parseAmount(level) / 10n ** 16n;
}

/** The sum of the chosen levels as a decimal string with no trailing zeros. */
export function rubricTotal(marks: readonly string[]): string {
  const sum = marks.reduce((n, mark) => n + hundredths(mark), 0n);
  const fraction = (sum % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${sum / 100n}${fraction ? `.${fraction}` : ''}`;
}

/** The review steps of one assignment as staff see them, with the waiting list; null until first saved. */
export async function reviewStepsOf(sql: Db, itemId: string): Promise<AcademyReviewSteps | null> {
  const [row] = await sql<StepsRow[]>`
    SELECT s.revision, s.peer, s.peer_count, s.self, s.rubric_id, r.criteria
    FROM academy.assignment_review_steps s LEFT JOIN academy.assignment_rubrics r ON r.id = s.rubric_id
    WHERE s.item_id = ${itemId}
  `;
  if (!row) return null;
  const [waiting] = await sql<Array<{ short: number; waiting: number }>>`
    WITH authors AS (SELECT DISTINCT user_id FROM academy.assignment_submissions WHERE item_id = ${itemId} AND state <> 'withdrawn'),
    tally AS (
      SELECT a.user_id,
        (SELECT count(*) FROM academy.assignment_reviews r
          WHERE r.item_id = ${itemId} AND r.author_id = a.user_id AND r.reviewer_id <> a.user_id AND r.marks IS NOT NULL)::int AS received,
        (SELECT count(*) FROM academy.assignment_reviews r
          WHERE r.item_id = ${itemId} AND r.reviewer_id = a.user_id AND r.author_id <> a.user_id AND r.marks IS NOT NULL)::int AS given,
        EXISTS (SELECT 1 FROM academy.assignment_reviews r
          WHERE r.item_id = ${itemId} AND r.reviewer_id = a.user_id AND r.author_id <> a.user_id AND r.marks IS NULL) AS open,
        EXISTS (SELECT 1 FROM authors o WHERE o.user_id <> a.user_id
          AND NOT EXISTS (SELECT 1 FROM academy.assignment_reviews r
            WHERE r.item_id = ${itemId} AND r.reviewer_id = a.user_id AND r.author_id = o.user_id)) AS free
      FROM authors a
    )
    SELECT count(*) FILTER (WHERE received < ${row.peer_count ?? 0})::int AS short,
      count(*) FILTER (WHERE given < ${row.peer_count ?? 0} AND NOT open AND NOT free)::int AS waiting
    FROM tally
  `;
  const peerOn = row.peer && row.peer_count !== null;
  return {
    revision: row.revision,
    peer: row.peer,
    peerCount: row.peer_count,
    self: row.self,
    rubric: row.rubric_id === null ? null : { id: row.rubric_id, criteria: row.criteria! },
    authorsShortOfReviews: peerOn ? waiting!.short : 0,
    reviewersWaiting: peerOn ? waiting!.waiting : 0,
  };
}

/** Throws `academy.peer_count_unset` when an assignment of the course has peer review on and no count. */
export async function assertPeerCountsSet(sql: Db, courseId: string): Promise<void> {
  const [unset] = await sql<Array<{ title: string }>>`
    SELECT i.title FROM academy.assignment_review_steps s JOIN academy.course_items i ON i.id = s.item_id
    WHERE i.course_id = ${courseId} AND s.peer AND s.peer_count IS NULL
    LIMIT 1
  `;
  if (unset)
    throw new AcademyError(
      `"${unset.title}" has peer review on with no review count, so the course is not published`,
      'academy.peer_count_unset',
    );
}

export class PeerReviews {
  constructor(
    private readonly sql: Sql,
    private readonly assignments: CourseAssignments,
    private readonly storage: VideoStorageConfig | null = null,
    private readonly get: GetObjectFn = getOverHttp,
  ) {}

  /** The steps and rubric over the revision read. The same criteria as the current rubric keep it; others are a new one. */
  async save(input: AcademySaveReviewStepsInput & { operatorId: string; now: Date }): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [item] = await tx<Array<{ course_id: string; course_state: string; briefed: boolean; withdrawn: boolean }>>`
        SELECT i.course_id, c.state AS course_state, a.item_id IS NOT NULL AS briefed, a.withdrawn_at IS NOT NULL AS withdrawn
        FROM academy.course_items i JOIN academy.courses c ON c.id = i.course_id
        LEFT JOIN academy.course_assignments a ON a.item_id = i.id
        WHERE i.id = ${input.itemId} AND i.kind = 'assignment'
        FOR UPDATE OF i
      `;
      if (!item?.briefed) throw new AcademyError('save the assignment brief before its review steps', 'academy.assignment_not_found');
      if (item.withdrawn) throw new AcademyError('a withdrawn assignment is not edited', 'academy.assignment_closed');
      const [current] = await tx<StepsRow[]>`
        SELECT s.revision, s.peer, s.peer_count, s.self, s.rubric_id, r.criteria
        FROM academy.assignment_review_steps s LEFT JOIN academy.assignment_rubrics r ON r.id = s.rubric_id
        WHERE s.item_id = ${input.itemId}
      `;
      const revision = current?.revision ?? 0;
      if (revision !== input.revision)
        throw new AcademyError(`the review steps are at revision ${revision}, not ${input.revision}`, 'academy.revision_stale');
      if (input.peer && input.peerCount === null && item.course_state === 'published')
        throw new AcademyError('peer review needs how many reviews each learner gives', 'academy.peer_count_unset');
      if ((input.peer || input.self) && input.criteria.length === 0)
        throw new AcademyError('a peer or self review needs a rubric with at least one criterion', 'academy.rubric_invalid');
      if (new Set(input.criteria.map((c) => c.name.trim().toLowerCase())).size !== input.criteria.length)
        throw new AcademyError('two criteria have the same name', 'academy.rubric_invalid');
      let rubricId = current?.rubric_id ?? null;
      if (input.criteria.length === 0) rubricId = null;
      else if (!current?.criteria || !isDeepStrictEqual(current.criteria, input.criteria)) {
        const [rubric] = await tx<Array<{ id: string }>>`
          INSERT INTO academy.assignment_rubrics (course_id, criteria, created_by, created_at)
          VALUES (${item.course_id}, ${tx.json(input.criteria)}, ${input.operatorId}, ${input.now})
          RETURNING id
        `;
        rubricId = rubric!.id;
      }
      await tx`
        INSERT INTO academy.assignment_review_steps (item_id, revision, peer, peer_count, self, rubric_id, saved_by, saved_at)
        VALUES (${input.itemId}, ${revision + 1}, ${input.peer}, ${input.peerCount}, ${input.self}, ${rubricId}, ${input.operatorId}, ${input.now})
        ON CONFLICT (item_id) DO UPDATE SET
          revision = EXCLUDED.revision, peer = EXCLUDED.peer, peer_count = EXCLUDED.peer_count, self = EXCLUDED.self,
          rubric_id = EXCLUDED.rubric_id, saved_by = EXCLUDED.saved_by, saved_at = EXCLUDED.saved_at
      `;
    });
  }

  /** Where the learner is in the review steps; hands them the next work when one is due and free. */
  async state(input: { itemId: string; userId: string; now: Date }): Promise<AcademyReviewState> {
    return this.sql.begin((tx) => this.stateIn(tx, input.itemId, input.userId, input.now));
  }

  /** One review's marks, one level per criterion of the task's rubric. Then the learner's next stage. */
  async submit(input: AcademySubmitPeerReviewInput & { userId: string; now: Date }): Promise<AcademyReviewState> {
    return this.sql.begin(async (tx) => {
      await this.assignments.learnerRow(tx, input.itemId, input.userId);
      const [task] = await tx<Array<{ id: string; marks: string[] | null; criteria: AcademyRubricCriterion[] }>>`
        SELECT r.id, r.marks, b.criteria FROM academy.assignment_reviews r JOIN academy.assignment_rubrics b ON b.id = r.rubric_id
        WHERE r.id = ${input.taskId} AND r.item_id = ${input.itemId} AND r.reviewer_id = ${input.userId}
        FOR UPDATE OF r
      `;
      if (!task) throw new AcademyError('no review of yours with that id', 'academy.review_task_not_found');
      if (task.marks !== null) {
        if (isDeepStrictEqual(task.marks, input.marks)) return this.stateIn(tx, input.itemId, input.userId, input.now);
        throw new AcademyError('this review was already sent with other marks', 'academy.review_already_sent');
      }
      if (input.marks.length !== task.criteria.length || input.marks.some((mark, i) => !task.criteria[i]!.levels.includes(mark)))
        throw new AcademyError('give one of its levels for every criterion of the rubric', 'academy.review_marks_invalid');
      await tx`
        UPDATE academy.assignment_reviews
        SET marks = ${tx.json(input.marks)}, total = ${rubricTotal(input.marks)}, reviewed_at = ${input.now}
        WHERE id = ${task.id}
      `;
      return this.stateIn(tx, input.itemId, input.userId, input.now);
    });
  }

  /**
   * The file of work handed to the caller to review, open or done, read back from our own store and checked against the
   * SHA-256 it was stored under. The store address carries the author's account, so it never reaches the reviewer.
   */
  async file(input: { itemId: string; taskId: string; userId: string; now: Date }): Promise<AcademyPeerReviewFile> {
    await this.assignments.learnerRow(this.sql, input.itemId, input.userId);
    const [row] = await this.sql<Array<{ object_key: string; sha256: string; content_type: string; bytes: string }>>`
      SELECT f.object_key, f.sha256, f.content_type, f.bytes::text AS bytes
      FROM academy.assignment_reviews r
      JOIN academy.assignment_submissions s ON s.item_id = r.item_id AND s.user_id = r.author_id AND s.version = r.version
      JOIN academy.assignment_files f ON f.id = s.file_id
      WHERE r.id = ${input.taskId} AND r.item_id = ${input.itemId} AND r.reviewer_id = ${input.userId}
    `;
    if (!row) throw new AcademyError('no file in a review of yours with that id', 'academy.review_task_not_found');
    if (!isVideoStorageConfigured(this.storage))
      throw new AcademyError('File storage is not configured', 'academy.video_storage_unconfigured');
    const { playbackUrl } = signGetObjectUrl(this.storage, row.object_key, input.now);
    const read = await this.get(playbackUrl).catch(() => null);
    const bytes = read && read.status >= 200 && read.status < 300 ? Buffer.from(read.bytes) : null;
    if (!bytes || bytes.byteLength !== Number(row.bytes) || createHash('sha256').update(bytes).digest('hex') !== row.sha256)
      throw new AcademyError('the file could not be read back whole from storage; try again', 'academy.file_unavailable');
    return { contentType: row.content_type, bytes: bytes.byteLength, contentBase64: bytes.toString('base64') };
  }

  private async stateIn(tx: TransactionSql, itemId: string, userId: string, now: Date): Promise<AcademyReviewState> {
    await this.assignments.learnerRow(tx, itemId, userId);
    // One learner at a time per assignment, so "least-reviewed first" reads the counts every other hand-out left.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`peer:${itemId}`}, 0))`;
    const [steps] = await tx<StepsRow[]>`
      SELECT revision, peer, peer_count, self, rubric_id, NULL::jsonb AS criteria FROM academy.assignment_review_steps WHERE item_id = ${itemId}
    `;
    const peer = steps?.peer ?? false;
    const self = steps?.self ?? false;
    const [done] = await tx<Array<{ peer_done: number; self_done: boolean }>>`
      SELECT count(*) FILTER (WHERE author_id <> ${userId} AND marks IS NOT NULL)::int AS peer_done,
        bool_or(author_id = ${userId} AND marks IS NOT NULL) IS TRUE AS self_done
      FROM academy.assignment_reviews WHERE item_id = ${itemId} AND reviewer_id = ${userId}
    `;
    const base = {
      itemId,
      peer,
      peerCount: steps?.peer_count ?? null,
      self,
      peerDone: done!.peer_done,
      selfDone: done!.self_done,
    };
    const at = (stage: AcademyReviewState['stage'], task: AcademyReviewTask | null = null): AcademyReviewState => ({
      ...base,
      stage,
      task,
    });
    if (!steps || (!peer && !self) || steps.rubric_id === null) return at('off');
    const [mine] = await tx<Array<{ version: number }>>`
      SELECT max(version)::int AS version FROM academy.assignment_submissions
      WHERE item_id = ${itemId} AND user_id = ${userId} AND state <> 'withdrawn'
    `;
    if (mine?.version == null) return at('hand_in_first');

    if (peer) {
      if (steps.peer_count === null) throw new AcademyError('peer review has no review count set', 'academy.peer_count_unset');
      if (base.peerDone < steps.peer_count) {
        const open = await this.openTask(tx, itemId, userId, 'peer');
        if (open) return at('peer', open);
        const [author] = await tx<Array<{ user_id: string; version: number }>>`
          WITH latest AS (
            SELECT DISTINCT ON (user_id) user_id, version FROM academy.assignment_submissions
            WHERE item_id = ${itemId} AND state <> 'withdrawn'
            ORDER BY user_id, version DESC
          )
          SELECT l.user_id, l.version FROM latest l
          WHERE l.user_id <> ${userId}
            AND NOT EXISTS (SELECT 1 FROM academy.assignment_reviews x
              WHERE x.item_id = ${itemId} AND x.reviewer_id = ${userId} AND x.author_id = l.user_id)
          ORDER BY
            (SELECT count(*) FROM academy.assignment_reviews r
              WHERE r.item_id = ${itemId} AND r.author_id = l.user_id AND r.reviewer_id <> l.user_id),
            (SELECT min(submitted_at) FROM academy.assignment_submissions f WHERE f.item_id = ${itemId} AND f.user_id = l.user_id),
            l.user_id
          LIMIT 1
        `;
        if (!author) return at('waiting');
        await this.handOut(tx, itemId, userId, author.user_id, author.version, steps.rubric_id, now);
        return at('peer', await this.openTask(tx, itemId, userId, 'peer'));
      }
    }
    if (self && !base.selfDone) {
      const open = await this.openTask(tx, itemId, userId, 'self');
      if (open) return at('self', open);
      await this.handOut(tx, itemId, userId, userId, mine.version, steps.rubric_id, now);
      return at('self', await this.openTask(tx, itemId, userId, 'self'));
    }
    return at('done');
  }

  /** The review row, keyed `peer:<assignment>:<reviewer>:<author>`; a second hand-out of the same pair is the same row. */
  private async handOut(
    tx: TransactionSql,
    itemId: string,
    reviewerId: string,
    authorId: string,
    version: number,
    rubricId: string,
    now: Date,
  ): Promise<void> {
    await tx`
      INSERT INTO academy.assignment_reviews (item_id, reviewer_id, author_id, version, rubric_id, allocated_at)
      VALUES (${itemId}, ${reviewerId}, ${authorId}, ${version}, ${rubricId}, ${now})
      ON CONFLICT (item_id, reviewer_id, author_id) DO NOTHING
    `;
  }

  /** The learner's unfinished review of that kind, with the work it reviews and the rubric it was handed out with. */
  private async openTask(tx: TransactionSql, itemId: string, userId: string, kind: 'peer' | 'self'): Promise<AcademyReviewTask | null> {
    const [row] = await tx<ReviewRow[]>`
      SELECT r.id, r.author_id, r.version, r.marks, b.criteria, s.text, f.file_name, f.content_type, f.bytes,
        (SELECT count(*) FROM academy.assignment_reviews o
          WHERE o.item_id = r.item_id AND o.reviewer_id = r.reviewer_id AND o.author_id <> o.reviewer_id
            AND o.allocated_at <= r.allocated_at)::int AS ordinal
      FROM academy.assignment_reviews r
      JOIN academy.assignment_rubrics b ON b.id = r.rubric_id
      JOIN academy.assignment_submissions s ON s.item_id = r.item_id AND s.user_id = r.author_id AND s.version = r.version
      LEFT JOIN academy.assignment_files f ON f.id = s.file_id
      WHERE r.item_id = ${itemId} AND r.reviewer_id = ${userId} AND r.marks IS NULL
        AND ${kind === 'self' ? tx`r.author_id = r.reviewer_id` : tx`r.author_id <> r.reviewer_id`}
      ORDER BY r.allocated_at, r.id
      LIMIT 1
    `;
    if (!row) return null;
    return {
      id: row.id,
      kind,
      ordinal: kind === 'self' ? null : row.ordinal,
      text: row.text,
      // A classmate's file name can name them, so only the learner's own carries it.
      file:
        row.file_name === null
          ? null
          : { fileName: kind === 'self' ? row.file_name : null, contentType: row.content_type!, bytes: Number(row.bytes) },
      criteria: row.criteria,
    };
  }
}
