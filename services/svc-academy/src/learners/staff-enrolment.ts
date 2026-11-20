/**
 * J-academy-15 — staff enrol people in bulk, invite an address, write to a course, and export learners by tag
 * (AC-enrolment-02, AC-enrolment-03, AC-notifications-02, AC-analytics-02).
 *
 * Enrolment by staff, one learner or a bulk upload, goes past a full course, a closed window and a hidden or unpublished
 * course, and records what it went past with who and why (`staff_enrolment_events`, keyed `enrol:<course>:<learner>:<n>`
 * with n the learner's enrolment count on the course). Programme prerequisites still apply. A bulk upload answers each
 * address with its enrolment or its refusal, sends no mail, and is keyed by its course and its addresses, so the same
 * upload again answers the stored rows and changes nothing. How many addresses one upload may hold is an owner value:
 * blank refuses `academy.bulk_limit_unset`.
 *
 * Addresses are resolved to accounts by the console through identity's exact lookup; svc-academy never reads identity's
 * tables. An invitation keeps only a one-way hash of the address and a masked form for staff.
 *
 * A course email is written first, with every recipient's state, then sent. This build has no email provider, so the
 * send is refused with the allowlisted `vendor.email` and no recipient is ever marked sent. Learners who opted out of the
 * course's email, and learners with no learning for longer than the owner's inactivity period, are left out; a blank
 * period refuses `academy.inactivity_period_unset` before anything is written.
 *
 * A learner export is a task: written as queued, run in the background, and kept with its finish time and the SHA-256 of
 * its CSV until the owner's retention ends; a blank retention or row limit refuses. No money moves.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { ACADEMY_ENROLMENT_BYPASSES } from '@intafaced/contracts';
import { defineRefusals, requireSetting } from '@intafaced/service-kit';
import type { CurriculumPath } from '../curriculum/catalog.js';
import { courseClosedReason, type CourseTerms } from '../curriculum/course-terms.js';
import { csvField } from '../curriculum/grade-reports.js';

export const staffEnrolmentRefusals = defineRefusals('StaffEnrolmentError', {
  'academy.reason_required': 'BAD_REQUEST',
  'academy.course_not_found': 'NOT_FOUND',
  'academy.bulk_limit_unset': 'PRECONDITION_FAILED',
  'academy.bulk_limit_exceeded': 'BAD_REQUEST',
  'academy.address_invalid': 'BAD_REQUEST',
  'academy.learner_not_found': 'NOT_FOUND',
  'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
  'academy.inactivity_period_unset': 'PRECONDITION_FAILED',
  'academy.audience_empty': 'PRECONDITION_FAILED',
  'academy.report_retention_unset': 'PRECONDITION_FAILED',
  'academy.report_limit_unset': 'PRECONDITION_FAILED',
  'academy.report_not_found': 'NOT_FOUND',
  'academy.report_not_ready': 'PRECONDITION_FAILED',
  'academy.report_expired': 'PRECONDITION_FAILED',
  'academy.email_not_found': 'NOT_FOUND',
  'academy.email_incomplete': 'BAD_REQUEST',
});
const refuse = staffEnrolmentRefusals.refuse;

/** What a staff enrolment went past: a reason the course is closed to a learner enrolling themselves. */
export type EnrolmentBypass = (typeof ACADEMY_ENROLMENT_BYPASSES)[number];

export type StaffEnrolmentEvent = {
  key: string;
  path: string;
  userId: string;
  source: 'staff' | 'bulk';
  bypassed: EnrolmentBypass[];
  reason: string;
  actorId: string;
  at: string;
};

export type BulkRowOutcome = 'enrolled' | 'already_enrolled' | 'refused';
export type BulkRow = {
  address: string;
  outcome: BulkRowOutcome;
  /** The refusal of this one address; null when it was enrolled or already was. */
  code: 'academy.address_invalid' | 'academy.learner_not_found' | 'academy.duplicate_address' | 'academy.prerequisite_unmet' | null;
  userId: string | null;
};
export type BulkEnrolResult = { key: string; path: string; rows: BulkRow[]; replayed: boolean; mail: 'none'; at: string };

export type CourseInvitation = {
  key: string;
  path: string;
  addressMask: string;
  reason: string;
  invitedBy: string;
  at: string;
  /** The invitation mail needs an email provider; this build has none, so the mail step names it. */
  mail: 'vendor.email';
};

