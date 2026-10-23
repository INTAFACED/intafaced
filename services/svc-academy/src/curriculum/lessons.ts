/**
 * AC-course-structure-03 — lesson content. A lesson is an outline item's content as ordered blocks (text, image, audio,
 * PDF, code). Every save is a new lesson revision; a revert copies an older revision's blocks into a new one, so history
 * is never rewritten. Learners see the item's live revision, which only `publish` moves: editing after publish changes
 * nothing a learner reads until the next publish. A duplicate copies the item and its newest lesson, never a learner
 * record (no enrolment, grant, completion or attempt row is read or written here).
 *
 * Idempotency: a save or revert is keyed `lesson:<item>:<revision>` (the primary key): a repeat after a lost reply finds
 * its own revision one on and answers with it; anything else is refused as stale. A publish over the course revision
 * read answers the same way. A duplicate over the course revision read replays when this founder's outline event at
 * the next revision made a copy of the same item.
 */
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyDuplicateItemInput,
  AcademyLesson,
  AcademyLessonBlock,
  AcademyPublishLessonInput,
  AcademyRevertLessonInput,
  AcademySaveLessonInput,
} from '@intafaced/contracts';
import { ACADEMY_ITEMS_WITHOUT_LESSON } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import type { CourseRecords } from './courses.js';

const REVISIONS_SHOWN = 50;

type ItemRow = {
  id: string;
  course_id: string;
  section_id: string;
  position: number;
  kind: string;
  title: string;
  indent: number;
  url: string | null;
  live_revision: number | null;
  live_course_revision: number | null;
  course_state: string;
  course_revision: number;
};

type RevisionRow = {
  revision: number;
  source: 'saved' | 'reverted' | 'duplicated';
  from_revision: number | null;
  from_item_id: string | null;
  blocks: AcademyLessonBlock[];
  actor: string;
  at: Date;
};

