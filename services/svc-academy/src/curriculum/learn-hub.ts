/**
 * AC-articles-01 — the Learn hub's featured article and its topics, as staff set them on the founder console.
 *
 * The hub has one featured slot. Staff fill it with a course lesson learners can read (one with a revision published to
 * them, in a draft or published course; otherwise `academy.featured_not_live`), or with a curriculum item
 * (featured.ts); either replaces the other. Withdrawing the lesson from learners empties the slot in the same step
 * (lessons.ts), and deleting the item does too (the row cascades). Every feature and clear is a `featured_events` row
 * with who and why. Nothing is ever promoted into the slot automatically. Topics are names
 * staff own, with an address that is never an Academy tab (`academy.slug_reserved`); the list is read up to the owner's
 * limit (`ACADEMY_TOPICS_LIST_LIMIT`; blank refuses `academy.topics_list_limit_unset`). No money moves here.
 */
import type { Sql } from 'postgres';
import type {
  AcademyCourseState,
  AcademyCreateTopicInput,
  AcademyFeaturedSlot,
  AcademyPublicHubLesson,
  AcademyTopic,
  AcademyTopicList,
} from '@intafaced/contracts';
import { ACADEMY_ITEMS_WITHOUT_LESSON } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { assertSlugNotReserved } from './reserved-slugs.js';
import { getCurriculumItem } from './catalog.js';

type TopicRow = { id: string; slug: string; name: string; created_at: Date };
const topicOf = (t: TopicRow): AcademyTopic => ({ id: t.id, slug: t.slug, name: t.name, createdAt: t.created_at.toISOString() });

export class LearnHub {
  constructor(
    private readonly sql: Sql,
    /** `ACADEMY_TOPICS_LIST_LIMIT`; null is not set, and the topic list refuses. */
    private readonly topicsLimit: number | null = null,
  ) {}

  /**
   * The featured slot as staff left it: a curriculum item, a course lesson that is live in a draft or published course,
   * or nothing.
   */
  async featuredSlot(): Promise<AcademyFeaturedSlot> {
    const [row] = await this.sql<
      Array<{
        item_slug: string | null;
        item_id: string | null;
        title: string | null;
        course_id: string | null;
        course_title: string | null;
        course_state: AcademyCourseState | null;
        live_revision: number | null;
        reason: string;
        chosen_by: string;
        chosen_at: Date;
      }>
    >`
      SELECT f.item_slug, i.id AS item_id, i.title, c.id AS course_id, c.title AS course_title, c.state AS course_state,
        i.live_revision, f.reason, f.chosen_by, f.chosen_at
      FROM academy.featured_items f
      LEFT JOIN academy.course_items i ON i.id = f.course_item_id
      LEFT JOIN academy.courses c ON c.id = i.course_id
      WHERE f.slot = 'hub'
    `;
    const curriculum = row?.item_slug ? getCurriculumItem(row.item_slug) : undefined;
    const lessonShown = row?.item_id && row.live_revision !== null && (row.course_state === 'draft' || row.course_state === 'published');
    if (!row || (!curriculum && !lessonShown)) return { curriculum: null, lesson: null, reason: null, chosenBy: null, chosenAt: null };
    return {
      curriculum: curriculum ? { slug: curriculum.slug, title: curriculum.title } : null,
      lesson: lessonShown
        ? {
            itemId: row.item_id!,
            title: row.title!,
            courseId: row.course_id!,
            courseTitle: row.course_title!,
            courseState: row.course_state!,
            liveRevision: row.live_revision!,
          }
        : null,
      reason: row.reason,
      chosenBy: row.chosen_by,
      chosenAt: row.chosen_at.toISOString(),
    };
  }

  /**
   * The featured lesson as a visitor sees it: its title and its course's, and the course's address only while the course is
   * published. Shown while the lesson is live in a draft or published course, the same rule as the founder console's slot.
   */
  async publicLesson(): Promise<AcademyPublicHubLesson | null> {
    const [row] = await this.sql<Array<{ title: string; course_title: string; course_slug: string; course_state: AcademyCourseState }>>`
      SELECT i.title, c.title AS course_title, c.slug AS course_slug, c.state AS course_state
      FROM academy.featured_items f
      JOIN academy.course_items i ON i.id = f.course_item_id
      JOIN academy.courses c ON c.id = i.course_id
      WHERE f.slot = 'hub' AND i.live_revision IS NOT NULL AND c.state IN ('draft', 'published')
    `;
    if (!row) return null;
    return { title: row.title, courseTitle: row.course_title, courseSlug: row.course_state === 'published' ? row.course_slug : null };
  }

