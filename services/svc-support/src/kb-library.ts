/**
 * The help library's categories and sections (SP-kb-01).
 *
 * Created and changed by support staff, never seeded: a fresh desk has none and the reader sees an empty library.
 * Retiring takes a category or section off the reader's list; nothing is deleted, so an article version filed under a
 * retired section keeps its history. Every change writes one log row with the actor and the reason, in the same
 * transaction as the change. Saving the same values again changes nothing and writes nothing.
 */
import type { Sql } from 'postgres';

export type KbCategoryRow = { id: string; name: string; position: number; retired: boolean };
export type KbSectionRow = { id: string; categoryId: string; name: string; position: number; retired: boolean };

export class KbCategoryUnknownError extends Error {
  constructor() {
    super('support.kb_category_unknown');
    this.name = 'KbCategoryUnknownError';
  }
}

export interface KbLibraryChange {
  readonly actorId: string;
  readonly reason: string;
}

export interface KbLibraryBook {
  categories(): Promise<KbCategoryRow[]>;
  sections(): Promise<KbSectionRow[]>;
  section(id: string): Promise<KbSectionRow | null>;
  saveCategory(row: KbCategoryRow, change: KbLibraryChange): Promise<KbCategoryRow>;
  /** Refuses `KbCategoryUnknownError` when the category was never created. */
  saveSection(row: KbSectionRow, change: KbLibraryChange): Promise<KbSectionRow>;
}

const byPosition = <T extends { position: number; name: string; id: string }>(a: T, b: T) =>
  a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

const sameCategory = (a: KbCategoryRow, b: KbCategoryRow) => a.name === b.name && a.position === b.position && a.retired === b.retired;
const sameSection = (a: KbSectionRow, b: KbSectionRow) => sameCategory(a, b) && a.categoryId === b.categoryId;

export class MemoryKbLibraryBook implements KbLibraryBook {
  private readonly cats = new Map<string, KbCategoryRow>();
  private readonly secs = new Map<string, KbSectionRow>();
  readonly log: { kind: 'category' | 'section'; targetId: string; actorId: string; reason: string }[] = [];

  async categories(): Promise<KbCategoryRow[]> {
    return [...this.cats.values()].map((row) => ({ ...row })).sort(byPosition);
  }

  async sections(): Promise<KbSectionRow[]> {
    return [...this.secs.values()].map((row) => ({ ...row })).sort(byPosition);
  }

  async section(id: string): Promise<KbSectionRow | null> {
    const row = this.secs.get(id);
    return row ? { ...row } : null;
  }

  async saveCategory(row: KbCategoryRow, change: KbLibraryChange): Promise<KbCategoryRow> {
    const prior = this.cats.get(row.id);
    if (prior && sameCategory(prior, row)) return { ...prior };
    this.cats.set(row.id, { ...row });
    this.log.push({ kind: 'category', targetId: row.id, ...change });
    return { ...row };
  }

  async saveSection(row: KbSectionRow, change: KbLibraryChange): Promise<KbSectionRow> {
    if (!this.cats.has(row.categoryId)) throw new KbCategoryUnknownError();
    const prior = this.secs.get(row.id);
    if (prior && sameSection(prior, row)) return { ...prior };
    this.secs.set(row.id, { ...row });
    this.log.push({ kind: 'section', targetId: row.id, ...change });
    return { ...row };
  }
}

type PgCategory = { id: string; name: string; position: number; retired: boolean };
type PgSection = PgCategory & { category_id: string };

const categoryOf = (row: PgCategory): KbCategoryRow => ({
  id: row.id,
  name: row.name,
  position: Number(row.position),
  retired: row.retired,
});
const sectionOf = (row: PgSection): KbSectionRow => ({ ...categoryOf(row), categoryId: row.category_id });

export class SqlKbLibraryBook implements KbLibraryBook {
  constructor(private readonly sql: Sql) {}

  async categories(): Promise<KbCategoryRow[]> {
    const rows = await this.sql<PgCategory[]>`SELECT id, name, position, retired FROM support.kb_categories`;
    return rows.map(categoryOf).sort(byPosition);
  }

  async sections(): Promise<KbSectionRow[]> {
    const rows = await this.sql<PgSection[]>`SELECT id, category_id, name, position, retired FROM support.kb_sections`;
    return rows.map(sectionOf).sort(byPosition);
  }

  async section(id: string): Promise<KbSectionRow | null> {
    const [row] = await this.sql<PgSection[]>`SELECT id, category_id, name, position, retired FROM support.kb_sections WHERE id = ${id}`;
    return row ? sectionOf(row) : null;
  }

  async saveCategory(row: KbCategoryRow, change: KbLibraryChange): Promise<KbCategoryRow> {
    return this.sql.begin(async (tx) => {
      const [locked] = await tx<PgCategory[]>`
        SELECT id, name, position, retired FROM support.kb_categories WHERE id = ${row.id} FOR UPDATE
      `;
      const prior = locked ? categoryOf(locked) : null;
      if (prior && sameCategory(prior, row)) return prior;
      await tx`
        INSERT INTO support.kb_categories (id, name, position, retired, updated_by, updated_at)
        VALUES (${row.id}, ${row.name}, ${row.position}, ${row.retired}, ${change.actorId}, now())
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position, retired = EXCLUDED.retired,
          updated_by = EXCLUDED.updated_by, updated_at = now()
      `;
      await tx`
        INSERT INTO support.kb_library_log (kind, target_id, before, after, actor_id, reason)
        VALUES ('category', ${row.id}, ${prior ? tx.json(prior as never) : null}, ${tx.json(row as never)}, ${change.actorId}, ${change.reason})
      `;
      return { ...row };
    }) as Promise<KbCategoryRow>;
  }

  async saveSection(row: KbSectionRow, change: KbLibraryChange): Promise<KbSectionRow> {
    return this.sql.begin(async (tx) => {
      // The category row is share-locked so it cannot be created or changed under the section being filed in it.
      const [category] = await tx<{ id: string }[]>`SELECT id FROM support.kb_categories WHERE id = ${row.categoryId} FOR SHARE`;
      if (!category) throw new KbCategoryUnknownError();
      const [locked] = await tx<PgSection[]>`
        SELECT id, category_id, name, position, retired FROM support.kb_sections WHERE id = ${row.id} FOR UPDATE
      `;
      const prior = locked ? sectionOf(locked) : null;
      if (prior && sameSection(prior, row)) return prior;
      await tx`
        INSERT INTO support.kb_sections (id, category_id, name, position, retired, updated_by, updated_at)
        VALUES (${row.id}, ${row.categoryId}, ${row.name}, ${row.position}, ${row.retired}, ${change.actorId}, now())
        ON CONFLICT (id) DO UPDATE SET category_id = EXCLUDED.category_id, name = EXCLUDED.name, position = EXCLUDED.position,
          retired = EXCLUDED.retired, updated_by = EXCLUDED.updated_by, updated_at = now()
      `;
      await tx`
        INSERT INTO support.kb_library_log (kind, target_id, before, after, actor_id, reason)
        VALUES ('section', ${row.id}, ${prior ? tx.json(prior as never) : null}, ${tx.json(row as never)}, ${change.actorId}, ${change.reason})
      `;
      return { ...row };
    }) as Promise<KbSectionRow>;
  }
}
