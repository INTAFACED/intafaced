/**
 * AC-course-structure-01 — course records and lifecycle store.
 *
 * Create is keyed by `course:<slug>`: a repeat with the same slug returns the
 * stored row. A move is keyed `state:<courseId>:<to>:<revision>`: a repeat
 * returns the stored result and never moves twice. Every move writes an event
 * row with actor and reason. Deleting is a state, never a row delete, and no
 * grant, purchase, completion, attempt or certificate row is touched.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { AcademyError } from '../errors.js';
import { assertCourseSlug, decideMove, parseCoursePrice, type CourseState, type LifecycleMove, type PriceChoice } from './lifecycle.js';

export const COURSE_SETTING_KEYS = ['undelete_window_seconds'] as const;
export type CourseSettingKey = (typeof COURSE_SETTING_KEYS)[number];

export interface CourseRecord {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  thumbnailUrl: string | null;
  priceChoice: PriceChoice;
  /** Decimal string, or null when not set. */
  price: string | null;
  state: CourseState;
  listed: boolean;
  revision: number;
  deletedAt: Date | null;
}

type CourseSql = {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  thumbnail_url: string | null;
  price_choice: PriceChoice;
  price: string | null;
  state: CourseState;
  state_before_delete: CourseState | null;
  listed: boolean;
  revision: number;
  deleted_at: Date | null;
};

export interface CreateCourseInput {
  slug: string;
  title: string;
  category?: string | null;
  thumbnailUrl?: string | null;
  priceChoice: PriceChoice;
  price?: string | null;
  actor: string;
}

export interface MoveInput {
  courseId: string;
  move: LifecycleMove;
  /** The revision the operator saw. Part of the business key. */
  revision: number;
  actor: string;
  reason: string;
}

function toRecord(r: CourseSql): CourseRecord {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    category: r.category,
    thumbnailUrl: r.thumbnail_url,
    priceChoice: r.price_choice,
    price: r.price === null ? null : formatAmount(parseAmount(r.price)),
    state: r.state,
    listed: r.listed,
    revision: r.revision,
    deletedAt: r.deleted_at,
  };
}

const TARGET: Readonly<Record<LifecycleMove, string>> = {
  publish: 'published',
  conclude: 'concluded',
  archive: 'archived',
  delete: 'deleted',
  undelete: 'undeleted',
};

