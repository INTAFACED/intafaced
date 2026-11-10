/**
 * J-academy-14 — the staff desk for one learner (AC-enrolment-03, AC-progress-03, AC-release-access-02, AC-access-grants-01).
 *
 * What staff read: the learner's enrolments, access records with their events, internal notes, tags, every item of
 * their courses with its completion history (an Undo keeps its tombstone), quiz attempts with any void, due dates with
 * the learner's own moved date, and one audit of every staff change with who and why.
 *
 * What staff change, each with a reason and an event: a note, a tag, an item marked complete for the learner, a quiz
 * attempt voided (it stops counting against the attempt limit, the grade and the pass; nothing is deleted), and the
 * learner's access record: granted with an optional end, and reinstated on the same row once it has ended.
 *
 * Access: a course's access record, when one exists, decides whether the learner may open its items. Without one, the
 * learner's free enrolment is the record and never ends. An ended record refuses `academy.grant_expired`; the first read
 * after the end moves the row to `expired` and writes that event once. Internal notes and staff ids never reach a learner
 * read. No money moves here.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { AcademyLearnerGrant, AcademyLearnerPage, AcademyLearnerProgress, AcademyLearners } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { CURRICULUM_PATHS, getCurriculumItem, listCurriculum, type CurriculumPath } from '../curriculum/catalog.js';

type GrantRow = {
  id: string;
  user_id: string;
  path_slug: string;
  source: AcademyLearnerGrant['source'];
  reason: string | null;
  starts_at: Date;
  expires_at: Date | null;
  state: AcademyLearnerGrant['state'];
};
type GrantEventRow = {
  grant_id: string;
  n: number;
  kind: AcademyLearnerGrant['events'][number]['kind'];
  reason: string | null;
  actor_id: string | null;
  expires_at: Date | null;
  at: Date;
};
type LearnerEventKind = 'note_added' | 'tag_added' | 'tag_removed' | 'marked_complete' | 'quiz_attempt_voided';

const PATH_TITLES: Record<CurriculumPath, string> = {
  foundations: 'Foundations',
  markets: 'Markets',
  builder: 'Builder',
  sovereign: 'Sovereign',
};
const isPath = (slug: string): slug is CurriculumPath => (CURRICULUM_PATHS as readonly string[]).includes(slug);

/** Blank after trim is not a reason, and none is ever invented. */
export function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new AcademyError('academy.reason_required a reason is required', 'academy.reason_required');
  return trimmed;
}