export type BulkEmailRecipientState = 'not_sent' | 'sent' | 'skipped_opted_out' | 'skipped_inactive';
export type BulkEmail = {
  id: string;
  key: string;
  path: string;
  subject: string;
  inactiveDays: number;
  state: 'refused' | 'sent';
  refusal: 'vendor.email' | null;
  actorId: string;
  at: string;
  counts: Record<BulkEmailRecipientState, number>;
};
export type BulkEmailDetail = BulkEmail & { recipients: Array<{ userId: string; state: BulkEmailRecipientState }> };

export type ReportTaskState = 'queued' | 'running' | 'done' | 'failed';
export type ReportTask = {
  id: string;
  key: string;
  kind: 'learners';
  tag: string | null;
  requestedBy: string;
  state: ReportTaskState;
  rows: number | null;
  sha256: string | null;
  failure: string | null;
  requestedAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
};
export type ReportFile = ReportTask & { csv: string };

/** Lower-case trimmed, so one person's address is one key however it was typed. */
export const normaliseAddress = (address: string) => address.trim().toLowerCase();
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isAddress = (address: string) => address.length <= 254 && ADDRESS.test(address);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The first letter of the name and the whole domain: enough for staff to recognise, never the whole address. */
export const maskAddress = (address: string) => {
  const [name = '', domain = ''] = address.split('@');
  return `${name.slice(0, 1)}***@${domain}`;
};

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) refuse('academy.reason_required', 'a reason is required');
  return trimmed;
}

type EventSql = {
  key: string;
  path: string;
  user_id: string;
  source: 'staff' | 'bulk';
  bypassed: EnrolmentBypass[];
  reason: string;
  actor_id: string;
  at: Date;
};
const eventOf = (r: EventSql): StaffEnrolmentEvent => ({
  key: r.key,
  path: r.path,
  userId: r.user_id,
  source: r.source,
  bypassed: r.bypassed,
  reason: r.reason,
  actorId: r.actor_id,
  at: r.at.toISOString(),
});

type ReportSql = {
  id: string;
  key: string;
  kind: 'learners';
  tag: string | null;
  requested_by: string;
  state: ReportTaskState;
  rows: number | null;
  content_hash: string | null;
  failure: string | null;
  requested_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
};
const REPORT_COLUMNS = 'id, key, kind, tag, requested_by, state, rows, content_hash, failure, requested_at, finished_at, expires_at';
const taskOf = (r: ReportSql, now: Date): ReportTask => ({
  id: r.id,
  key: r.key,
  kind: r.kind,
  tag: r.tag,
  requestedBy: r.requested_by,
  state: r.state,
  rows: r.rows,
  sha256: r.content_hash,
  failure: r.failure,
  requestedAt: r.requested_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  expiresAt: r.expires_at?.toISOString() ?? null,
  expired: r.expires_at !== null && r.expires_at.getTime() <= now.getTime(),
});

export type StaffEnrolmentLimits = {
  bulkEnrolRows: number | null;
  inactiveDays: number | null;
  reportRetentionHours: number | null;
  exportRows: number | null;
};

/** What the staff door needs from the rest of the service: a course's terms, its seats, and its prerequisites. */
export type CourseDoor = {
  terms(path: CurriculumPath): Promise<CourseTerms>;
  /** The programme prerequisites the learner has not met for this course; empty when none. */
  unmetPrerequisites(userId: string, path: CurriculumPath): Promise<string[]>;
};

export class StaffEnrolment {
  constructor(
    private readonly sql: Sql,
    private readonly limits: StaffEnrolmentLimits,
    private readonly door: CourseDoor,
    /** Test seam: when a queued export runs. Production runs it on the next turn of the event loop. */
    private readonly schedule: (job: () => Promise<void>) => void = (job) => void setImmediate(() => void job()),
  ) {}