export class AcademyCourseStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateCourseInput): Promise<CourseRecord> {
    assertCourseSlug(input.slug);
    const title = input.title.trim();
    if (title === '') throw new AcademyError('title is required', 'academy.course_invalid');
    const price = parseCoursePrice(input.priceChoice, input.price);
    return transaction(this.sql, async (tx) => {
      const inserted = await tx<CourseSql[]>`
        INSERT INTO academy.courses (slug, title, category, thumbnail_url, price_choice, price, created_by)
        VALUES (${input.slug}, ${title}, ${input.category ?? null}, ${input.thumbnailUrl ?? null},
                ${input.priceChoice}, ${price === null ? null : formatAmount(price)}, ${input.actor})
        ON CONFLICT (slug) DO NOTHING
        RETURNING *`;
      const row = inserted[0];
      if (row) {
        await tx`
          INSERT INTO academy.course_events (idempotency_key, course_id, from_state, to_state, revision, actor, reason)
          VALUES (${`course:${input.slug}`}, ${row.id}, ${null}, 'draft', 0, ${input.actor}, 'create')`;
        return toRecord(row);
      }
      const existing = await tx<CourseSql[]>`SELECT * FROM academy.courses WHERE slug = ${input.slug}`;
      return toRecord(existing[0] as CourseSql);
    });
  }

  async get(courseId: string): Promise<CourseRecord> {
    const rows = await this.sql<CourseSql[]>`SELECT * FROM academy.courses WHERE id = ${courseId}`;
    if (!rows[0]) throw new AcademyError('course not found', 'academy.course_not_found');
    return toRecord(rows[0]);
  }

  async setPrice(courseId: string, price: string, actor: string, reason: string): Promise<CourseRecord> {
    assertReason(reason);
    return transaction(this.sql, async (tx) => {
      const rows = await tx<CourseSql[]>`SELECT * FROM academy.courses WHERE id = ${courseId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new AcademyError('course not found', 'academy.course_not_found');
      if (row.state !== 'draft') {
        throw new AcademyError('price is fixed once a course is published', 'academy.item_transition_illegal');
      }
      const amount = parseCoursePrice(row.price_choice, price);
      if (amount === null) throw new AcademyError('price is required', 'academy.course_invalid');
      const updated = await tx<CourseSql[]>`
        UPDATE academy.courses SET price = ${formatAmount(amount)} WHERE id = ${courseId} RETURNING *`;
      return toRecord(updated[0] as CourseSql);
    });
  }

  async setSetting(key: CourseSettingKey, value: string, actor: string): Promise<void> {
    if (!/^[1-9][0-9]{0,9}$/.test(value)) {
      throw new AcademyError(`${key} must be a positive whole number`, 'academy.course_invalid');
    }
    await this.sql`
      INSERT INTO academy.course_settings (key, value, set_by) VALUES (${key}, ${value}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_at = now()`;
  }

  async settings(): Promise<Array<{ key: CourseSettingKey; state: 'set' | 'not_set'; value: string | null }>> {
    const rows = await this.sql<Array<{ key: string; value: string }>>`SELECT key, value FROM academy.course_settings`;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return COURSE_SETTING_KEYS.map((key) => {
      const value = map.get(key) ?? null;
      return { key, state: value === null ? ('not_set' as const) : ('set' as const), value };
    });
  }

  async move(input: MoveInput): Promise<CourseRecord> {
    assertReason(input.reason);
    const key = `state:${input.courseId}:${TARGET[input.move]}:${input.revision}`;
    return transaction(this.sql, async (tx) => {
      const rows = await tx<CourseSql[]>`SELECT * FROM academy.courses WHERE id = ${input.courseId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new AcademyError('course not found', 'academy.course_not_found');
      const done = await tx<Array<{ idempotency_key: string }>>`
        SELECT idempotency_key FROM academy.course_events WHERE idempotency_key = ${key}`;
      if (done[0]) return toRecord(row);
      if (row.revision !== input.revision) {
        throw new AcademyError('course changed since it was read; re-read it', 'academy.item_transition_illegal');
      }
      const setting = await tx<Array<{ value: string }>>`
        SELECT value FROM academy.course_settings WHERE key = 'undelete_window_seconds'`;
      const to = decideMove(
        {
          state: row.state,
          stateBeforeDelete: row.state_before_delete,
          priceChoice: row.price_choice,
          price: row.price === null ? null : 1n,
          deletedAt: row.deleted_at,
        },
        input.move,
        { undeleteWindowSeconds: setting[0] ? Number(setting[0].value) : null, now: this.now() },
      );
      const deleting = input.move === 'delete';
      const updated = await tx<CourseSql[]>`
        UPDATE academy.courses SET
          state = ${to},
          state_before_delete = ${deleting ? row.state : null},
          deleted_at = ${deleting ? this.now() : null},
          listed = ${to === 'published'},
          revision = revision + 1
        WHERE id = ${input.courseId}
        RETURNING *`;
      await tx`
        INSERT INTO academy.course_events (idempotency_key, course_id, from_state, to_state, revision, actor, reason)
        VALUES (${key}, ${input.courseId}, ${row.state}, ${to}, ${input.revision + 1}, ${input.actor}, ${input.reason.trim()})`;
      return toRecord(updated[0] as CourseSql);
    });
  }

  async events(courseId: string, limit: number) {
    return this.sql<Array<{ from_state: string | null; to_state: string; revision: number; actor: string; reason: string; at: Date }>>`
      SELECT from_state, to_state, revision, actor, reason, at FROM academy.course_events
      WHERE course_id = ${courseId} ORDER BY at, revision LIMIT ${limit}`;
  }
}

function assertReason(reason: string): void {
  if (reason.trim() === '') throw new AcademyError('a reason is required', 'academy.course_invalid');
}