/** jsonb stores object keys in its own order, so blocks compare with their keys sorted. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(value);
const sameBlocks = (a: readonly AcademyLessonBlock[], b: readonly AcademyLessonBlock[]) => canonical(a) === canonical(b);

export class LessonRecords {
  constructor(
    private readonly sql: Sql,
    private readonly courses: CourseRecords,
  ) {}

  async save(input: AcademySaveLessonInput & { operatorId: string; now: Date }): Promise<AcademyLesson> {
    return this.sql.begin(async (tx) => {
      const item = await this.lockItem(tx, input.itemId);
      const newest = await this.newest(tx, item.id);
      if (newest?.revision === input.revision + 1 && newest.source === 'saved' && newest.actor === input.operatorId)
        if (sameBlocks(newest.blocks, input.blocks)) return this.read(tx, item.id);
      if ((newest?.revision ?? 0) !== input.revision)
        throw new AcademyError(`lesson is at revision ${newest?.revision ?? 0}, not ${input.revision}`, 'academy.revision_stale');
      await this.insert(tx, item.id, input.revision + 1, 'saved', null, null, input.blocks, input.operatorId, input.now);
      return this.read(tx, item.id);
    });
  }

  async revert(input: AcademyRevertLessonInput & { operatorId: string; now: Date }): Promise<AcademyLesson> {
    return this.sql.begin(async (tx) => {
      const item = await this.lockItem(tx, input.itemId);
      const newest = await this.newest(tx, item.id);
      if (
        newest?.revision === input.revision + 1 &&
        newest.source === 'reverted' &&
        newest.from_revision === input.toRevision &&
        newest.actor === input.operatorId
      )
        return this.read(tx, item.id);
      if ((newest?.revision ?? 0) !== input.revision)
        throw new AcademyError(`lesson is at revision ${newest?.revision ?? 0}, not ${input.revision}`, 'academy.revision_stale');
      const [old] = await tx<RevisionRow[]>`
        SELECT * FROM academy.lesson_revisions WHERE item_id = ${item.id} AND revision = ${input.toRevision}
      `;
      if (!old) throw new AcademyError(`the lesson has no revision ${input.toRevision}`, 'academy.lesson_revision_unknown');
      await this.insert(tx, item.id, input.revision + 1, 'reverted', input.toRevision, null, old.blocks, input.operatorId, input.now);
      return this.read(tx, item.id);
    });
  }

  /** Learners see `lessonRevision` from now on. The course revision moves on and a `lesson` event names who and why. */
  async publish(input: AcademyPublishLessonInput & { operatorId: string; now: Date }): Promise<AcademyLesson> {
    return this.sql.begin(async (tx) => {
      const item = await this.lockItem(tx, input.itemId);
      // This item's own publish at the next course revision, by this founder: a repeat after a lost reply.
      if (
        item.course_revision === input.courseRevision + 1 &&
        item.live_revision === input.lessonRevision &&
        item.live_course_revision === item.course_revision
      ) {
        const [own] = await tx<Array<{ kind: string }>>`
          SELECT kind FROM academy.course_events
          WHERE course_id = ${item.course_id} AND revision = ${item.course_revision} AND actor = ${input.operatorId}
        `;
        if (own?.kind === 'lesson') return this.read(tx, item.id);
      }
      if (item.course_revision !== input.courseRevision)
        throw new AcademyError(
          `course is at revision ${item.course_revision}, not ${input.courseRevision}`,
          'academy.course_revision_stale',
        );
      const [exists] = await tx<Array<{ revision: number }>>`
        SELECT revision FROM academy.lesson_revisions WHERE item_id = ${item.id} AND revision = ${input.lessonRevision}
      `;
      if (item.course_state !== 'draft' && item.course_state !== 'published')
        throw new AcademyError(`a ${item.course_state} course's lessons are not published`, 'academy.course_not_editable');
      if (!exists) throw new AcademyError(`the lesson has no revision ${input.lessonRevision}`, 'academy.lesson_revision_unknown');
      const next = await this.courseEvent(tx, item, 'lesson', input.operatorId, input.reason, input.now);
      await tx`
        UPDATE academy.course_items SET live_revision = ${input.lessonRevision}, live_course_revision = ${next} WHERE id = ${item.id}
      `;
      return this.read(tx, item.id);
    });
  }

  /**
   * A copy of the item right after it in its section, while the course is a draft. The copy's lesson starts at revision
   * 1 with the source's newest blocks and is not live; nothing about learners is copied, because nothing about learners
   * is kept on an item. Answers with the copy.
   */
  async duplicate(input: AcademyDuplicateItemInput & { operatorId: string; now: Date }): Promise<AcademyLesson> {
    return this.sql.begin(async (tx) => {
      const item = await this.lockItem(tx, input.itemId, false);
      if (item.course_revision === input.courseRevision + 1) {
        const [copy] = await tx<Array<{ id: string }>>`
          SELECT i.id FROM academy.course_items i
          JOIN academy.course_events e ON e.course_id = i.course_id AND e.revision = i.copied_at_revision
          WHERE i.copied_from = ${item.id} AND i.copied_at_revision = ${item.course_revision}
            AND e.actor = ${input.operatorId} AND e.kind = 'outline'
        `;
        if (copy) return this.read(tx, copy.id);
      }
      if (item.course_revision !== input.courseRevision)
        throw new AcademyError(
          `course is at revision ${item.course_revision}, not ${input.courseRevision}`,
          'academy.course_revision_stale',
        );
      if (item.course_state !== 'draft')
        throw new AcademyError(`a ${item.course_state} course's outline is not edited here`, 'academy.course_not_editable');
      await this.courses.assertRoomForOneMore(tx, item.course_id, item.kind);
      // Positions after the source move one on, through negatives so the per-section order constraint holds.
      await tx`
        UPDATE academy.course_items SET position = -2 - position WHERE section_id = ${item.section_id} AND position > ${item.position}
      `;
      await tx`UPDATE academy.course_items SET position = -1 - position WHERE section_id = ${item.section_id} AND position < 0`;
      const at = await this.courseEvent(tx, item, 'outline', input.operatorId, null, input.now);
      const copyId = randomUUID();
      await tx`
        INSERT INTO academy.course_items (id, course_id, section_id, position, kind, title, indent, url, copied_from, copied_at_revision)
        VALUES (${copyId}, ${item.course_id}, ${item.section_id}, ${item.position + 1}, ${item.kind}, ${item.title}, ${item.indent},
                ${item.url}, ${item.id}, ${at})
      `;
      // An item with no lesson (or a subheader or link) is copied without one.
      const newest = await this.newest(tx, item.id);
      if (newest) await this.insert(tx, copyId, 1, 'duplicated', null, item.id, newest.blocks, input.operatorId, input.now);
      return this.read(tx, copyId);
    });
  }

  async get(itemId: string): Promise<AcademyLesson> {
    return this.read(this.sql, itemId);
  }

  /** The newest revisions, and the live one even when it is older than those, so the editor always shows it. */
  private async read(sql: Sql | TransactionSql, itemId: string): Promise<AcademyLesson> {
    const [[row], revisions] = await Promise.all([
      sql<Array<ItemRow & { course_title: string; lesson_revision: number | null }>>`
        SELECT i.*, c.state AS course_state, c.revision AS course_revision, c.title AS course_title,
          (SELECT max(r.revision) FROM academy.lesson_revisions r WHERE r.item_id = i.id) AS lesson_revision
        FROM academy.course_items i JOIN academy.courses c ON c.id = i.course_id WHERE i.id = ${itemId}
      `,
      sql<RevisionRow[]>`
        (SELECT * FROM academy.lesson_revisions WHERE item_id = ${itemId} ORDER BY revision DESC LIMIT ${REVISIONS_SHOWN})
        UNION
        (SELECT r.* FROM academy.lesson_revisions r JOIN academy.course_items i ON i.id = r.item_id AND i.live_revision = r.revision
          WHERE r.item_id = ${itemId})
        ORDER BY revision DESC
      `,
    ]);
    if (!row) throw new AcademyError('no outline item with that id', 'academy.outline_item_unknown');
    return {
      courseId: row.course_id,
      courseTitle: row.course_title,
      courseState: row.course_state as AcademyLesson['courseState'],
      courseRevision: row.course_revision,
      item: {
        id: row.id,
        kind: row.kind as AcademyLesson['item']['kind'],
        title: row.title,
        indent: row.indent,
        url: row.url,
        lessonRevision: row.lesson_revision,
        liveRevision: row.live_revision,
      },
      revisions: revisions.map((r) => ({
        revision: r.revision,
        source: r.source,
        fromRevision: r.from_revision,
        fromItemId: r.from_item_id,
        blocks: r.blocks,
        actor: r.actor,
        at: r.at.toISOString(),
      })),
    };
  }

  /** The item and its course, the course row locked: every lesson change on a course is one at a time. */
  private async lockItem(tx: TransactionSql, itemId: string, holdsLesson = true): Promise<ItemRow> {
    const [row] = await tx<ItemRow[]>`
      SELECT i.*, c.state AS course_state, c.revision AS course_revision
      FROM academy.course_items i JOIN academy.courses c ON c.id = i.course_id
      WHERE i.id = ${itemId} FOR UPDATE OF c, i
    `;
    if (!row) throw new AcademyError('no outline item with that id', 'academy.outline_item_unknown');
    if (holdsLesson && (ACADEMY_ITEMS_WITHOUT_LESSON as readonly string[]).includes(row.kind))
      throw new AcademyError(`a ${row.kind} holds no lesson`, 'academy.item_has_no_lesson');
    return row;
  }

  private async newest(tx: TransactionSql, itemId: string): Promise<RevisionRow | undefined> {
    const [row] = await tx<RevisionRow[]>`
      SELECT * FROM academy.lesson_revisions WHERE item_id = ${itemId} ORDER BY revision DESC LIMIT 1
    `;
    return row;
  }

  private async insert(
    tx: TransactionSql,
    itemId: string,
    revision: number,
    source: RevisionRow['source'],
    fromRevision: number | null,
    fromItemId: string | null,
    blocks: readonly AcademyLessonBlock[],
    actor: string,
    at: Date,
  ): Promise<void> {
    await tx`
      INSERT INTO academy.lesson_revisions (item_id, revision, source, from_revision, from_item_id, blocks, actor, at)
      VALUES (${itemId}, ${revision}, ${source}, ${fromRevision}, ${fromItemId}, ${tx.json(blocks as never)}, ${actor}, ${at})
    `;
  }

  private async courseEvent(
    tx: TransactionSql,
    item: ItemRow,
    kind: 'lesson' | 'outline',
    actor: string,
    reason: string | null,
    now: Date,
  ): Promise<number> {
    const [next] = await tx<Array<{ revision: number }>>`
      UPDATE academy.courses SET revision = revision + 1, updated_at = ${now} WHERE id = ${item.course_id} RETURNING revision
    `;
    await tx`
      INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at)
      VALUES (${item.course_id}, ${next!.revision}, ${kind}, ${item.course_state}, ${item.course_state}, ${actor}, ${reason}, ${now})
    `;
    return next!.revision;
  }
}
