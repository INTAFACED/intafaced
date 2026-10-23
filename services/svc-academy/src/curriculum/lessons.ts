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
  AcademyAssistantDraftInput,
  AcademyDecideDraftInput,
  AcademyDuplicateItemInput,
  AcademyImportLessonInput,
  AcademyImportLessonResult,
  AcademyLesson,
  AcademyLessonBlock,
  AcademyPublishLessonInput,
  AcademyRevertLessonInput,
  AcademySaveLessonInput,
} from '@intafaced/contracts';
import {
  ACADEMY_ITEMS_WITHOUT_LESSON,
  ACADEMY_LESSON_BLOCK_TYPES,
  ACADEMY_LESSON_FORMAT,
  academyLessonBlockSchema,
} from '@intafaced/contracts';
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
  source: 'saved' | 'reverted' | 'duplicated' | 'imported' | 'assisted';
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

type Problem = { block: number | null; problem: string };

type DraftRow = {
  item_id: string;
  based_on_revision: number;
  kind: 'template';
  blocks: AcademyLessonBlock[];
  state: 'open' | 'accepted' | 'discarded';
  created_by: string;
  created_at: Date;
};

/**
 * The template draft: the lesson's place in the course and headings for a person to fill in. It is built only from the
 * course's own structure and states nothing as fact; no provider is involved.
 */
export function templateDraft(input: {
  courseTitle: string;
  sectionTitle: string;
  itemTitle: string;
  neighbours: string[];
}): AcademyLessonBlock[] {
  const blocks: AcademyLessonBlock[] = [
    { type: 'text', markdown: `# ${input.itemTitle}\n\nPart of “${input.sectionTitle}” in “${input.courseTitle}”.` },
    { type: 'text', markdown: '## What you will be able to do\n\n(Write the one thing a learner can do after this lesson.)' },
    { type: 'text', markdown: '## The idea\n\n(Explain the idea in your own words, with one example.)' },
    { type: 'text', markdown: '## Try it\n\n(Write one short practice step.)' },
  ];
  if (input.neighbours.length > 0)
    blocks.push({ type: 'text', markdown: `## In this section\n\n${input.neighbours.map((t) => `- ${t}`).join('\n')}` });
  return blocks;
}

/** The model-backed path waits for the owner to choose a provider: the allowlisted `owner.decision` refusal. */
export class OwnerDecisionError extends Error {
  readonly code = 'owner.decision' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OwnerDecisionError';
  }
}

/**
 * A lesson file, parsed as data only: `{ "format": "intafaced.lesson.v1", "blocks": [...] }`. Every problem is named
 * (an unknown block type, a missing or bad field, an address that is not https), not only the first.
 */
export function checkLessonFile(document: string): { ok: true; blocks: AcademyLessonBlock[] } | { ok: false; problems: Problem[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return { ok: false, problems: [{ block: null, problem: 'the file is not JSON' }] };
  }
  const file = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (!file || file.format !== ACADEMY_LESSON_FORMAT)
    return { ok: false, problems: [{ block: null, problem: `the file is not an ${ACADEMY_LESSON_FORMAT} lesson` }] };
  if (!Array.isArray(file.blocks) || file.blocks.length === 0 || file.blocks.length > 200)
    return { ok: false, problems: [{ block: null, problem: 'a lesson file has 1 to 200 blocks' }] };
  const problems: Problem[] = [];
  const blocks: AcademyLessonBlock[] = [];
  file.blocks.forEach((raw, i) => {
    const type = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).type : undefined;
    if (typeof type !== 'string' || !(ACADEMY_LESSON_BLOCK_TYPES as readonly string[]).includes(type)) {
      problems.push({ block: i + 1, problem: `unknown block type ${JSON.stringify(type ?? null).slice(0, 40)}` });
      return;
    }
    const block = academyLessonBlockSchema.safeParse(raw);
    if (block.success) blocks.push(block.data);
    else
      problems.push({
        block: i + 1,
        problem: `a ${type} block with ${block.error.issues.map((x) => (x.path.length ? x.path.join('.') : x.message)).join(', ')} not valid`,
      });
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, blocks };
}

