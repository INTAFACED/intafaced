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
import type {
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
};

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
        le.holder, le.expires_at
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
      ORDER BY f.alias
    `;
    const dueAt = view.brief.dueAt === null ? null : new Date(view.brief.dueAt);
    return {
      itemId: view.itemId,
      courseId: view.courseId,
      title: view.title,
      points: view.brief.points,
      leaseSeconds: this.leaseSeconds,
      rows: rows.map((r): AcademyGradingRow => ({
        submissionId: r.submission_id,
        alias: r.alias,
        version: r.version,
        submittedAt: r.submitted_at.toISOString(),
        late: dueAt !== null && r.submitted_at.getTime() > dueAt.getTime(),
        text: r.text,
        file: r.file_name === null ? null : { fileName: r.file_name, contentType: r.content_type!, bytes: Number(r.bytes) },
        peerReviews: { received: r.received, meanTotal: r.mean_total === null ? null : canonicalPrice(r.mean_total) },
        grade:
          r.score === null
            ? null
            : { score: canonicalPrice(r.score)!, comment: r.comment, gradedAt: r.graded_at!.toISOString(), overrides: r.last_n - 1 },
        nextN: r.last_n + 1,
        lease: r.holder === null ? null : { mine: r.holder === operatorId, expiresAt: r.expires_at!.toISOString() },
      })),
    };
  }
}