  /**
   * One learner enrolled by staff, past whatever closes the course to them, with the reason. Already enrolled answers
   * the active enrolment with no new event; a replay of the same enrolment answers its stored event.
   */
  async enrol(input: {
    path: CurriculumPath;
    userId: string;
    reason: string;
    actorId: string;
    source?: 'staff' | 'bulk';
    now?: Date;
  }): Promise<{ outcome: 'enrolled' | 'already_enrolled'; event: StaffEnrolmentEvent | null }> {
    const reason = requireReason(input.reason);
    const missing = await this.door.unmetPrerequisites(input.userId, input.path);
    if (missing.length > 0) refuse('academy.prerequisite_unmet', `academy.prerequisite_unmet missing=${missing.join(',')}`);
    const terms = await this.door.terms(input.path);
    const now = input.now ?? new Date();
    return this.sql.begin(async (tx) => {
      // The same lock as a learner's own enrolment under a cap, so the seat count and this enrolment agree.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`academy.course_seats:${input.path}`}))`;
      const [active] = await tx<Array<{ id: string }>>`
        SELECT id FROM academy.cert_enrollments WHERE user_id = ${input.userId} AND path_slug = ${input.path} AND left_at IS NULL
      `;
      if (active) return { outcome: 'already_enrolled' as const, event: null };
      const [counts] = await tx<Array<{ taken: number; n: number }>>`
        SELECT (SELECT count(*)::int FROM academy.cert_enrollments WHERE path_slug = ${input.path} AND left_at IS NULL) AS taken,
               (SELECT count(*)::int FROM academy.cert_enrollments WHERE path_slug = ${input.path} AND user_id = ${input.userId}) + 1 AS n
      `;
      const { taken, n } = counts!;
      const bypassed = closedReasons(terms, taken, now);
      await tx`
        INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) VALUES (${input.userId}, ${input.path}, ${now})
      `;
      const [event] = await tx<EventSql[]>`
        INSERT INTO academy.staff_enrolment_events (key, path, user_id, source, bypassed, reason, actor_id, at)
        VALUES (${`enrol:${input.path}:${input.userId}:${n}`}, ${input.path}, ${input.userId}, ${input.source ?? 'staff'},
                ${bypassed}::text[], ${reason}, ${input.actorId}, ${now})
        RETURNING key, path, user_id, source, bypassed, reason, actor_id, at
      `;
      return { outcome: 'enrolled' as const, event: eventOf(event!) };
    });
  }

  /** The newest staff enrolments, of one course or all, with what each went past and why. */
  async events(input: { path?: CurriculumPath; userId?: string; limit: number }): Promise<StaffEnrolmentEvent[]> {
    const rows = await this.sql<EventSql[]>`
      SELECT key, path, user_id, source, bypassed, reason, actor_id, at FROM academy.staff_enrolment_events
       WHERE (${input.path ?? null}::text IS NULL OR path = ${input.path ?? null})
         AND (${input.userId ?? null}::uuid IS NULL OR user_id = ${input.userId ?? null})
       ORDER BY at DESC, key DESC
       LIMIT ${input.limit}
    `;
    return rows.map(eventOf);
  }

  /**
   * A bulk upload: each address enrolled, already enrolled, or listed with its refusal. No mail is sent. The upload is
   * keyed by its course and its addresses (normalised, sorted), so the same upload again answers the stored rows.
   */
  async bulkEnrol(input: {
    path: CurriculumPath;
    rows: Array<{ address: string; userId: string | null }>;
    reason: string;
    actorId: string;
    now?: Date;
  }): Promise<BulkEnrolResult> {
    const limit = requireSetting(this.limits.bulkEnrolRows, staffEnrolmentRefusals, 'academy.bulk_limit_unset');
    const reason = requireReason(input.reason);
    if (input.rows.length === 0) refuse('academy.address_invalid', 'the upload holds no address');
    if (input.rows.length > limit)
      refuse('academy.bulk_limit_exceeded', `${input.rows.length} addresses, over the ${limit} one upload may hold`, {
        limit: String(limit),
      });
    const addresses = input.rows.map((row) => normaliseAddress(row.address));
    const key = `bulkenrol:${input.path}:${sha256([...addresses].sort().join('\n'))}`;
    const stored = await this.storedUpload(key);
    if (stored) return { ...stored, replayed: true };
    const seen = new Set<string>();
    const rows: BulkRow[] = [];
    for (const [i, row] of input.rows.entries()) {
      const address = addresses[i]!;
      const answer = (outcome: BulkRowOutcome, code: BulkRow['code'], userId: string | null) =>
        rows.push({ address, outcome, code, userId });
      if (!isAddress(address)) answer('refused', 'academy.address_invalid', null);
      else if (seen.has(address)) answer('refused', 'academy.duplicate_address', null);
      else if (!row.userId) answer('refused', 'academy.learner_not_found', null);
      else {
        try {
          const done = await this.enrol({ path: input.path, userId: row.userId, reason, actorId: input.actorId, source: 'bulk' });
          answer(done.outcome, null, row.userId);
        } catch (err) {
          if (staffEnrolmentRefusals.is(err) && err.code === 'academy.prerequisite_unmet')
            answer('refused', 'academy.prerequisite_unmet', row.userId);
          else throw err;
        }
      }
      seen.add(address);
    }
    const at = input.now ?? new Date();
    const [kept] = await this.sql<Array<{ at: Date }>>`
      INSERT INTO academy.bulk_enrol_uploads (key, path, rows, reason, actor_id, at)
      VALUES (${key}, ${input.path}, ${this.sql.json(rows)}, ${reason}, ${input.actorId}, ${at})
      ON CONFLICT (key) DO NOTHING
      RETURNING at
    `;
    if (!kept) return { ...(await this.storedUpload(key))!, replayed: true };
    return { key, path: input.path, rows, replayed: false, mail: 'none', at: kept.at.toISOString() };
  }

