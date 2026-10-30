/**
 * AC-assignments-02 — staff grading of assignment hand-ins.
 *
 * The grading queue lists each learner's newest hand-in under an alias ("Learner 3": their place by first hand-in on this
 * assignment, worked out on read), never their name or account, with the peer reviews it received and its grade. A
 * grader takes a lease on a hand-in for the owner's lease length (`ACADEMY_GRADER_LEASE_SECONDS`; blank refuses
 * `academy.grader_lease_unset`); while another grader's lease is live the hand-in refuses `academy.grader_locked`.
 *
 * A grade is an append-only trail of events keyed `grade:<submission>:<n>`, written under the lease: the score as a
 * decimal no higher than the assignment's points (`academy.grade_invalid`), an optional comment, the grader, and a reason
 * when it overrides an earlier grade (`academy.reason_required`). The same `n` again answers as stored; a stale `n`
 * refuses `academy.revision_stale`. The newest event is the grade, released to the learner when it is saved; the learner
 * never sees who graded. A learner marking the feedback read is its own row and changes no grade. No money moves here.
 */
import type { Sql, TransactionSql } from 'postgres';
import { createHash } from 'node:crypto';
import type {
  AcademyBulkGradeInput,
  AcademyBulkGradeResult,
  AcademyCourseGrades,
  AcademyGradeSubmissionInput,
  AcademyGradingQueue,
  AcademyGradingRow,
  AcademyLearnerGrade,
  AcademyMarkFeedbackReadInput,
  AcademyOpenGradingInput,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import type { CourseAssignments } from './assignments.js';
import { canonicalPrice } from './courses.js';
import { hundredths } from './peer-review.js';
import { dueFor } from './course-item-rules.js';
import { readBulkGradeFile, type BulkGradeBadRow } from './bulk-grade-file.js';

type Db = Sql | TransactionSql;

type QueueRow = {
  submission_id: string;
  alias: number;
  version: number;
  submitted_at: Date;
  text: string | null;
  file_name: string | null;
  content_type: string | null;
  bytes: string | null;
  received: number;
  mean_total: string | null;
  score: string | null;
  comment: string | null;
  graded_at: Date | null;
  last_n: number;
  holder: string | null;
  expires_at: Date | null;
  extended_due: Date | null;
};

type CourseGradeRow = {
  course_id: string;
  slug: string;
  course_title: string;
  item_id: string;
  title: string;
  points: string;
  withdrawn: boolean;
  handed_in: boolean;
  score: string | null;
  graded_points: string | null;
};

/** part / whole as a percentage with one decimal place, rounded half up. */
function tenthsOf(part: bigint, whole: bigint): string {
  const t = (part * 2000n + whole) / (2n * whole);
  return `${t / 10n}.${t % 10n}`;
}

type HandIn = {
  submission_id: string;
  item_id: string;
  state: string;
  points: string;
  due_at: Date | null;
  withdrawn_at: Date | null;
};

/** The learner's newest grade, with when they read it. Null before staff grade. */
export async function learnerGradeOf(sql: Db, itemId: string, userId: string): Promise<AcademyLearnerGrade | null> {
  const [row] = await sql<
    Array<{ version: number; n: number; score: string; points: string; comment: string | null; at: Date; read_at: Date | null }>
  >`
    SELECT s.version, g.n, g.score::text AS score, g.points::text AS points, g.comment, g.at, r.read_at
    FROM academy.assignment_submissions s
    JOIN academy.assignment_grade_events g ON g.submission_id = s.id
    LEFT JOIN academy.assignment_feedback_reads r ON r.grade_event_id = g.id
    WHERE s.item_id = ${itemId} AND s.user_id = ${userId}
    ORDER BY s.version DESC, g.n DESC
    LIMIT 1
  `;
  if (!row) return null;
  return {
    version: row.version,
    n: row.n,
    score: canonicalPrice(row.score)!,
    points: canonicalPrice(row.points)!,
    comment: row.comment,
    gradedAt: row.at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  };
}

export class AssignmentGrading {
  constructor(
    private readonly sql: Sql,
    private readonly assignments: CourseAssignments,
    /** `ACADEMY_GRADER_LEASE_SECONDS`; null is not set, and grading refuses. */
    private readonly leaseSeconds: number | null,
  ) {}

  /** Each learner's newest hand-in under its alias, oldest first hand-in first. Writes nothing. */
  async queue(input: { itemId: string; operatorId: string; now: Date }): Promise<AcademyGradingQueue> {
    return this.queueIn(this.sql, input.itemId, input.operatorId, input.now);
  }

  /** Take or renew the caller's lease on one hand-in. Another grader's live lease refuses `academy.grader_locked`. */
  async open(input: AcademyOpenGradingInput & { operatorId: string; now: Date }): Promise<AcademyGradingQueue> {
    const seconds = this.requireLease();
    await this.sql.begin(async (tx) => {
      const handIn = await this.handIn(tx, input.itemId, input.submissionId);
      await this.lease(tx, handIn.submission_id, input.operatorId, input.now, seconds);
    });
    // Read after the commit, so a reply never holds a second connection while the hand-in is locked.
    return this.queueIn(this.sql, input.itemId, input.operatorId, input.now);
  }

  /** Grade event `n` on a hand-in, under the caller's lease, which it then releases. */
  async grade(input: AcademyGradeSubmissionInput & { operatorId: string; now: Date }): Promise<AcademyGradingQueue> {
    const seconds = this.requireLease();
    const comment = input.comment || null;
    const reason = input.n > 1 ? input.reason : null;
    await this.sql.begin(async (tx) => {
      const handIn = await this.handIn(tx, input.itemId, input.submissionId);
      const [stored] = await tx<Array<{ score: string; comment: string | null; reason: string | null; actor: string }>>`
        SELECT score::text AS score, comment, reason, actor FROM academy.assignment_grade_events
        WHERE submission_id = ${handIn.submission_id} AND n = ${input.n}
      `;
      // A retry after a lost reply finds its own event, field for field, and answers with the queue as it stands; any
      // other grade under a stored n is stale.
      if (
        stored &&
        stored.actor === input.operatorId &&
        canonicalPrice(stored.score) === canonicalPrice(input.score) &&
        stored.comment === comment &&
        stored.reason === reason
      )
        return;
      const [last] = await tx<Array<{ n: number }>>`
        SELECT coalesce(max(n), 0)::int AS n FROM academy.assignment_grade_events WHERE submission_id = ${handIn.submission_id}
      `;
      if (input.n !== last!.n + 1)
        throw new AcademyError(
          `the next grade on this hand-in is ${last!.n + 1}, not ${input.n}; read the queue again`,
          'academy.revision_stale',
        );
      if (hundredths(input.score) > hundredths(handIn.points))
        throw new AcademyError(`a score of ${input.score} is above the ${canonicalPrice(handIn.points)} points`, 'academy.grade_invalid');
      if (input.n > 1 && !input.reason) throw new AcademyError('changing a grade needs a reason', 'academy.reason_required');
      await this.lease(tx, handIn.submission_id, input.operatorId, input.now, seconds);
      await tx`
        INSERT INTO academy.assignment_grade_events (submission_id, n, score, points, comment, actor, reason, at)
        VALUES (${handIn.submission_id}, ${input.n}, ${input.score}, ${handIn.points}, ${comment}, ${input.operatorId}, ${reason}, ${input.now})
      `;
      await tx`UPDATE academy.assignment_submissions SET state = 'graded' WHERE id = ${handIn.submission_id}`;
      await tx`DELETE FROM academy.assignment_grader_leases WHERE submission_id = ${handIn.submission_id}`;
    });
    return this.queueIn(this.sql, input.itemId, input.operatorId, input.now);
  }

  /**
   * A file of grades for one assignment, by alias. The file is read whole first (a bad header refuses it); then, in one
   * transaction, each good row whose alias names a hand-in, whose score fits the points, whose hand-in no other grader
   * holds, and which carries a reason when it changes a grade, becomes the next grade event, pointing at the stored
   * file (`grade:<submission>:<file hash>`). Every other row is listed with its line and code. The same file again (same
   * sha256 on this assignment) is `repeated`: a row it already graded is not graded again, and only a row refused before
   * whose cause has cleared (another grader's hold ran out) applies now, so a file changes each grade at most once.
   * Hand-ins are locked in id order, so two uploads at once wait for each other rather than deadlock.
   */
  async bulkGrade(input: AcademyBulkGradeInput & { operatorId: string; now: Date }): Promise<AcademyBulkGradeResult> {
    const seconds = this.requireLease();
    const view = await this.assignments.adminView(input.itemId);
    if (!view.brief) throw new AcademyError('the assignment has no brief', 'academy.assignment_not_found');
    const sha256 = createHash('sha256').update(input.csv, 'utf8').digest('hex');
    const file = readBulkGradeFile(input.csv);
    const result = await this.sql.begin(async (tx): Promise<Omit<AcademyBulkGradeResult, 'queue'>> => {
      const [created] = await tx<Array<{ id: string }>>`
        INSERT INTO academy.assignment_bulk_grades (item_id, sha256, actor, result, at)
        VALUES (${input.itemId}, ${sha256}, ${input.operatorId}, '{}'::jsonb, ${input.now})
        ON CONFLICT (item_id, sha256) DO NOTHING
        RETURNING id
      `;
      // A repeat waits here for any upload of the same file still running, then reads what that one graded.
      const [stored] = created
        ? [created]
        : await tx<Array<{ id: string }>>`
            SELECT id FROM academy.assignment_bulk_grades WHERE item_id = ${input.itemId} AND sha256 = ${sha256} FOR UPDATE
          `;
      const fileId = stored!.id;
      const targets = await tx<Array<{ alias: number; submission_id: string; by_file: boolean }>>`
        WITH firsts AS (
          SELECT user_id, rank() OVER (ORDER BY min(submitted_at), user_id)::int AS alias
          FROM academy.assignment_submissions WHERE item_id = ${input.itemId} GROUP BY user_id
        )
        SELECT f.alias, l.id AS submission_id,
          EXISTS (SELECT 1 FROM academy.assignment_grade_events g WHERE g.submission_id = l.id AND g.bulk_id = ${fileId}) AS by_file
        FROM firsts f
        JOIN LATERAL (
          SELECT id FROM academy.assignment_submissions s
          WHERE s.item_id = ${input.itemId} AND s.user_id = f.user_id ORDER BY s.version DESC LIMIT 1
        ) l ON TRUE
      `;
      const byAlias = new Map(targets.map((t) => [t.alias, t]));
      const applied: AcademyBulkGradeResult['applied'] = [];
      const rejected: BulkGradeBadRow[] = [...file.bad];
      let changed = 0;
      const named = file.rows
        .map((row) => ({ row, target: byAlias.get(row.alias) }))
        .sort((a, b) => (a.target?.submission_id ?? '').localeCompare(b.target?.submission_id ?? ''));
      for (const { row, target } of named) {
        const refuse = (code: string, message: string) => rejected.push({ line: row.line, alias: row.alias, code, message });
        if (!target) {
          refuse('academy.submission_not_found', `no Learner ${row.alias} has handed in this assignment`);
          continue;
        }
        if (target.by_file) {
          applied.push({ line: row.line, alias: row.alias, score: canonicalPrice(row.score)! });
          continue;
        }
        const submissionId = target.submission_id;
        let handIn: HandIn;
        try {
          handIn = await this.handIn(tx, input.itemId, submissionId);
        } catch (error) {
          if (!(error instanceof AcademyError)) throw error;
          refuse(error.code, error.message);
          continue;
        }
        if (hundredths(row.score) > hundredths(handIn.points)) {
          refuse('academy.grade_invalid', `a score of ${row.score} is above the ${canonicalPrice(handIn.points)} points`);
          continue;
        }
        const [last] = await tx<Array<{ n: number }>>`
          SELECT coalesce(max(n), 0)::int AS n FROM academy.assignment_grade_events WHERE submission_id = ${submissionId}
        `;
        const n = last!.n + 1;
        if (n > 1 && !row.reason) {
          refuse('academy.reason_required', `Learner ${row.alias} already has a grade; changing it needs a reason`);
          continue;
        }
        try {
          await this.lease(tx, submissionId, input.operatorId, input.now, seconds);
        } catch (error) {
          if (!(error instanceof AcademyError)) throw error;
          refuse(error.code, `another grader holds Learner ${row.alias}'s hand-in`);
          continue;
        }
        await tx`
          INSERT INTO academy.assignment_grade_events (submission_id, n, score, points, comment, actor, reason, at, bulk_id)
          VALUES (${submissionId}, ${n}, ${row.score}, ${handIn.points}, ${row.comment}, ${input.operatorId},
            ${n > 1 ? row.reason : null}, ${input.now}, ${fileId})
        `;
        await tx`UPDATE academy.assignment_submissions SET state = 'graded' WHERE id = ${submissionId}`;
        await tx`DELETE FROM academy.assignment_grader_leases WHERE submission_id = ${submissionId}`;
        applied.push({ line: row.line, alias: row.alias, score: canonicalPrice(row.score)! });
        changed++;
      }
      const outcome = {
        sha256,
        fileName: input.fileName,
        at: input.now.toISOString(),
        repeated: !created,
        changed,
        applied: applied.sort((a, b) => a.line - b.line),
        rejected: rejected.sort((a, b) => a.line - b.line),
      };
      await tx`UPDATE academy.assignment_bulk_grades SET result = ${tx.json(outcome as never)} WHERE id = ${fileId}`;
      return outcome;
    });
    return { ...result, queue: await this.queueIn(this.sql, input.itemId, input.operatorId, input.now) };
  }

  /**
   * The caller's grades in each published course they are enrolled in (AC-progress-02): every assignment with a brief,
   * in outline order, at its newest grade. An assignment never handed in is `not_attempted`, never a zero, and counts
   * toward no average. Writes nothing.
   */
  async courseGrades(userId: string): Promise<AcademyCourseGrades[]> {
    const rows = await this.sql<CourseGradeRow[]>`
      SELECT c.id AS course_id, c.slug, c.title AS course_title, i.id AS item_id, i.title, a.points::text AS points,
        a.withdrawn_at IS NOT NULL AS withdrawn, l.id IS NOT NULL AS handed_in, g.score::text AS score, g.points::text AS graded_points
      FROM academy.course_enrolments e
      JOIN academy.courses c ON c.id = e.course_id AND c.state = 'published'
      JOIN academy.course_items i ON i.course_id = c.id AND i.kind = 'assignment'
      JOIN academy.course_sections sec ON sec.id = i.section_id
      JOIN academy.course_assignments a ON a.item_id = i.id
      -- The newest hand-in staff can grade (as the queue shows it); a newer hand-in after a grade waits for its own.
      LEFT JOIN LATERAL (
        SELECT s.id FROM academy.assignment_submissions s
        WHERE s.item_id = i.id AND s.user_id = ${userId}
        ORDER BY s.version DESC
        LIMIT 1
      ) l ON TRUE
      LEFT JOIN LATERAL (
        SELECT g.score, g.points FROM academy.assignment_grade_events g WHERE g.submission_id = l.id ORDER BY g.n DESC LIMIT 1
      ) g ON TRUE
      WHERE e.user_id = ${userId} AND e.left_at IS NULL
      ORDER BY c.title, c.id, sec.position, i.position
    `;
    const courses = new Map<string, AcademyCourseGrades>();
    for (const r of rows) {
      let course = courses.get(r.course_id);
      if (!course) courses.set(r.course_id, (course = { slug: r.slug, title: r.course_title, rows: [], averages: [] }));
      const row = { itemId: r.item_id, title: r.title, type: 'assignment' as const };
      course.rows.push(
        r.score !== null
          ? { ...row, state: 'graded', score: canonicalPrice(r.score)!, possible: canonicalPrice(r.graded_points!)! }
          : {
              ...row,
              state: r.handed_in ? 'handed_in' : r.withdrawn ? 'withdrawn' : 'not_attempted',
              possible: canonicalPrice(r.points)!,
            },
      );
    }
    for (const course of courses.values()) {
      const graded = course.rows.filter((row) => row.state === 'graded');
      const possible = graded.reduce((sum, row) => sum + hundredths(row.possible), 0n);
      if (graded.length > 0)
        course.averages.push({
          type: 'assignment',
          count: graded.length,
          percent: tenthsOf(
            graded.reduce((sum, row) => sum + hundredths(row.score), 0n),
            possible,
          ),
        });
    }
    return [...courses.values()];
  }

  /** The learner read grade event `n` on version `version`, the one their page showed. A repeat answers as stored. */
  async markRead(input: AcademyMarkFeedbackReadInput & { userId: string; now: Date }): Promise<void> {
    await this.assignments.learnerRow(this.sql, input.itemId, input.userId);
    const [event] = await this.sql<Array<{ id: string }>>`
      SELECT g.id FROM academy.assignment_submissions s
      JOIN academy.assignment_grade_events g ON g.submission_id = s.id
      WHERE s.item_id = ${input.itemId} AND s.user_id = ${input.userId} AND s.version = ${input.version} AND g.n = ${input.n}
    `;
    if (!event) throw new AcademyError('that hand-in has no grade to read', 'academy.submission_not_found');
    await this.sql`
      INSERT INTO academy.assignment_feedback_reads (grade_event_id, user_id, read_at)
      VALUES (${event.id}, ${input.userId}, ${input.now})
      ON CONFLICT (grade_event_id) DO NOTHING
    `;
  }

  private requireLease(): number {
    if (this.leaseSeconds === null)
      throw new AcademyError('the owner has not set how long a grader holds a hand-in', 'academy.grader_lease_unset');
    return this.leaseSeconds;
  }

  /** The caller's lease, taken when free or expired and renewed when theirs; another grader's live lease refuses. */
  private async lease(tx: TransactionSql, submissionId: string, operatorId: string, now: Date, seconds: number): Promise<void> {
    const expires = new Date(now.getTime() + seconds * 1000);
    const [held] = await tx<Array<{ holder: string }>>`
      INSERT INTO academy.assignment_grader_leases (submission_id, holder, expires_at)
      VALUES (${submissionId}, ${operatorId}, ${expires})
      ON CONFLICT (submission_id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
        WHERE academy.assignment_grader_leases.holder = EXCLUDED.holder OR academy.assignment_grader_leases.expires_at <= ${now}
      RETURNING holder
    `;
    if (!held) throw new AcademyError('another grader holds this hand-in', 'academy.grader_locked');
  }

  /** The hand-in, locked, if it is the newest of its learner on this assignment item, neither withdrawn nor closed. */
  private async handIn(tx: TransactionSql, itemId: string, submissionId: string): Promise<HandIn> {
    const [row] = await tx<HandIn[]>`
      SELECT s.id AS submission_id, s.item_id, s.state, a.points::text AS points, a.due_at, a.withdrawn_at
      FROM academy.assignment_submissions s JOIN academy.course_assignments a ON a.item_id = s.item_id
      WHERE s.id = ${submissionId} AND s.item_id = ${itemId}
        AND s.version = (SELECT max(version) FROM academy.assignment_submissions o WHERE o.item_id = s.item_id AND o.user_id = s.user_id)
      FOR UPDATE OF s
    `;
    if (!row || row.state === 'withdrawn')
      throw new AcademyError('no newest hand-in with that id on this assignment', 'academy.submission_not_found');
    if (row.withdrawn_at) throw new AcademyError('staff withdrew this assignment', 'academy.assignment_closed');
    return row;
  }

  private async queueIn(sql: Db, itemId: string, operatorId: string, now: Date): Promise<AcademyGradingQueue> {
    const view = await this.assignments.adminView(itemId);
    if (!view.brief) throw new AcademyError('the assignment has no brief', 'academy.assignment_not_found');
    const rows = await sql<QueueRow[]>`
      WITH firsts AS (
        SELECT user_id, rank() OVER (ORDER BY min(submitted_at), user_id)::int AS alias
        FROM academy.assignment_submissions WHERE item_id = ${itemId} GROUP BY user_id
      ),
      latest AS (
        SELECT DISTINCT ON (user_id) * FROM academy.assignment_submissions WHERE item_id = ${itemId} ORDER BY user_id, version DESC
      )
      SELECT l.id AS submission_id, f.alias, l.version, l.submitted_at, l.text,
        fl.file_name, fl.content_type, fl.bytes::text AS bytes,
        pr.received, pr.mean_total,
        g.score::text AS score, g.comment, g.at AS graded_at, coalesce(g.n, 0)::int AS last_n,
        le.holder, le.expires_at, x.due_at AS extended_due
      FROM latest l
      JOIN firsts f ON f.user_id = l.user_id
      LEFT JOIN academy.assignment_files fl ON fl.id = l.file_id
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS received, round(avg(r.total), 2)::text AS mean_total FROM academy.assignment_reviews r
        WHERE r.item_id = l.item_id AND r.author_id = l.user_id AND r.version = l.version
          AND r.reviewer_id <> r.author_id AND r.marks IS NOT NULL
      ) pr
      LEFT JOIN LATERAL (
        SELECT score, comment, at, n FROM academy.assignment_grade_events WHERE submission_id = l.id ORDER BY n DESC LIMIT 1
      ) g ON TRUE
      LEFT JOIN academy.assignment_grader_leases le ON le.submission_id = l.id AND le.expires_at > ${now}
      LEFT JOIN academy.course_item_extensions x ON x.item_id = l.item_id AND x.user_id = l.user_id
      ORDER BY f.alias
    `;
    const dueAt = view.brief.dueAt === null ? null : new Date(view.brief.dueAt);
    return {
      itemId: view.itemId,
      courseId: view.courseId,
      title: view.title,
      points: view.brief.points,
      leaseSeconds: this.leaseSeconds,
      rows: rows.map((r): AcademyGradingRow => {
        // A learner's own later due date (AC-release-access-02) moves when their hand-in counts as late.
        const due = dueFor(dueAt, r.extended_due);
        return {
          submissionId: r.submission_id,
          alias: r.alias,
          version: r.version,
          submittedAt: r.submitted_at.toISOString(),
          late: due !== null && r.submitted_at.getTime() > due.getTime(),
          text: r.text,
          file: r.file_name === null ? null : { fileName: r.file_name, contentType: r.content_type!, bytes: Number(r.bytes) },
          peerReviews: { received: r.received, meanTotal: r.mean_total === null ? null : canonicalPrice(r.mean_total) },
          grade:
            r.score === null
              ? null
              : { score: canonicalPrice(r.score)!, comment: r.comment, gradedAt: r.graded_at!.toISOString(), overrides: r.last_n - 1 },
          nextN: r.last_n + 1,
          lease: r.holder === null ? null : { mine: r.holder === operatorId, expiresAt: r.expires_at!.toISOString() },
        };
      }),
    };
  }
}
