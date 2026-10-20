/**
 * Durable category choices and their history.
 * SQL matches drizzle/0012_notify_category_prefs.sql.
 */

import type { Sql } from 'postgres';
import type { CategoryPrefStore, SwitchableCategory } from './categories.js';
import type { MuteableChannel } from './mute.js';

type CategoryPg = { category: SwitchableCategory; channel: MuteableChannel; enabled: boolean };

export class PostgresCategoryPrefStore implements CategoryPrefStore {
  constructor(private readonly sql: Sql) {}

  async get(userId: string, category: SwitchableCategory, channel: MuteableChannel): Promise<boolean> {
    const rows = await this.sql<{ enabled: boolean }[]>`
      SELECT enabled FROM notify.category_prefs
       WHERE user_id = ${userId} AND category = ${category} AND channel = ${channel}
    `;
    return rows[0]?.enabled !== false;
  }

  async list(userId: string): Promise<ReadonlyArray<CategoryPg>> {
    return this.sql<CategoryPg[]>`
      SELECT category, channel, enabled FROM notify.category_prefs WHERE user_id = ${userId}
    `;
  }

  async set(userId: string, category: SwitchableCategory, channel: MuteableChannel, enabled: boolean): Promise<{ changed: boolean }> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ enabled: boolean }[]>`
        INSERT INTO notify.category_prefs (user_id, category, channel, enabled)
        VALUES (${userId}, ${category}, ${channel}, ${enabled})
        ON CONFLICT (user_id, category, channel) DO UPDATE
          SET enabled = EXCLUDED.enabled, updated_at = now()
          WHERE notify.category_prefs.enabled IS DISTINCT FROM EXCLUDED.enabled
        RETURNING enabled
      `;
      if (rows.length === 0) return { changed: false };
      await tx`
        INSERT INTO notify.category_pref_history (user_id, category, channel, enabled)
        VALUES (${userId}, ${category}, ${channel}, ${enabled})
      `;
      return { changed: true };
    });
  }
}