  private async storedUpload(key: string): Promise<Omit<BulkEnrolResult, 'replayed'> | null> {
    const [row] = await this.sql<Array<{ key: string; path: string; rows: BulkRow[]; at: Date }>>`
      SELECT key, path, rows, at FROM academy.bulk_enrol_uploads WHERE key = ${key}
    `;
    return row ? { key: row.key, path: row.path, rows: row.rows, mail: 'none', at: row.at.toISOString() } : null;
  }

  /** An address invited to a course, once per course and address; the mail step needs an email provider. */
  async invite(input: {
    path: CurriculumPath;
    address: string;
    reason: string;
    actorId: string;
    now?: Date;
  }): Promise<CourseInvitation & { replayed: boolean }> {
    const reason = requireReason(input.reason);
    const address = normaliseAddress(input.address);
    if (!isAddress(address)) refuse('academy.address_invalid', 'that is not an email address');
    const key = `invite:${input.path}:${sha256(address)}`;
    const [made] = await this.sql<InviteSql[]>`
      INSERT INTO academy.course_invitations (key, path, address_hash, address_mask, reason, invited_by, at)
      VALUES (${key}, ${input.path}, ${sha256(address)}, ${maskAddress(address)}, ${reason}, ${input.actorId}, ${input.now ?? new Date()})
      ON CONFLICT (key) DO NOTHING
      RETURNING key, path, address_mask, reason, invited_by, at
    `;
    if (made) return { ...inviteOf(made), replayed: false };
    const [kept] = await this.sql<InviteSql[]>`
      SELECT key, path, address_mask, reason, invited_by, at FROM academy.course_invitations WHERE key = ${key}
    `;
    return { ...inviteOf(kept!), replayed: true };
  }

  async invitations(input: { path?: CurriculumPath; limit: number }): Promise<CourseInvitation[]> {
    const rows = await this.sql<InviteSql[]>`
      SELECT key, path, address_mask, reason, invited_by, at FROM academy.course_invitations
       WHERE ${input.path ?? null}::text IS NULL OR path = ${input.path ?? null}
       ORDER BY at DESC, key DESC
       LIMIT ${input.limit}
    `;
    return rows.map(inviteOf);
  }

  /** A learner's own course email switch. */
  async setCourseEmails(input: { userId: string; path: CurriculumPath; on: boolean; now?: Date }): Promise<{ path: string; on: boolean }> {
    await this.sql`
      INSERT INTO academy.course_email_optouts (user_id, path, opted_out, at)
      VALUES (${input.userId}, ${input.path}, ${!input.on}, ${input.now ?? new Date()})
      ON CONFLICT (user_id, path) DO UPDATE SET opted_out = EXCLUDED.opted_out, at = EXCLUDED.at
    `;
    return { path: input.path, on: input.on };
  }

  async courseEmails(userId: string, path: CurriculumPath): Promise<{ path: string; on: boolean }> {
    const [row] = await this.sql<Array<{ opted_out: boolean }>>`
      SELECT opted_out FROM academy.course_email_optouts WHERE user_id = ${userId} AND path = ${path}
    `;
    return { path, on: !(row?.opted_out ?? false) };
  }

