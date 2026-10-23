/**
 * AC-course-structure-01 — course records. Staff create a course on the Academy desk: a title, a slug fixed at creation,
 * a thumbnail and a pricing choice. It is saved as a draft; edits go over the revision the editor read, and every create,
 * edit and move writes an event row with who and why. A paid course may be saved with no price but never published
 * without one, and a course with nothing in its outline is not published either: both refuse by name.
 *
 * Idempotency: create is keyed by the slug (`course:<slug>`): a repeat with the same details answers with the stored
 * course, different details are refused. An edit or move names the revision it was read at, so a repeat after a lost
 * reply finds its own result one revision on and answers with it, and anything else is refused as stale.
 *
 * No money moves: `price` is a catalogue figure for the purchase slice, a decimal string on the wire and never a number.
 */
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyCourse,
  AcademyCourseDetail,
  AcademyCourseList,
  AcademyCourseState,
  AcademyCreateCourseInput,
  AcademyOutlineSection,
  AcademySaveOutlineInput,
  AcademySetCourseStateInput,
  AcademyUpdateCourseInput,
} from '@intafaced/contracts';
import { ACADEMY_COURSE_STATES } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { assertSlugNotReserved } from './reserved-slugs.js';
import { CURRICULUM_PATHS, getCurriculumItem } from './catalog.js';

const EVENTS_SHOWN = 100;

type CourseRow = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  thumbnail_url: string | null;
  pricing: 'free' | 'paid';
  price: string | null;
  price_asset: string | null;
  state: AcademyCourseState;
  revision: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  /** Items a learner can open (subheaders are labels), counted in the same read. */
  items: number;
};

type EventRow = {
  kind: 'created' | 'updated' | 'state' | 'outline';
  revision: number;
  from_state: AcademyCourseState | null;
  to_state: AcademyCourseState;
  actor: string;
  reason: string | null;
  at: Date;
};

type Details = Pick<AcademyCreateCourseInput, 'title' | 'summary' | 'thumbnailUrl' | 'pricing' | 'price' | 'priceAsset'>;

/** `25.50`, `25.500000000000000000` and `25.5` are one price: trailing zeros and a bare point go. */
export function canonicalPrice(price: string | null): string | null {
  if (price === null) return null;
  return price.includes('.') ? price.replace(/0+$/, '').replace(/\.$/, '') : price;
}