const day = (at: Date) => at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export class LearnerDesk {
  constructor(private readonly sql: Sql) {}

  /**
   * Whether the learner may open items of `path` now. No access record: the free enrolment decides, as before. A record
   * that has ended refuses `academy.grant_expired`, and its expiry is written on this read when it is not yet.
   */
  async assertAccess(userId: string, path: string, now: Date = new Date()): Promise<void> {
    const [row] = await this.sql<GrantRow[]>`
      SELECT id, user_id, path_slug, source, reason, starts_at, expires_at, state
        FROM academy.access_grants WHERE user_id = ${userId} AND path_slug = ${path}
    `;
    if (!row) return;
    if (row.state === 'granted' && (row.expires_at === null || row.expires_at.getTime() > now.getTime())) return;
    if (row.state === 'granted') await this.settleExpiries(userId, now);
    throw new AcademyError(
      `academy.grant_expired course=${path} ${row.state === 'revoked' ? 'revoked' : `ended=${(row.expires_at ?? now).toISOString()}`}`,
      'academy.grant_expired',
    );
  }

  /** Writes the expired event, once, for every record of this learner whose end has passed. */
  private async settleExpiries(userId: string, now: Date): Promise<void> {
    await transaction(this.sql, async (tx) => {
      const due = await tx<Array<{ id: string; expires_at: Date }>>`
        SELECT id, expires_at FROM academy.access_grants
         WHERE user_id = ${userId} AND state = 'granted' AND expires_at IS NOT NULL AND expires_at <= ${now}
         FOR UPDATE
      `;
      for (const grant of due) {
        const n = await this.nextGrantEvent(tx, grant.id);
        await tx`UPDATE academy.access_grants SET state = 'expired', updated_at = ${now} WHERE id = ${grant.id}`;
        await tx`
          INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at)
          VALUES (${grant.id}, ${n}, 'expired', ${`expire:${grant.id}:${n}`}, null, null, ${grant.expires_at}, ${grant.expires_at})
        `;
      }
    });
  }

  private async nextGrantEvent(tx: Sql, grantId: string): Promise<number> {
    const [row] = await tx<Array<{ n: number }>>`
      SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.access_grant_events WHERE grant_id = ${grantId}
    `;
    return row!.n;
  }

  /** Every access record of the learner: the stored ones with their events, and a free one per enrolment without one. */
  private async access(userId: string): Promise<AcademyLearnerGrant[]> {
    const [grants, events, enrolments] = await Promise.all([
      this.sql<GrantRow[]>`
        SELECT id, user_id, path_slug, source, reason, starts_at, expires_at, state
          FROM academy.access_grants WHERE user_id = ${userId} ORDER BY created_at, id
      `,
      this.sql<GrantEventRow[]>`
        SELECT e.grant_id, e.n, e.kind, e.reason, e.actor_id, e.expires_at, e.at
          FROM academy.access_grant_events e JOIN academy.access_grants g ON g.id = e.grant_id
         WHERE g.user_id = ${userId} ORDER BY e.grant_id, e.n
      `,
      this.sql<Array<{ path_slug: string; enrolled_at: Date }>>`
        SELECT path_slug, enrolled_at FROM academy.cert_enrollments WHERE user_id = ${userId} AND left_at IS NULL ORDER BY enrolled_at
      `,
    ]);
    const stored = grants
      .filter((g) => isPath(g.path_slug))
      .map((g) => ({
        id: g.id,
        pathSlug: g.path_slug as CurriculumPath,
        source: g.source,
        reason: g.reason,
        startsAt: g.starts_at.toISOString(),
        expiresAt: g.expires_at?.toISOString() ?? null,
        state: g.state,
        events: events
          .filter((e) => e.grant_id === g.id)
          .map((e) => ({
            n: e.n,
            kind: e.kind,
            reason: e.reason,
            actorId: e.actor_id,
            expiresAt: e.expires_at?.toISOString() ?? null,
            at: e.at.toISOString(),
          })),
      }));
    const free = enrolments
      .filter((e) => isPath(e.path_slug) && !grants.some((g) => g.path_slug === e.path_slug))
      .map((e) => ({
        id: null,
        pathSlug: e.path_slug as CurriculumPath,
        source: 'free' as const,
        reason: null,
        startsAt: e.enrolled_at.toISOString(),
        expiresAt: null,
        state: 'granted' as const,
        events: [],
      }));
    return [...stored, ...free];
  }

  /** The learner page. Reading it settles any access record whose end has passed, so the page never shows an ended one as live. */
  async page(userId: string, canChange: boolean, now: Date = new Date()): Promise<AcademyLearnerPage> {
    await this.settleExpiries(userId, now);
    const [enrolments, access, notes, tags, events, extensions] = await Promise.all([
      this.sql<Array<{ path_slug: string; enrolled_at: Date; left_at: Date | null }>>`
        SELECT path_slug, enrolled_at, left_at FROM academy.cert_enrollments WHERE user_id = ${userId} ORDER BY enrolled_at, path_slug
      `,
      this.access(userId),
      this.sql<Array<{ n: number; body: string; author_id: string; at: Date }>>`
        SELECT n, body, author_id, at FROM academy.learner_notes WHERE user_id = ${userId} ORDER BY n DESC
      `,
      this.sql<Array<{ tag: string; added_by: string; added_at: Date }>>`
        SELECT tag, added_by, added_at FROM academy.learner_tags WHERE user_id = ${userId} ORDER BY tag
      `,
      this.sql<Array<{ kind: LearnerEventKind; at: Date; actor_id: string; reason: string; detail: string }>>`
        SELECT kind, at, actor_id, reason, detail FROM academy.learner_events WHERE user_id = ${userId}
      `,
      this.sql<Array<{ item_slug: string; revision: number; reason: string; extended_until: Date; granted_by: string; granted_at: Date }>>`
        SELECT item_slug, revision, reason, extended_until, granted_by, granted_at FROM academy.item_extensions WHERE user_id = ${userId}
      `,
    ]);
    const audit: AcademyLearnerPage['audit'] = [
      ...events.map((e) => ({ kind: e.kind, at: e.at.toISOString(), actorId: e.actor_id, reason: e.reason, detail: e.detail })),
      ...extensions.map((x) => ({
        kind: 'extension_granted' as const,
        at: x.granted_at.toISOString(),
        actorId: x.granted_by,
        reason: x.reason,
        detail: `${getCurriculumItem(x.item_slug)?.title ?? x.item_slug}: due date moved to ${day(x.extended_until)} for this learner`,
      })),
      ...access.flatMap((g) =>
        g.events.map((e) => ({
          kind:
            e.kind === 'granted'
              ? ('grant_granted' as const)
              : e.kind === 'expired'
                ? ('grant_expired' as const)
                : ('grant_reinstated' as const),
          at: e.at,
          actorId: e.actorId,
          reason: e.reason,
          detail:
            e.kind === 'expired'
              ? `Access to ${PATH_TITLES[g.pathSlug]} ended`
              : `Access to ${PATH_TITLES[g.pathSlug]} ${e.kind === 'granted' ? 'granted' : 'reinstated'} (${g.source}), ${
                  e.expiresAt ? `until ${day(new Date(e.expiresAt))}` : 'with no end'
                }`,
        })),
      ),
    ].sort((a, b) => (a.at === b.at ? a.kind.localeCompare(b.kind) : b.at.localeCompare(a.at)));
    return {
      userId,
      canChange,
      enrolments: enrolments
        .filter((e) => isPath(e.path_slug))
        .map((e) => ({
          pathSlug: e.path_slug as CurriculumPath,
          enrolledAt: e.enrolled_at.toISOString(),
          leftAt: e.left_at?.toISOString() ?? null,
        })),
      access,
      notes: notes.map((n) => ({ n: n.n, body: n.body, authorId: n.author_id, at: n.at.toISOString() })),
      tags: tags.map((t) => ({ tag: t.tag, addedBy: t.added_by, addedAt: t.added_at.toISOString() })),
      audit,
    };
  }

  /** Every item of each course the learner is or was enrolled in, or holds an access record for, in course order. */
  async progress(userId: string, canChange: boolean): Promise<AcademyLearnerProgress> {
    const pathRows = await this.sql<Array<{ path_slug: string }>>`
      SELECT path_slug FROM academy.cert_enrollments WHERE user_id = ${userId}
      UNION SELECT path_slug FROM academy.access_grants WHERE user_id = ${userId}
    `;
    const paths = CURRICULUM_PATHS.filter((path) => pathRows.some((row) => row.path_slug === path));
    const slugs = paths.flatMap((path) => listCurriculum({ path }).map((item) => item.slug));
    if (slugs.length === 0) return { userId, canChange, courses: [] };
    const [completions, history, windows, extensions, quizzes, attempts] = await Promise.all([
      this.sql<Array<{ item_slug: string; completed_at: Date }>>`
        SELECT item_slug, completed_at FROM academy.cert_item_completions WHERE user_id = ${userId} AND item_slug = ANY(${slugs})
      `,
      this.sql<Array<{ item_slug: string; event: 'completed' | 'undone'; recorded_at: Date }>>`
        SELECT item_slug, event, recorded_at FROM academy.item_completion_events
         WHERE user_id = ${userId} AND item_slug = ANY(${slugs}) ORDER BY recorded_at, id
      `,
      this.sql<Array<{ item_slug: string; due_at: Date | null }>>`
        SELECT item_slug, due_at FROM academy.item_windows WHERE item_slug = ANY(${slugs})
      `,
      this.sql<Array<{ item_slug: string; revision: number; reason: string; extended_until: Date; granted_by: string; granted_at: Date }>>`
        SELECT DISTINCT ON (item_slug) item_slug, revision, reason, extended_until, granted_by, granted_at
          FROM academy.item_extensions WHERE user_id = ${userId} AND item_slug = ANY(${slugs})
         ORDER BY item_slug, revision DESC
      `,
      this.sql<Array<{ slug: string; attempt_limit: number | null }>>`
        SELECT slug, attempt_limit FROM academy.quizzes WHERE slug = ANY(${slugs})
      `,
      this.sql<
        Array<{
          id: string;
          slug: string;
          score: number;
          max_score: number;
          passed: boolean;
          submitted_at: Date;
          voided_at: Date | null;
          voided_by: string | null;
          void_reason: string | null;
        }>
      >`
        SELECT id, slug, score, max_score, passed, submitted_at, voided_at, voided_by, void_reason
          FROM academy.assessment_attempts WHERE user_id = ${userId} AND slug = ANY(${slugs})
         ORDER BY submitted_at, id
      `,
    ]);
    return {
      userId,
      canChange,
      courses: paths.map((path) => ({
        pathSlug: path,
        items: listCurriculum({ path }).map((item) => {
          const done = completions.find((c) => c.item_slug === item.slug);
          const past = history.filter((h) => h.item_slug === item.slug);
          const quiz = quizzes.find((q) => q.slug === item.slug);
          const tries = attempts.filter((a) => a.slug === item.slug);
          const ext = extensions.find((x) => x.item_slug === item.slug);
          return {
            slug: item.slug,
            title: item.title,
            kind: item.kind,
            status: done ? ('completed' as const) : past.length > 0 ? ('undone' as const) : ('not_started' as const),
            completedAt: done?.completed_at.toISOString() ?? null,
            history: past.map((h) => ({ event: h.event, at: h.recorded_at.toISOString() })),
            dueAt: windows.find((w) => w.item_slug === item.slug)?.due_at?.toISOString() ?? null,
            extension: ext
              ? {
                  until: ext.extended_until.toISOString(),
                  reason: ext.reason,
                  grantedBy: ext.granted_by,
                  grantedAt: ext.granted_at.toISOString(),
                  revision: ext.revision,
                }
              : null,
            quiz:
              quiz || tries.length > 0
                ? {
                    attemptLimit: quiz?.attempt_limit ?? null,
                    counted: tries.filter((a) => a.voided_at === null).length,
                    attempts: tries.map((a) => ({
                      attemptId: a.id,
                      score: a.score,
                      maxScore: a.max_score,
                      passed: a.passed,
                      submittedAt: a.submitted_at.toISOString(),
                      voided: a.voided_at ? { at: a.voided_at.toISOString(), by: a.voided_by!, reason: a.void_reason! } : null,
                    })),
                  }
                : null,
          };
        }),
      })),
    };
  }

  /** An internal note, keyed by the console's request. Never returned to the learner. */
  async addNote(input: { userId: string; body: string; key: string; actorId: string; now?: Date }): Promise<{ n: number }> {
    const body = input.body.trim();
    if (!body) throw new AcademyError('academy.reason_required a note needs words', 'academy.reason_required');
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:learner-notes`}, 0))`;
      const [replay] = await tx<Array<{ n: number; body: string }>>`
        SELECT n, body FROM academy.learner_notes WHERE user_id = ${input.userId} AND key = ${input.key}
      `;
      // The key names the note number the console expects to write: the same note again is a replay; another note under
      // it means someone wrote one meanwhile, so it refuses rather than dropping this one.
      if (replay && replay.body === body) return { n: replay.n };
      if (replay)
        throw new AcademyError('academy.revision_stale another note was saved first; read the page again', 'academy.revision_stale');
      const [next] = await tx<Array<{ n: number }>>`
        SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.learner_notes WHERE user_id = ${input.userId}
      `;
      await tx`
        INSERT INTO academy.learner_notes (user_id, n, body, key, author_id, at)
        VALUES (${input.userId}, ${next!.n}, ${body}, ${input.key}, ${input.actorId}, ${now})
      `;
      await this.event(tx, {
        userId: input.userId,
        kind: 'note_added',
        key: `note:${input.userId}:${next!.n}`,
        itemSlug: null,
        detail: `Internal note ${next!.n} added`,
        reason: 'Internal note',
        actorId: input.actorId,
        now,
      });
      return { n: next!.n };
    });
  }

  private async event(
    tx: Sql,
    e: {
      userId: string;
      kind: LearnerEventKind;
      key: string;
      itemSlug: string | null;
      detail: string;
      reason: string;
      actorId: string;
      now: Date;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO academy.learner_events (user_id, kind, key, item_slug, detail, reason, actor_id, at)
      VALUES (${e.userId}, ${e.kind}, ${e.key}, ${e.itemSlug}, ${e.detail}, ${e.reason}, ${e.actorId}, ${e.now})
      ON CONFLICT (key) DO NOTHING
    `;
  }

  /** The stored key of an item staff marked complete: scoped to the learner and item, so no other change shares it. */
  static markKey(userId: string, itemSlug: string, key: string): string {
    return `mark:${userId}:${itemSlug}:${key}`;
  }

  /** Whether this mark-complete was already recorded under the console's key (a replay after a lost reply). */
  async markRecorded(userId: string, itemSlug: string, key: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM academy.learner_events
       WHERE key = ${LearnerDesk.markKey(userId, itemSlug, key)} AND user_id = ${userId} AND kind = 'marked_complete'
    `;
    return rows.length > 0;
  }

  /** The event for an item staff marked complete for the learner, written in the completion's own transaction. */
  async recordMarkComplete(tx: Sql, input: { userId: string; itemSlug: string; reason: string; key: string; actorId: string; now: Date }) {
    await this.event(tx, {
      userId: input.userId,
      kind: 'marked_complete',
      key: LearnerDesk.markKey(input.userId, input.itemSlug, input.key),
      itemSlug: input.itemSlug,
      detail: `${getCurriculumItem(input.itemSlug)?.title ?? input.itemSlug} marked complete for the learner`,
      reason: input.reason,
      actorId: input.actorId,
      now: input.now,
    });
  }

  /** One finished quiz attempt no longer counts. A repeat on a voided attempt answers as the first void did. */
  async voidAttempt(input: {
    userId: string;
    attemptId: string;
    reason: string;
    actorId: string;
    now?: Date;
  }): Promise<{ voidedAt: string }> {
    const reason = requireReason(input.reason);
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:assessment`}, 0))`;
      const [row] = await tx<Array<{ slug: string; score: number; max_score: number; voided_at: Date | null }>>`
        SELECT slug, score, max_score, voided_at FROM academy.assessment_attempts
         WHERE id = ${input.attemptId} AND user_id = ${input.userId} FOR UPDATE
      `;
      if (!row)
        throw new AcademyError('academy.attempt_not_found no finished attempt of this learner has that id', 'academy.attempt_not_found');
      if (row.voided_at) return { voidedAt: row.voided_at.toISOString() };
      await tx`
        UPDATE academy.assessment_attempts SET voided_at = ${now}, voided_by = ${input.actorId}, void_reason = ${reason}
         WHERE id = ${input.attemptId}
      `;
      await this.event(tx, {
        userId: input.userId,
        kind: 'quiz_attempt_voided',
        key: `void:${input.attemptId}`,
        itemSlug: row.slug,
        detail: `${getCurriculumItem(row.slug)?.title ?? row.slug}: quiz attempt scored ${row.score} of ${row.max_score} voided, so it no longer counts`,
        reason,
        actorId: input.actorId,
        now,
      });
      return { voidedAt: now.toISOString() };
    });
  }

  /** A staff access record, keyed `grant:<course>:<learner>`: a repeat answers with the stored record, never a second one. */
  async grantAccess(input: {
    userId: string;
    pathSlug: CurriculumPath;
    reason: string;
    expiresAt: Date | null;
    actorId: string;
    now?: Date;
  }): Promise<void> {
    const reason = requireReason(input.reason);
    const now = input.now ?? new Date();
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime())
      throw new AcademyError('academy.window_invalid the end must be after now', 'academy.window_invalid');
    await transaction(this.sql, async (tx) => {
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO academy.access_grants (user_id, path_slug, source, reason, starts_at, expires_at, state, created_at, updated_at)
        VALUES (${input.userId}, ${input.pathSlug}, 'staff', ${reason}, ${now}, ${input.expiresAt}, 'granted', ${now}, ${now})
        ON CONFLICT (path_slug, user_id) DO NOTHING
        RETURNING id
      `;
      if (!row) {
        // The course already has this learner's record: a repeat of a live grant answers as it is; an ended one is
        // reinstated on its own row, never granted a second time.
        const [held] = await tx<Array<{ state: string }>>`
          SELECT state FROM academy.access_grants WHERE path_slug = ${input.pathSlug} AND user_id = ${input.userId}
        `;
        if (held && held.state !== 'granted')
          throw new AcademyError('academy.grant_expired this access has ended: reinstate it instead', 'academy.grant_expired');
        return;
      }
      await tx`
        INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at)
        VALUES (${row.id}, 1, 'granted', ${`grant:${input.pathSlug}:${input.userId}`}, ${reason}, ${input.actorId}, ${input.expiresAt}, ${now})
      `;
    });
  }

  /**
   * The same record granted again, keyed `reinstate:<grant>:<n>` where `n` is the event number it becomes: a replay
   * answers as the first did, and an `n` that is no longer next refuses `academy.revision_stale`. Only an ended record
   * is reinstated; a live one refuses `academy.grant_active`.
   */
  async reinstate(input: {
    userId: string;
    grantId: string;
    reason: string;
    expiresAt: Date | null;
    n: number;
    actorId: string;
    now?: Date;
  }) {
    const reason = requireReason(input.reason);
    const now = input.now ?? new Date();
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime())
      throw new AcademyError('academy.window_invalid the end must be after now', 'academy.window_invalid');
    await this.settleExpiries(input.userId, now);
    const key = `reinstate:${input.grantId}:${input.n}`;
    await transaction(this.sql, async (tx) => {
      const [grant] = await tx<GrantRow[]>`
        SELECT id, user_id, path_slug, source, reason, starts_at, expires_at, state
          FROM academy.access_grants WHERE id = ${input.grantId} AND user_id = ${input.userId} FOR UPDATE
      `;
      if (!grant) throw new AcademyError('academy.grant_not_found this learner has no such access record', 'academy.grant_not_found');
      const [replay] = await tx`SELECT 1 FROM academy.access_grant_events WHERE key = ${key}`;
      if (replay) return;
      if (grant.state === 'granted') throw new AcademyError('academy.grant_active this access has not ended', 'academy.grant_active');
      const n = await this.nextGrantEvent(tx, grant.id);
      if (n !== input.n) throw new AcademyError(`academy.revision_stale the next event is ${n}`, 'academy.revision_stale');
      await tx`
        UPDATE academy.access_grants SET state = 'granted', expires_at = ${input.expiresAt}, updated_at = ${now} WHERE id = ${grant.id}
      `;
      await tx`
        INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at)
        VALUES (${grant.id}, ${n}, 'reinstated', ${key}, ${reason}, ${input.actorId}, ${input.expiresAt}, ${now})
      `;
    });
  }

  /** Adds a tag to each learner named. A learner who already carries it is left as they are. */
  async tag(input: { userIds: readonly string[]; tag: string; reason: string; actorId: string; now?: Date }): Promise<{ added: number }> {
    const reason = requireReason(input.reason);
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      let added = 0;
      for (const userId of [...new Set(input.userIds)]) {
        const rows = await tx`
          INSERT INTO academy.learner_tags (tag, user_id, added_by, added_at) VALUES (${input.tag}, ${userId}, ${input.actorId}, ${now})
          ON CONFLICT (tag, user_id) DO NOTHING RETURNING tag
        `;
        if (rows.length === 0) continue;
        added += 1;
        await this.event(tx, {
          userId,
          kind: 'tag_added',
          key: `tag-add:${input.tag}:${userId}:${now.toISOString()}`,
          itemSlug: null,
          detail: `Tag ${input.tag} added`,
          reason,
          actorId: input.actorId,
          now,
        });
      }
      return { added };
    });
  }

  async untag(input: { userId: string; tag: string; reason: string; actorId: string; now?: Date }): Promise<{ removed: boolean }> {
    const reason = requireReason(input.reason);
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      const rows = await tx`DELETE FROM academy.learner_tags WHERE tag = ${input.tag} AND user_id = ${input.userId} RETURNING tag`;
      if (rows.length === 0) return { removed: false };
      await this.event(tx, {
        userId: input.userId,
        kind: 'tag_removed',
        key: `tag-remove:${input.tag}:${input.userId}:${now.toISOString()}`,
        itemSlug: null,
        detail: `Tag ${input.tag} removed`,
        reason,
        actorId: input.actorId,
        now,
      });
      return { removed: true };
    });
  }

  async tags(): Promise<Array<{ tag: string; learners: number }>> {
    return this.sql<Array<{ tag: string; learners: number }>>`
      SELECT tag, count(*)::int AS learners FROM academy.learner_tags GROUP BY tag ORDER BY tag
    `;
  }

  /** The learners report: everyone with an enrolment, an access record or a tag; with `tag`, only those who carry it. */
  async learners(input: { tag?: string | undefined; limit: number }): Promise<AcademyLearners> {
    const tag = input.tag ?? null;
    const ids = await this.sql<Array<{ user_id: string }>>`
      SELECT user_id FROM (
        SELECT user_id FROM academy.cert_enrollments WHERE left_at IS NULL
        UNION SELECT user_id FROM academy.access_grants
        UNION SELECT user_id FROM academy.learner_tags
      ) people
      WHERE ${tag}::text IS NULL OR EXISTS (SELECT 1 FROM academy.learner_tags t WHERE t.user_id = people.user_id AND t.tag = ${tag})
      ORDER BY user_id
      LIMIT ${input.limit}
    `;
    const users = ids.map((row) => row.user_id);
    if (users.length === 0) return { tag, rows: [] };
    const [paths, tags] = await Promise.all([
      this.sql<Array<{ user_id: string; path_slug: string }>>`
        SELECT user_id, path_slug FROM academy.cert_enrollments WHERE left_at IS NULL AND user_id = ANY(${users}) ORDER BY path_slug
      `,
      this.sql<Array<{ user_id: string; tag: string }>>`
        SELECT user_id, tag FROM academy.learner_tags WHERE user_id = ANY(${users}) ORDER BY tag
      `,
    ]);
    return {
      tag,
      rows: users.map((userId) => ({
        userId,
        paths: paths.filter((p) => p.user_id === userId && isPath(p.path_slug)).map((p) => p.path_slug as CurriculumPath),
        tags: tags.filter((t) => t.user_id === userId).map((t) => t.tag),
      })),
    };
  }
}