  /**
   * A course email to the course's learners. Written first with every recipient's state, then sent: with no email
   * provider the send is refused `vendor.email` and nobody is marked sent. The key is the console's
   * `mail:<course>:<n>` (n the next number in the course's history), so a retry answers the stored email.
   */
  async sendBulkEmail(input: {
    path: CurriculumPath;
    subject: string;
    body: string;
    key: string;
    actorId: string;
    now?: Date;
  }): Promise<BulkEmailDetail & { replayed: boolean }> {
    const days = requireSetting(this.limits.inactiveDays, staffEnrolmentRefusals, 'academy.inactivity_period_unset');
    const subject = input.subject.trim();
    if (!subject || !input.body.trim()) refuse('academy.email_incomplete', 'a course email needs a subject and a body');
    const now = input.now ?? new Date();
    const prior = await this.emailByKey(input.key);
    if (prior) return { ...prior, replayed: true };
    const made = await this.sql.begin(async (tx) => {
      const recipients = await tx<Array<{ user_id: string; opted_out: boolean; last_active: Date }>>`
        SELECT e.user_id,
               coalesce(o.opted_out, false) AS opted_out,
               greatest(e.enrolled_at, coalesce(s.last_opened_at, e.enrolled_at)) AS last_active
          FROM academy.cert_enrollments e
          LEFT JOIN academy.course_email_optouts o ON o.user_id = e.user_id AND o.path = e.path_slug
          LEFT JOIN academy.learning_state s ON s.user_id = e.user_id
         WHERE e.path_slug = ${input.path} AND e.left_at IS NULL
      `;
      if (recipients.length === 0) refuse('academy.audience_empty', 'no learner is enrolled in this course');
      const since = now.getTime() - days * 86_400_000;
      const [email] = await tx<Array<{ id: string }>>`
        INSERT INTO academy.bulk_emails (key, path, subject, body, inactive_days, state, refusal, actor_id, at)
        VALUES (${input.key}, ${input.path}, ${subject}, ${input.body}, ${days}, 'refused', 'vendor.email', ${input.actorId}, ${now})
        ON CONFLICT (key) DO NOTHING
        RETURNING id
      `;
      if (!email) return null;
      const states = recipients.map((r) => ({
        email_id: email.id,
        user_id: r.user_id,
        state: (r.opted_out
          ? 'skipped_opted_out'
          : r.last_active.getTime() < since
            ? 'skipped_inactive'
            : 'not_sent') satisfies BulkEmailRecipientState,
      }));
      await tx`INSERT INTO academy.bulk_email_recipients ${tx(states, 'email_id', 'user_id', 'state')}`;
      return email.id;
    });
    // Sending is the mail path's: this build has no email provider, so the email stays refused and nobody is sent.
    const stored = await this.emailByKey(input.key);
    return { ...stored!, replayed: made === null };
  }

  async bulkEmails(input: { path?: CurriculumPath; limit: number }): Promise<BulkEmail[]> {
    const rows = await this.sql<EmailSql[]>`
      SELECT ${this.sql.unsafe(EMAIL_COLUMNS)} FROM academy.bulk_emails m
       WHERE ${input.path ?? null}::text IS NULL OR m.path = ${input.path ?? null}
       ORDER BY m.at DESC, m.key DESC
       LIMIT ${input.limit}
    `;
    return rows.map(emailOf);
  }

  async bulkEmail(id: string): Promise<BulkEmailDetail> {
    const [row] = await this.sql<EmailSql[]>`SELECT ${this.sql.unsafe(EMAIL_COLUMNS)} FROM academy.bulk_emails m WHERE m.id = ${id}`;
    if (!row) return refuse('academy.email_not_found', 'no course email has that id');
    return this.detail(row);
  }

  private async emailByKey(key: string): Promise<BulkEmailDetail | null> {
    const [row] = await this.sql<EmailSql[]>`SELECT ${this.sql.unsafe(EMAIL_COLUMNS)} FROM academy.bulk_emails m WHERE m.key = ${key}`;
    return row ? this.detail(row) : null;
  }

  private async detail(row: EmailSql): Promise<BulkEmailDetail> {
    const recipients = await this.sql<Array<{ user_id: string; state: BulkEmailRecipientState }>>`
      SELECT user_id, state FROM academy.bulk_email_recipients WHERE email_id = ${row.id} ORDER BY user_id
    `;
    return { ...emailOf(row), recipients: recipients.map((r) => ({ userId: r.user_id, state: r.state })) };
  }

