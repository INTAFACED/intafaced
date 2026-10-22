/**
 * Saved activity filters (BK-acct-07, accounts-insights-055).
 *
 * A customer names a set of `activity.list` filters and reuses it. Self-only:
 * the owner is always the signed-in principal. The name is the business key: the
 * same name with the same filter replays; with a different filter it refuses
 * `bank.activity_filter_conflict` (delete it first to change it). The list page
 * size is required; blank is not a default.
 */
import type { Sql } from 'postgres';
import { BankError } from '../errors.js';

export type SavedFilterBody = Record<string, unknown>;

export interface SavedFilter {
  name: string;
  filter: SavedFilterBody;
  createdAt: string;
}

/** Key order and absent keys do not make two filters different. */
export function canonicalFilter(filter: SavedFilterBody): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(filter).sort()) {
    const value = filter[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? [...value].map(String).sort() : value;
  }
  return JSON.stringify(out);
}

export class SavedFilterService {
  constructor(private readonly sql: Sql) {}

  async save(userId: string, name: string, filter: SavedFilterBody): Promise<SavedFilter & { replayed: boolean }> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 60) {
      throw new BankError('A saved filter needs a name of 1 to 60 characters', 'bank.activity_filter_name_invalid');
    }
    if (Object.keys(JSON.parse(canonicalFilter(filter)) as object).length === 0) {
      throw new BankError('A saved filter needs at least one filter', 'bank.activity_filter_empty');
    }
    const body = JSON.parse(canonicalFilter(filter)) as SavedFilterBody;
    const inserted = await this.sql<Array<{ name: string; filter: SavedFilterBody; created_at: Date }>>`
      INSERT INTO bank.activity_saved_filters (user_id, name, filter)
      VALUES (${userId}, ${trimmed}, ${this.sql.json(body as never)})
      ON CONFLICT (user_id, name) DO NOTHING
      RETURNING name, filter, created_at
    `;
    if (inserted[0]) return { ...toSaved(inserted[0]), replayed: false };
    const existing = await this.sql<Array<{ name: string; filter: SavedFilterBody; created_at: Date }>>`
      SELECT name, filter, created_at FROM bank.activity_saved_filters WHERE user_id = ${userId} AND name = ${trimmed}
    `;
    const row = existing[0];
    if (!row || canonicalFilter(row.filter) !== canonicalFilter(body)) {
      throw new BankError('A saved filter with that name already holds a different filter', 'bank.activity_filter_conflict');
    }
    return { ...toSaved(row), replayed: true };
  }

  async list(userId: string, limit: number | undefined): Promise<SavedFilter[]> {
    if (limit === undefined) {
      throw new BankError('Saved filter page size is required; blank is not 50', 'bank.activity_filter_limit_unset');
    }
    const rows = await this.sql<Array<{ name: string; filter: SavedFilterBody; created_at: Date }>>`
      SELECT name, filter, created_at FROM bank.activity_saved_filters
       WHERE user_id = ${userId} ORDER BY name ASC LIMIT ${limit}
    `;
    return rows.map(toSaved);
  }

  /** Deleting a name that is not there answers `deleted: false`; a retry of a delete is not an error. */
  async remove(userId: string, name: string): Promise<{ deleted: boolean }> {
    const rows = await this.sql`
      DELETE FROM bank.activity_saved_filters WHERE user_id = ${userId} AND name = ${name.trim()} RETURNING name
    `;
    return { deleted: rows.length > 0 };
  }
}

function toSaved(row: { name: string; filter: SavedFilterBody; created_at: Date }): SavedFilter {
  return { name: row.name, filter: row.filter, createdAt: row.created_at.toISOString() };
}
