/**
 * AC-articles-01 — the hub's featured slot. Staff choose the item with a reason; no row means nothing is featured and
 * the hub says so. Nothing is promoted automatically, and an item that leaves the spine leaves the slot with it. The
 * slot may instead hold a course lesson (learn-hub.ts); the hub's curriculum card reads that as nothing chosen.
 */
import type { Sql } from 'postgres';
import { getCurriculumItem, type CurriculumItemSummary } from './catalog.js';
import { AcademyError } from '../errors.js';
import { requireCurriculumSlug } from '../release/access.js';

/** Staff say why they chose or cleared the slot. Blank after trim is not a reason, and none is invented. */
function requireFeaturedReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new AcademyError('academy.reason_required', 'academy.reason_required');
  return trimmed;
}

export type FeaturedChoice = { itemSlug: string | null; reason: string | null; chosenAt: Date | null };

function summaryOf(slug: string): CurriculumItemSummary | null {
  const item = getCurriculumItem(slug);
  if (!item) return null;
  const { slug: s, title, kind, path, order, summary, estimatedMinutes } = item;
  return { slug: s, title, kind, path, order, summary, estimatedMinutes };
}

export class FeaturedSlot {
  constructor(private readonly sql: Sql) {}

  async featured(): Promise<CurriculumItemSummary | null> {
    const rows = await this.sql<
      { item_slug: string }[]
    >`SELECT item_slug FROM academy.featured_items WHERE slot = 'hub' AND item_slug IS NOT NULL`;
    return rows[0] ? summaryOf(rows[0].item_slug) : null;
  }

  /** `itemSlug: null` clears the slot. A reason is required either way; a blank one is refused, never filled in. */
  async choose(input: { itemSlug: string | null; reason: string; operatorId: string; now?: Date }): Promise<FeaturedChoice> {
    const reason = requireFeaturedReason(input.reason);
    const at = input.now ?? new Date();
    // Every feature and clear is a featured_events row with who and why, the same as learn-hub.ts.
    if (input.itemSlug === null) {
      await this.sql`
        WITH gone AS (DELETE FROM academy.featured_items WHERE slot = 'hub' RETURNING item_slug, course_item_id)
        INSERT INTO academy.featured_events (slot, action, item_slug, course_item_id, reason, actor, at)
        SELECT 'hub', 'cleared', item_slug, course_item_id, ${reason}, ${input.operatorId}, ${at} FROM gone
      `;
      return { itemSlug: null, reason: null, chosenAt: null };
    }
    const itemSlug = requireCurriculumSlug(input.itemSlug);
    const chosenAt = at;
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO academy.featured_items (slot, item_slug, reason, chosen_by, chosen_at)
        VALUES ('hub', ${itemSlug}, ${reason}, ${input.operatorId}, ${chosenAt})
        ON CONFLICT (slot) DO UPDATE SET
          item_slug = EXCLUDED.item_slug,
          course_item_id = NULL,
          reason = EXCLUDED.reason,
          chosen_by = EXCLUDED.chosen_by,
          chosen_at = EXCLUDED.chosen_at
      `;
      await tx`
        INSERT INTO academy.featured_events (slot, action, item_slug, reason, actor, at)
        VALUES ('hub', 'featured', ${itemSlug}, ${reason}, ${input.operatorId}, ${chosenAt})
      `;
    });
    return { itemSlug, reason, chosenAt };
  }
}