  /**
   * A learner export filtered by tag, requested once per press of Request (`report:learners:<tag>:<n>` from the
   * console, n the next number of the requester's exports), so a retry reuses the task. It runs in the background.
   */
  async requestLearnerExport(input: {
    tag: string | null;
    key: string;
    actorId: string;
    now?: Date;
  }): Promise<ReportTask & { replayed: boolean }> {
    const retention = requireSetting(this.limits.reportRetentionHours, staffEnrolmentRefusals, 'academy.report_retention_unset');
    const limit = requireSetting(this.limits.exportRows, staffEnrolmentRefusals, 'academy.report_limit_unset');
    const now = input.now ?? new Date();
    const [made] = await this.sql<ReportSql[]>`
      INSERT INTO academy.report_tasks (key, kind, tag, requested_by, state, row_limit, retention_hours, requested_at)
      VALUES (${input.key}, 'learners', ${input.tag}, ${input.actorId}, 'queued', ${limit}, ${retention}, ${now})
      ON CONFLICT (key) DO NOTHING
      RETURNING ${this.sql.unsafe(REPORT_COLUMNS)}
    `;
    if (!made) {
      const [kept] = await this.sql<
        ReportSql[]
      >`SELECT ${this.sql.unsafe(REPORT_COLUMNS)} FROM academy.report_tasks WHERE key = ${input.key}`;
      return { ...taskOf(kept!, now), replayed: true };
    }
    this.schedule(() => this.runExport(made.id));
    return { ...taskOf(made, now), replayed: false };
  }

  /** Runs one queued export: only the learners carrying the tag, with its finish time and the CSV's SHA-256. */
  async runExport(id: string): Promise<void> {
    const [task] = await this.sql<Array<{ tag: string | null; row_limit: number; retention_hours: number }>>`
      UPDATE academy.report_tasks SET state = 'running' WHERE id = ${id} AND state = 'queued'
      RETURNING tag, row_limit, retention_hours
    `;
    if (!task) return;
    try {
      const learners = await this.taggedLearners(task.tag, task.row_limit + 1);
      if (learners.length > task.row_limit) {
        await this.sql`
          UPDATE academy.report_tasks
             SET state = 'failed', failure = ${`academy.report_too_large: more than ${task.row_limit} learners`}, finished_at = now()
           WHERE id = ${id}
        `;
        return;
      }
      const finishedAt = new Date();
      const line = (cells: string[]) => cells.map(csvField).join(',');
      const csv = [
        line(['learner export', task.tag ? `tag ${task.tag}` : 'every learner', 'finished at', finishedAt.toISOString()]),
        line(['learner', 'courses', 'tags']),
        ...learners.map((l) => line([l.userId, l.paths.join(' '), l.tags.join(' ')])),
      ].join('\n');
      await this.sql`
        UPDATE academy.report_tasks
           SET state = 'done', rows = ${learners.length}, content = ${csv}, content_hash = ${sha256(csv)},
               finished_at = ${finishedAt}, expires_at = ${new Date(finishedAt.getTime() + task.retention_hours * 3_600_000)}
         WHERE id = ${id}
      `;
    } catch (err) {
      await this.sql`
        UPDATE academy.report_tasks SET state = 'failed', failure = ${String((err as Error).message).slice(0, 300)}, finished_at = now()
         WHERE id = ${id}
      `;
    }
  }

  private async taggedLearners(tag: string | null, limit: number) {
    const ids = await this.sql<Array<{ user_id: string }>>`
      SELECT user_id FROM (
        SELECT user_id FROM academy.cert_enrollments WHERE left_at IS NULL
        UNION SELECT user_id FROM academy.access_grants
        UNION SELECT user_id FROM academy.learner_tags
      ) people
      WHERE ${tag}::text IS NULL OR EXISTS (SELECT 1 FROM academy.learner_tags t WHERE t.user_id = people.user_id AND t.tag = ${tag})
      ORDER BY user_id
      LIMIT ${limit}
    `;
    const users = ids.map((r) => r.user_id);
    if (users.length === 0) return [];
    const [paths, tags] = await Promise.all([
      this.sql<Array<{ user_id: string; path_slug: string }>>`
        SELECT user_id, path_slug FROM academy.cert_enrollments WHERE left_at IS NULL AND user_id = ANY(${users}) ORDER BY path_slug
      `,
      this.sql<Array<{ user_id: string; tag: string }>>`
        SELECT user_id, tag FROM academy.learner_tags WHERE user_id = ANY(${users}) ORDER BY tag
      `,
    ]);
    return users.map((userId) => ({
      userId,
      paths: paths.filter((p) => p.user_id === userId).map((p) => p.path_slug),
      tags: tags.filter((t) => t.user_id === userId).map((t) => t.tag),
    }));
  }