export class LessonRecords {
  constructor(
    private readonly sql: Sql,
    private readonly courses: CourseRecords,
    /** `ACADEMY_LESSON_IMPORT_MAX_BYTES`; null is not set, and an import refuses. */
    private readonly importMaxBytes: number | null = null,
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

  /**
   * A lesson file as a new revision over the one read. The size is checked before the file is parsed; a file that
   * parses but is not a lesson answers with a report of every problem and creates nothing. Keyed like a save: a repeat of
   * the same file after a lost reply finds its own revision.
   */
  async import(input: AcademyImportLessonInput & { operatorId: string; now: Date }): Promise<AcademyImportLessonResult> {
    if (this.importMaxBytes === null)
      throw new AcademyError('the owner has not set the lesson import size limit', 'academy.import_limit_unset');
    const bytes = Buffer.byteLength(input.document, 'utf8');
    if (bytes > this.importMaxBytes)
      throw new AcademyError(`the file is ${bytes} bytes; the limit is ${this.importMaxBytes}`, 'academy.import_too_large');
    const checked = checkLessonFile(input.document);
    if (!checked.ok) return { outcome: 'invalid', problems: checked.problems, lesson: await this.get(input.itemId) };
    return this.sql.begin(async (tx) => {
      const item = await this.lockItem(tx, input.itemId);
      const newest = await this.newest(tx, item.id);
      if (newest?.revision === input.revision + 1 && newest.source === 'imported' && newest.actor === input.operatorId)
        if (sameBlocks(newest.blocks, checked.blocks)) return { outcome: 'imported' as const, lesson: await this.read(tx, item.id) };
      if ((newest?.revision ?? 0) !== input.revision)
        throw new AcademyError(`lesson is at revision ${newest?.revision ?? 0}, not ${input.revision}`, 'academy.revision_stale');
      await this.insert(tx, item.id, input.revision + 1, 'imported', null, null, checked.blocks, input.operatorId, input.now);
      return { outcome: 'imported' as const, lesson: await this.read(tx, item.id) };
    });
  }

  /**
   * A draft from the template, keyed `draft:<item>:<revision>:template`: a repeat answers with the stored draft. The
   * model path refuses `owner.decision`, since no provider is chosen (the owner setting `assistant_provider` is pending).
   */
  async assistantDraft(input: AcademyAssistantDraftInput & { operatorId: string; now: Date }): Promise<AcademyLesson> {
    if (input.path === 'model')
      throw new OwnerDecisionError('drafting with a model waits for the owner to choose a provider; the template draft works without one');
    return this.sql.begin(async (tx) => {
      const item = await this.lockItem(tx, input.itemId);
      const newest = await this.newest(tx, item.id);
      if ((newest?.revision ?? 0) !== input.revision)
        throw new AcademyError(`lesson is at revision ${newest?.revision ?? 0}, not ${input.revision}`, 'academy.revision_stale');
      const [place] = await tx<Array<{ section_title: string; course_title: string; neighbours: string[] }>>`
        SELECT s.title AS section_title, c.title AS course_title,
          ARRAY(SELECT o.title FROM academy.course_items o WHERE o.section_id = s.id AND o.id <> ${item.id} AND o.kind <> 'subheader'
                ORDER BY o.position) AS neighbours
        FROM academy.course_sections s JOIN academy.courses c ON c.id = s.course_id WHERE s.id = ${item.section_id}
      `;
      const blocks = templateDraft({
        courseTitle: place!.course_title,
        sectionTitle: place!.section_title,
        itemTitle: item.title,
        neighbours: place!.neighbours,
      });
      await tx`
        INSERT INTO academy.lesson_drafts (item_id, based_on_revision, kind, blocks, state, created_by, created_at)
        VALUES (${item.id}, ${input.revision}, 'template', ${tx.json(blocks as never)}, 'open', ${input.operatorId}, ${input.now})
        -- A repeat keeps the open draft; a discarded one is drafted again. An accepted one is past (the revision moved on).
        ON CONFLICT (item_id, based_on_revision, kind) DO UPDATE SET
          blocks = excluded.blocks, state = 'open', created_by = excluded.created_by, created_at = excluded.created_at,
          decided_by = NULL, decided_at = NULL
        WHERE academy.lesson_drafts.state = 'discarded'
      `;
      return this.read(tx, item.id);
    });
  }

  /**
   * A person accepts the open draft (a new lesson revision with them as the actor; learners keep the published one) or
   * discards it. Deciding a draft already decided the same way answers with the lesson; the other way is refused.
   */
  async decideDraft(input: AcademyDecideDraftInput & { operatorId: string; now: Date }): Promise<AcademyLesson> {
    return this.sql.begin(async (tx) => {
      const item = await this.lockItem(tx, input.itemId);
      const [draft] = await tx<DraftRow[]>`
        SELECT * FROM academy.lesson_drafts
        WHERE item_id = ${item.id} AND based_on_revision = ${input.basedOnRevision} AND kind = ${input.kind}
      `;
      if (!draft) throw new AcademyError('no such draft for this lesson', 'academy.draft_not_found');
      const done = input.decision === 'accept' ? 'accepted' : 'discarded';
      if (draft.state === done) return this.read(tx, item.id);
      if (draft.state !== 'open') throw new AcademyError(`the draft was already ${draft.state}`, 'academy.draft_not_found');
      let accepted: number | null = null;
      if (input.decision === 'accept') {
        const newest = await this.newest(tx, item.id);
        if ((newest?.revision ?? 0) !== draft.based_on_revision)
          throw new AcademyError(
            `the lesson moved on to revision ${newest?.revision ?? 0} since the draft was made`,
            'academy.revision_stale',
          );
        accepted = draft.based_on_revision + 1;
        await this.insert(tx, item.id, accepted, 'assisted', null, null, draft.blocks, input.operatorId, input.now);
      }
      await tx`
        UPDATE academy.lesson_drafts SET state = ${done}, decided_by = ${input.operatorId}, decided_at = ${input.now},
          accepted_revision = ${accepted}
        WHERE item_id = ${item.id} AND based_on_revision = ${input.basedOnRevision} AND kind = ${input.kind}
      `;
      return this.read(tx, item.id);
    });
  }

  async get(itemId: string): Promise<AcademyLesson> {
    return this.read(this.sql, itemId);
  }

  /** The newest revisions, and the live one even when it is older than those, so the editor always shows it. */
  private async read(sql: Sql | TransactionSql, itemId: string): Promise<AcademyLesson> {
    const [[row], revisions, [draft]] = await Promise.all([
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
      sql<DraftRow[]>`
        -- Only a draft of the newest revision can still be accepted; an older open draft is not offered.
        SELECT * FROM academy.lesson_drafts d WHERE d.item_id = ${itemId} AND d.state = 'open'
          AND d.based_on_revision = COALESCE((SELECT max(r.revision) FROM academy.lesson_revisions r WHERE r.item_id = d.item_id), 0)
        ORDER BY d.created_at DESC LIMIT 1
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
      importMaxBytes: this.importMaxBytes,
      draft: draft
        ? {
            basedOnRevision: draft.based_on_revision,
            kind: draft.kind,
            blocks: draft.blocks,
            createdBy: draft.created_by,
            createdAt: draft.created_at.toISOString(),
          }
        : null,
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
