import type { Sql } from 'postgres';
import { PREFERENCES_STALE, UNSET_PREFERENCES, type PreferenceValues, type WritablePreferenceLevel } from '@intafaced/contracts';
import { OpsError } from '../codes.js';

/** One level's stored values. Revision 0 with `updatedAt` null: nothing was ever set at this level. */
export interface StoredLevel {
  readonly values: PreferenceValues;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export const NEVER_SET: StoredLevel = { values: UNSET_PREFERENCES, revision: 0, updatedAt: null, updatedBy: null };

/** The subject of a level: '' for the organisation, the founder's user id for a person. */
export type LevelRef = { readonly level: WritablePreferenceLevel; readonly subject: string };

export interface PreferenceStore {
  get(ref: LevelRef): Promise<StoredLevel>;
  /**
   * Replace one level's values from the revision the founder read, and log before and after; returns the level as stored.
   * Another revision refuses `ops.preferences_stale` and changes nothing.
   */
  set(ref: LevelRef, expectedRevision: number, values: PreferenceValues, actorId: string, at: string): Promise<StoredLevel>;
}

const refKey = (ref: LevelRef) => `${ref.level}:${ref.subject}`;

const stale = (found: number, expected: number) =>
  new OpsError(PREFERENCES_STALE, `these preferences are at revision ${found}, not ${expected}: read them again before saving`);

export class MemoryPreferenceStore implements PreferenceStore {
  private readonly rows = new Map<string, StoredLevel>();
  readonly log: { ref: LevelRef; before: PreferenceValues; after: PreferenceValues; actorId: string }[] = [];

  async get(ref: LevelRef): Promise<StoredLevel> {
    return this.rows.get(refKey(ref)) ?? NEVER_SET;
  }

  async set(ref: LevelRef, expectedRevision: number, values: PreferenceValues, actorId: string, at: string): Promise<StoredLevel> {
    const prior = await this.get(ref);
    if (prior.revision !== expectedRevision) throw stale(prior.revision, expectedRevision);
    const next = { values, revision: prior.revision + 1, updatedAt: at, updatedBy: actorId };
    this.rows.set(refKey(ref), next);
    this.log.push({ ref, before: prior.values, after: values, actorId });
    return next;
  }
}

type Row = {
  theme: PreferenceValues['theme'];
  home_page: string | null;
  time_zone: string | null;
  week_start: PreferenceValues['weekStart'];
  revision: number;
  updated_by: string;
  updated_at: Date | string;
};

const fromRow = (r: Row | undefined): StoredLevel =>
  r
    ? {
        values: { theme: r.theme, homePage: r.home_page, timeZone: r.time_zone, weekStart: r.week_start },
        revision: r.revision,
        updatedAt: new Date(r.updated_at).toISOString(),
        updatedBy: r.updated_by,
      }
    : NEVER_SET;

export class SqlPreferenceStore implements PreferenceStore {
  constructor(private readonly sql: Sql) {}

  async get(ref: LevelRef): Promise<StoredLevel> {
    const rows = await this.sql<Row[]>`
      SELECT theme, home_page, time_zone, week_start, revision, updated_by, updated_at FROM ops.console_preferences
      WHERE level = ${ref.level} AND subject = ${ref.subject}
    `;
    return fromRow(rows[0]);
  }

  async set(ref: LevelRef, expectedRevision: number, values: PreferenceValues, actorId: string, at: string): Promise<StoredLevel> {
    return this.sql.begin(async (tx) => {
      // One save per level at a time, the first one too (before the row exists, a row lock would hold nothing).
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.console_preferences:${refKey(ref)}`}))`;
      const prior = fromRow(
        (
          await tx<Row[]>`
            SELECT theme, home_page, time_zone, week_start, revision, updated_by, updated_at FROM ops.console_preferences
            WHERE level = ${ref.level} AND subject = ${ref.subject}
          `
        )[0],
      );
      if (prior.revision !== expectedRevision) throw stale(prior.revision, expectedRevision);
      const rows = await tx<Row[]>`
        INSERT INTO ops.console_preferences (level, subject, theme, home_page, time_zone, week_start, revision, updated_by, updated_at)
        VALUES (${ref.level}, ${ref.subject}, ${values.theme}, ${values.homePage}, ${values.timeZone}, ${values.weekStart},
          ${prior.revision + 1}, ${actorId}, ${at})
        ON CONFLICT (level, subject) DO UPDATE SET theme = EXCLUDED.theme, home_page = EXCLUDED.home_page,
          time_zone = EXCLUDED.time_zone, week_start = EXCLUDED.week_start, revision = EXCLUDED.revision,
          updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
        RETURNING theme, home_page, time_zone, week_start, revision, updated_by, updated_at
      `;
      await tx`
        INSERT INTO ops.console_preference_log (level, subject, before, after, actor_id, logged_at)
        VALUES (${ref.level}, ${ref.subject}, ${tx.json(prior.values)}, ${tx.json(values)}, ${actorId}, ${at})
      `;
      return fromRow(rows[0]);
    }) as Promise<StoredLevel>;
  }
}