  async reports(input: { limit: number; now?: Date }): Promise<ReportTask[]> {
    const rows = await this.sql<ReportSql[]>`
      SELECT ${this.sql.unsafe(REPORT_COLUMNS)} FROM academy.report_tasks ORDER BY requested_at DESC, key DESC LIMIT ${input.limit}
    `;
    return rows.map((r) => taskOf(r, input.now ?? new Date()));
  }

  /** A finished export's CSV, exactly as it was made; an unfinished or expired one refuses by name. */
  async reportFile(id: string, now: Date = new Date()): Promise<ReportFile> {
    const [row] = await this.sql<Array<ReportSql & { content: string | null }>>`
      SELECT ${this.sql.unsafe(REPORT_COLUMNS)}, content FROM academy.report_tasks WHERE id = ${id}
    `;
    if (!row) return refuse('academy.report_not_found', 'no report has that id');
    const task = taskOf(row, now);
    if (task.state !== 'done' || row.content === null) return refuse('academy.report_not_ready', `the report is ${task.state}`);
    if (task.expired) return refuse('academy.report_expired', `the report expired at ${task.expiresAt}`);
    return { ...task, csv: row.content };
  }
}

/** Every reason the course is closed to a learner enrolling themselves now: what a staff enrolment goes past. */
function closedReasons(terms: CourseTerms, taken: number, now: Date): EnrolmentBypass[] {
  const out: EnrolmentBypass[] = [];
  if (terms.visibility !== 'published') out.push(terms.visibility);
  const timeOnly = courseClosedReason({ ...terms, visibility: 'published', seatCap: null }, 0, now);
  if (timeOnly === 'window_not_started' || timeOnly === 'window_ended') out.push(timeOnly);
  if (terms.seatCap !== null && taken >= terms.seatCap) out.push('full');
  return out;
}

type InviteSql = { key: string; path: string; address_mask: string; reason: string; invited_by: string; at: Date };
const inviteOf = (r: InviteSql): CourseInvitation => ({
  key: r.key,
  path: r.path,
  addressMask: r.address_mask,
  reason: r.reason,
  invitedBy: r.invited_by,
  at: r.at.toISOString(),
  mail: 'vendor.email',
});

type EmailSql = {
  id: string;
  key: string;
  path: string;
  subject: string;
  inactive_days: number;
  state: 'refused' | 'sent';
  refusal: 'vendor.email' | null;
  actor_id: string;
  at: Date;
  not_sent: number;
  sent: number;
  skipped_opted_out: number;
  skipped_inactive: number;
};
const EMAIL_COLUMNS = `m.id, m.key, m.path, m.subject, m.inactive_days, m.state, m.refusal, m.actor_id, m.at,
  (SELECT count(*)::int FROM academy.bulk_email_recipients r WHERE r.email_id = m.id AND r.state = 'not_sent') AS not_sent,
  (SELECT count(*)::int FROM academy.bulk_email_recipients r WHERE r.email_id = m.id AND r.state = 'sent') AS sent,
  (SELECT count(*)::int FROM academy.bulk_email_recipients r WHERE r.email_id = m.id AND r.state = 'skipped_opted_out') AS skipped_opted_out,
  (SELECT count(*)::int FROM academy.bulk_email_recipients r WHERE r.email_id = m.id AND r.state = 'skipped_inactive') AS skipped_inactive`;
const emailOf = (r: EmailSql): BulkEmail => ({
  id: r.id,
  key: r.key,
  path: r.path,
  subject: r.subject,
  inactiveDays: r.inactive_days,
  state: r.state,
  refusal: r.refusal,
  actorId: r.actor_id,
  at: r.at.toISOString(),
  counts: { not_sent: r.not_sent, sent: r.sent, skipped_opted_out: r.skipped_opted_out, skipped_inactive: r.skipped_inactive },
});