function courseOf(row: CourseRow): AcademyCourse {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    thumbnailUrl: row.thumbnail_url,
    pricing: row.pricing,
    price: canonicalPrice(row.price),
    priceAsset: row.price_asset,
    state: row.state,
    revision: row.revision,
    items: row.items,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function sameDetails(row: CourseRow, d: Details): boolean {
  return (
    row.title === d.title &&
    row.summary === d.summary &&
    row.thumbnail_url === d.thumbnailUrl &&
    row.pricing === d.pricing &&
    canonicalPrice(row.price) === canonicalPrice(d.price) &&
    row.price_asset === d.priceAsset
  );
}

/** A course slug is never a reserved tab, a shipped course (a curriculum path) or a lesson's address. */
function assertSlugFree(slug: string): void {
  assertSlugNotReserved(slug);
  if ((CURRICULUM_PATHS as readonly string[]).includes(slug) || getCurriculumItem(slug))
    throw new AcademyError(`slug "${slug}" is already the address of a course or lesson`, 'academy.course_slug_taken');
}

/** The owner's outline limits (`ACADEMY_OUTLINE_MAX_SECTIONS`, `ACADEMY_OUTLINE_MAX_ITEMS`). Null is not set. */
export type OutlineLimits = { maxSections: number | null; maxItems: number | null };

export class CourseRecords {
  constructor(
    private readonly sql: Sql,
    private readonly limits: OutlineLimits = { maxSections: null, maxItems: null },
  ) {}

  async create(input: AcademyCreateCourseInput & { operatorId: string; now: Date }): Promise<AcademyCourse> {
    assertSlugFree(input.slug);
    const price = canonicalPrice(input.price);
    return this.sql.begin(async (tx) => {
      const inserted = await tx<CourseRow[]>`
        INSERT INTO academy.courses
          (slug, title, summary, thumbnail_url, pricing, price, price_asset, state, revision, created_by, created_at, updated_at)
        VALUES (${input.slug}, ${input.title}, ${input.summary}, ${input.thumbnailUrl}, ${input.pricing}, ${price},
                ${input.priceAsset}, 'draft', 1, ${input.operatorId}, ${input.now}, ${input.now})
        ON CONFLICT (slug) DO NOTHING
        RETURNING *, 0 AS items
      `;
      const row = inserted[0];
      if (row) {
        await tx`
          INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at)
          VALUES (${row.id}, 1, 'created', NULL, 'draft', ${input.operatorId}, NULL, ${input.now})
        `;
        return courseOf(row);
      }
      const [existing] = await tx<CourseRow[]>`SELECT *, 0 AS items FROM academy.courses WHERE slug = ${input.slug}`;
      // The same founder's create again (a lost reply) answers with the stored course; anyone else's is a taken slug.
      if (existing && existing.revision === 1 && existing.created_by === input.operatorId && sameDetails(existing, input))
        return courseOf(existing);
      throw new AcademyError(`slug "${input.slug}" is already the address of a course`, 'academy.course_slug_taken');
    });
  }

  async update(input: AcademyUpdateCourseInput & { operatorId: string; now: Date }): Promise<AcademyCourse> {
    const price = canonicalPrice(input.price);
    return this.sql.begin(async (tx) => {
      const row = await this.lock(tx, input.courseId);
      if (row.revision === input.revision + 1 && sameDetails(row, input)) {
        const [own] = await tx<EventRow[]>`
          SELECT kind FROM academy.course_events WHERE course_id = ${row.id} AND revision = ${row.revision} AND actor = ${input.operatorId}
        `;
        if (own?.kind === 'updated') return courseOf(row);
      }
      if (row.revision !== input.revision)
        throw new AcademyError(`course is at revision ${row.revision}, not ${input.revision}`, 'academy.course_revision_stale');
      if (row.state !== 'draft') throw new AcademyError(`a ${row.state} course is not edited here`, 'academy.course_not_editable');
      const [next] = await tx<CourseRow[]>`
        UPDATE academy.courses SET
          title = ${input.title}, summary = ${input.summary}, thumbnail_url = ${input.thumbnailUrl}, pricing = ${input.pricing},
          price = ${price}, price_asset = ${input.priceAsset}, revision = revision + 1, updated_at = ${input.now}
        WHERE id = ${row.id}
        RETURNING *, ${row.items}::int AS items
      `;
      await tx`
        INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at)
        VALUES (${row.id}, ${next!.revision}, 'updated', ${row.state}, ${row.state}, ${input.operatorId}, NULL, ${input.now})
      `;
      return courseOf(next!);
    });
  }

  async setState(input: AcademySetCourseStateInput & { operatorId: string; now: Date }): Promise<AcademyCourse> {
    return this.sql.begin(async (tx) => {
      const row = await this.lock(tx, input.courseId);
      if (row.revision === input.revision + 1 && row.state === input.to) {
        const [own] = await tx<EventRow[]>`
          SELECT kind, to_state FROM academy.course_events
          WHERE course_id = ${row.id} AND revision = ${row.revision} AND actor = ${input.operatorId}
        `;
        if (own?.kind === 'state' && own.to_state === input.to) return courseOf(row);
      }
      if (row.revision !== input.revision)
        throw new AcademyError(`course is at revision ${row.revision}, not ${input.revision}`, 'academy.course_revision_stale');
      if (row.state !== 'draft')
        throw new AcademyError(`a ${row.state} course cannot move to ${input.to}`, 'academy.item_transition_illegal');
      if (row.pricing === 'paid' && row.price === null)
        throw new AcademyError('a paid course has no price, so it is not published', 'academy.price_unset');
      if (row.items === 0)
        throw new AcademyError('the course has nothing in its outline, so it is not published', 'academy.course_outline_empty');
      const [next] = await tx<CourseRow[]>`
        UPDATE academy.courses SET state = ${input.to}, revision = revision + 1, updated_at = ${input.now}
        WHERE id = ${row.id}
        RETURNING *, ${row.items}::int AS items
      `;
      await tx`
        INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at)
        VALUES (${row.id}, ${next!.revision}, 'state', ${row.state}, ${input.to}, ${input.operatorId}, ${input.reason}, ${input.now})
      `;
      return courseOf(next!);
    });
  }

  /**
   * AC-course-structure-02: replace a draft's outline over the revision the editor read. Both owner limits must be set
   * (blank refuses `academy.outline_limits_unset` before anything is read), and the outline must fit inside them.
   */
  async saveOutline(input: AcademySaveOutlineInput & { operatorId: string; now: Date }): Promise<AcademyCourseDetail> {
    const { maxSections, maxItems } = this.limits;
    if (maxSections === null || maxItems === null)
      throw new AcademyError('the owner has not set the outline section and item limits', 'academy.outline_limits_unset');
    // Subheaders are labels, not items a learner opens, so the item limit counts what the desk's item count shows.
    const itemCount = input.sections.reduce((n, s) => n + s.items.filter((i) => i.kind !== 'subheader').length, 0);
    if (input.sections.length > maxSections || itemCount > maxItems)
      throw new AcademyError(
        `${input.sections.length} sections and ${itemCount} items; the limits are ${maxSections} and ${maxItems}`,
        'academy.outline_too_large',
      );
    const wanted = JSON.stringify(input.sections.map((s) => [s.title, s.items.map((i) => [i.kind, i.title, i.indent, i.url])]));
    return this.sql.begin(async (tx) => {
      const row = await this.lock(tx, input.courseId);
      if (row.revision === input.revision + 1) {
        const [own] = await tx<EventRow[]>`
          SELECT kind FROM academy.course_events WHERE course_id = ${row.id} AND revision = ${row.revision} AND actor = ${input.operatorId}
        `;
        if (own?.kind === 'outline') {
          const stored = await this.outline(tx, row.id);
          const have = JSON.stringify(stored.map((s) => [s.title, s.items.map((i) => [i.kind, i.title, i.indent, i.url])]));
          if (have === wanted) return this.get(input.courseId, tx);
        }
      }
      if (row.revision !== input.revision)
        throw new AcademyError(`course is at revision ${row.revision}, not ${input.revision}`, 'academy.course_revision_stale');
      if (row.state !== 'draft') throw new AcademyError(`a ${row.state} course is not edited here`, 'academy.course_not_editable');
      await tx`DELETE FROM academy.course_items WHERE course_id = ${row.id}`;
      await tx`DELETE FROM academy.course_sections WHERE course_id = ${row.id}`;
      if (input.sections.length > 0) {
        const sections = await tx<Array<{ id: string; position: number }>>`
          INSERT INTO academy.course_sections ${tx(input.sections.map((s, position) => ({ course_id: row.id, position, title: s.title })))}
          RETURNING id, position
        `;
        const sectionId = new Map(sections.map((s) => [s.position, s.id]));
        const items = input.sections.flatMap((s, sp) =>
          s.items.map((i, position) => ({
            course_id: row.id,
            section_id: sectionId.get(sp)!,
            position,
            kind: i.kind,
            title: i.title,
            indent: i.indent,
            url: i.url,
          })),
        );
        if (items.length > 0) await tx`INSERT INTO academy.course_items ${tx(items)}`;
      }
      const [next] = await tx<Array<{ revision: number }>>`
        UPDATE academy.courses SET revision = revision + 1, updated_at = ${input.now} WHERE id = ${row.id} RETURNING revision
      `;
      await tx`
        INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at)
        VALUES (${row.id}, ${next!.revision}, 'outline', ${row.state}, ${row.state}, ${input.operatorId}, NULL, ${input.now})
      `;
      // Read inside the transaction, so the reply is the outline this save wrote.
      return this.get(input.courseId, tx);
    });
  }

  private async outline(sql: Sql | TransactionSql, courseId: string): Promise<AcademyOutlineSection[]> {
    const [sections, items] = await Promise.all([
      sql<Array<{ id: string; title: string }>>`
        SELECT id, title FROM academy.course_sections WHERE course_id = ${courseId} ORDER BY position
      `,
      sql<
        Array<{
          id: string;
          section_id: string;
          kind: AcademyOutlineSection['items'][number]['kind'];
          title: string;
          indent: number;
          url: string | null;
        }>
      >`
        SELECT id, section_id, kind, title, indent, url FROM academy.course_items WHERE course_id = ${courseId} ORDER BY position
      `,
    ]);
    return sections.map((s) => ({
      id: s.id,
      title: s.title,
      items: items.filter((i) => i.section_id === s.id).map(({ id, kind, title, indent, url }) => ({ id, kind, title, indent, url })),
    }));
  }

  async get(courseId: string, sql: Sql | TransactionSql = this.sql): Promise<AcademyCourseDetail> {
    const [row] = await sql<
      CourseRow[]
    >`SELECT c.*, (SELECT count(*)::int FROM academy.course_items i WHERE i.course_id = c.id AND i.kind <> 'subheader') AS items FROM academy.courses c WHERE c.id = ${courseId}`;
    if (!row) throw new AcademyError('no course with that id', 'academy.course_not_found');
    const outline = await this.outline(sql, courseId);
    const events = await sql<EventRow[]>`
      SELECT kind, revision, from_state, to_state, actor, reason, at FROM academy.course_events
      WHERE course_id = ${courseId} ORDER BY revision DESC LIMIT ${EVENTS_SHOWN}
    `;
    return {
      course: courseOf(row),
      outline,
      limits: this.limits,
      events: events.map((e) => ({
        kind: e.kind,
        revision: e.revision,
        fromState: e.from_state,
        toState: e.to_state,
        actor: e.actor,
        reason: e.reason,
        at: e.at.toISOString(),
      })),
    };
  }

  /** The page asked for, newest first, and the count in every state. A missing page size refuses; nothing dumps the table. */
  async list(input: { state?: AcademyCourseState; limit?: number }): Promise<AcademyCourseList> {
    if (input.limit === undefined) throw new AcademyError('the course list needs a page size', 'academy.courses_list_limit_unset');
    const [rows, tally] = await Promise.all([
      input.state
        ? this.sql<CourseRow[]>`
            SELECT c.*, (SELECT count(*)::int FROM academy.course_items i WHERE i.course_id = c.id AND i.kind <> 'subheader') AS items FROM academy.courses c WHERE c.state = ${input.state}
            ORDER BY c.created_at DESC, c.id LIMIT ${input.limit}
          `
        : this.sql<
            CourseRow[]
          >`SELECT c.*, (SELECT count(*)::int FROM academy.course_items i WHERE i.course_id = c.id AND i.kind <> 'subheader') AS items FROM academy.courses c ORDER BY c.created_at DESC, c.id LIMIT ${input.limit}`,
      this.sql<Array<{ state: AcademyCourseState; n: number }>>`SELECT state, count(*)::int AS n FROM academy.courses GROUP BY state`,
    ]);
    const counts = Object.fromEntries(ACADEMY_COURSE_STATES.map((s) => [s, 0])) as AcademyCourseList['counts'];
    for (const t of tally) counts[t.state] = t.n;
    return { courses: rows.map(courseOf), counts };
  }

  private async lock(tx: TransactionSql, courseId: string): Promise<CourseRow> {
    const [row] = await tx<
      CourseRow[]
    >`SELECT c.*, (SELECT count(*)::int FROM academy.course_items i WHERE i.course_id = c.id AND i.kind <> 'subheader') AS items FROM academy.courses c WHERE c.id = ${courseId} FOR UPDATE OF c`;
    if (!row) throw new AcademyError('no course with that id', 'academy.course_not_found');
    return row;
  }
}
