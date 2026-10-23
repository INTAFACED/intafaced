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
  AcademySetCourseStateInput,
  AcademyUpdateCourseInput,
} from '@intafaced/contracts';
import { ACADEMY_COURSE_STATES } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { assertSlugNotReserved } from './reserved-slugs.js';
import { getCurriculumItem, type CurriculumPath } from './catalog.js';

const SHIPPED_COURSES: readonly CurriculumPath[] = ['foundations', 'markets', 'builder', 'sovereign'];
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
};

type EventRow = {
  kind: 'created' | 'updated' | 'state';
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
    // The outline is AC-course-structure-02: until it lands no course has items, which is why none can be published yet.
    items: 0,
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
  if ((SHIPPED_COURSES as readonly string[]).includes(slug) || getCurriculumItem(slug))
    throw new AcademyError(`slug "${slug}" is already the address of a course or lesson`, 'academy.course_slug_taken');
}

export class CourseRecords {
  constructor(private readonly sql: Sql) {}

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
        RETURNING *
      `;
      const row = inserted[0];
      if (row) {
        await tx`
          INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at)
          VALUES (${row.id}, 1, 'created', NULL, 'draft', ${input.operatorId}, NULL, ${input.now})
        `;
        return courseOf(row);
      }
      const [existing] = await tx<CourseRow[]>`SELECT * FROM academy.courses WHERE slug = ${input.slug}`;
      // The same create again (a lost reply) answers with the stored course; the slug with other details is someone else's.
      if (existing && existing.revision === 1 && sameDetails(existing, input)) return courseOf(existing);
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
        RETURNING *
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
      // Every course has an empty outline until AC-course-structure-02 lands; a course with nothing to learn is not published.
      throw new AcademyError('the course has nothing in its outline, so it is not published', 'academy.course_outline_empty');
    });
  }

  async get(courseId: string): Promise<AcademyCourseDetail> {
    const [row] = await this.sql<CourseRow[]>`SELECT * FROM academy.courses WHERE id = ${courseId}`;
    if (!row) throw new AcademyError('no course with that id', 'academy.course_not_found');
    const events = await this.sql<EventRow[]>`
      SELECT kind, revision, from_state, to_state, actor, reason, at FROM academy.course_events
      WHERE course_id = ${courseId} ORDER BY revision DESC LIMIT ${EVENTS_SHOWN}
    `;
    return {
      course: courseOf(row),
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
    const rows = input.state
      ? await this.sql<CourseRow[]>`
          SELECT * FROM academy.courses WHERE state = ${input.state} ORDER BY created_at DESC, id LIMIT ${input.limit}
        `
      : await this.sql<CourseRow[]>`SELECT * FROM academy.courses ORDER BY created_at DESC, id LIMIT ${input.limit}`;
    const tally = await this.sql<Array<{ state: AcademyCourseState; n: number }>>`
      SELECT state, count(*)::int AS n FROM academy.courses GROUP BY state
    `;
    const counts = Object.fromEntries(ACADEMY_COURSE_STATES.map((s) => [s, 0])) as AcademyCourseList['counts'];
    for (const t of tally) counts[t.state] = t.n;
    return { courses: rows.map(courseOf), counts };
  }

  private async lock(tx: TransactionSql, courseId: string): Promise<CourseRow> {
    const [row] = await tx<CourseRow[]>`SELECT * FROM academy.courses WHERE id = ${courseId} FOR UPDATE`;
    if (!row) throw new AcademyError('no course with that id', 'academy.course_not_found');
    return row;
  }
}