  /**
   * This lesson fills the slot, replacing whatever was there (a curriculum item too: the hub has one slot). Only a lesson
   * live to learners in a draft or published course is featured.
   */
  async featureLesson(input: { itemId: string; reason: string; operatorId: string; now: Date }): Promise<AcademyFeaturedSlot> {
    const reason = input.reason.trim();
    await this.sql.begin(async (tx) => {
      const [item] = await tx<Array<{ kind: string; live_revision: number | null; course_state: string }>>`
        SELECT i.kind, i.live_revision, c.state AS course_state
        FROM academy.course_items i JOIN academy.courses c ON c.id = i.course_id
        WHERE i.id = ${input.itemId} FOR SHARE OF i, c
      `;
      if (!item) throw new AcademyError('no outline item with that id', 'academy.outline_item_unknown');
      if ((ACADEMY_ITEMS_WITHOUT_LESSON as readonly string[]).includes(item.kind))
        throw new AcademyError(`a ${item.kind} holds no lesson`, 'academy.item_has_no_lesson');
      if (item.course_state !== 'draft' && item.course_state !== 'published')
        throw new AcademyError(`a ${item.course_state} course's lessons are not featured`, 'academy.course_not_editable');
      // The item row is held (FOR SHARE), so a withdrawal waits for this feature and then empties the slot.
      if (item.live_revision === null)
        throw new AcademyError('learners see no revision of this lesson, so it is not featured', 'academy.featured_not_live');
      await tx`
        INSERT INTO academy.featured_items (slot, item_slug, course_item_id, reason, chosen_by, chosen_at)
        VALUES ('hub', NULL, ${input.itemId}, ${reason}, ${input.operatorId}, ${input.now})
        ON CONFLICT (slot) DO UPDATE SET
          item_slug = NULL, course_item_id = EXCLUDED.course_item_id, reason = EXCLUDED.reason,
          chosen_by = EXCLUDED.chosen_by, chosen_at = EXCLUDED.chosen_at
      `;
      await tx`
        INSERT INTO academy.featured_events (slot, action, course_item_id, reason, actor, at)
        VALUES ('hub', 'featured', ${input.itemId}, ${reason}, ${input.operatorId}, ${input.now})
      `;
    });
    return this.featuredSlot();
  }

  /** Nothing is featured, whichever kind was there; the clear is recorded with who and why. An empty slot answers the same. */
  async clearFeatured(input: { reason: string; operatorId: string; now: Date }): Promise<AcademyFeaturedSlot> {
    await this.sql`
      WITH gone AS (DELETE FROM academy.featured_items WHERE slot = 'hub' RETURNING item_slug, course_item_id)
      INSERT INTO academy.featured_events (slot, action, item_slug, course_item_id, reason, actor, at)
      SELECT 'hub', 'cleared', item_slug, course_item_id, ${input.reason.trim()}, ${input.operatorId}, ${input.now} FROM gone
    `;
    return this.featuredSlot();
  }

  /** The topics, newest first, up to the owner's limit. */
  async topics(): Promise<AcademyTopicList> {
    if (this.topicsLimit === null)
      throw new AcademyError('the owner has not set how many topics a list shows', 'academy.topics_list_limit_unset');
    const rows = await this.sql<TopicRow[]>`
      SELECT id, slug, name, created_at FROM academy.topics ORDER BY created_at DESC, slug LIMIT ${this.topicsLimit}
    `;
    return { topics: rows.map(topicOf), limit: this.topicsLimit };
  }

  /** A topic keyed by its address. A repeat with the same name answers with it; another name is refused. */
  async createTopic(input: AcademyCreateTopicInput & { operatorId: string; now: Date }): Promise<AcademyTopic> {
    assertSlugNotReserved(input.slug);
    const name = input.name.trim();
    const [created] = await this.sql<TopicRow[]>`
      INSERT INTO academy.topics (slug, name, created_by, created_at)
      VALUES (${input.slug}, ${name}, ${input.operatorId}, ${input.now})
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, slug, name, created_at
    `;
    if (created) return topicOf(created);
    const [held] = await this.sql<TopicRow[]>`SELECT id, slug, name, created_at FROM academy.topics WHERE slug = ${input.slug}`;
    if (held && held.name === name) return topicOf(held);
    throw new AcademyError(`a topic already has the address "${input.slug}"`, 'academy.topic_slug_taken');
  }
}
