/**
 * Help-centre authoring (SP-kb-01): categories, sections, drafts and keyed publish of desk-written articles.
 *
 * Separate from the keyed spine (`kb-catalog.ts`, `kb_articles`), which is unchanged: the five spine articles keep
 * their i18n keys and every existing read. A desk-written article is a draft until published; each publish writes one
 * immutable version keyed (article, revision), so a replay returns the same version and never writes a second one.
 */
import type { Sql } from 'postgres';
import {
  supportKbPublishKey,
  type SaveKbDraftInput,
  type SupportKbAuthoredArticle,
  type SupportKbCategories,
  type SupportKbCategory,
  type SupportKbDraft,
  type SupportKbSection,
} from '@intafaced/contracts';

export type KbAuthoringErrorCode =
  | 'support.kb_section_unknown'
  | 'support.kb_category_unknown'
  | 'support.kb.revision_stale'
  | 'support.kb_draft_missing'
  | 'support.kb_id_taken'
  | 'support.kb_draft_stale';

export class KbAuthoringError extends Error {
  constructor(readonly code: KbAuthoringErrorCode) {
    super(code);
    this.name = 'KbAuthoringError';
  }
}

export interface KbAuthoringBook {
  categories(): Promise<SupportKbCategories>;
  createCategory(input: SupportKbCategory, by: string, at: string): Promise<SupportKbCategory>;
  createSection(input: SupportKbSection, by: string, at: string): Promise<SupportKbSection>;
  saveDraft(input: SaveKbDraftInput, by: string, at: string): Promise<SupportKbDraft>;
  getDraft(articleId: string): Promise<SupportKbDraft | null>;
  /** Publishes the article's draft from `revision`. Same key again returns the same version. */
  publish(articleId: string, revision: number, by: string, at: string): Promise<SupportKbAuthoredArticle>;
  /** Newest version of every article, newest publish first. */
  /** `language` keeps only versions in that language; omitted returns every language. */
  listPublished(limit: number, language?: string): Promise<SupportKbAuthoredArticle[]>;
  getPublished(articleId: string): Promise<SupportKbAuthoredArticle | null>;
  versions(articleId: string): Promise<SupportKbAuthoredArticle[]>;
}

const byPosition = <T extends { position: number; name: string }>(a: T, b: T) => a.position - b.position || a.name.localeCompare(b.name);
const sameCategory = (a: SupportKbCategory, b: SupportKbCategory) =>
  a.name === b.name && a.position === b.position && a.parentId === b.parentId;
const sameSection = (a: SupportKbSection, b: SupportKbSection) =>
  a.name === b.name && a.position === b.position && a.categoryId === b.categoryId;

type Stored = SupportKbAuthoredArticle & { publishKey: string };
const strip = ({ publishKey: _k, ...v }: Stored): SupportKbAuthoredArticle => v;

export class MemoryKbAuthoringBook implements KbAuthoringBook {
  private readonly cats = new Map<string, SupportKbCategory>();
  private readonly secs = new Map<string, SupportKbSection>();
  private readonly drafts = new Map<string, SupportKbDraft>();
  private readonly heads = new Map<string, number>();
  private readonly rows: Stored[] = [];

  async categories(): Promise<SupportKbCategories> {
    return { categories: [...this.cats.values()].sort(byPosition), sections: [...this.secs.values()].sort(byPosition) };
  }

  async createCategory(input: SupportKbCategory): Promise<SupportKbCategory> {
    const prior = this.cats.get(input.id);
    if (prior) {
      if (sameCategory(prior, input)) return prior;
      throw new KbAuthoringError('support.kb_id_taken');
    }
    if (input.parentId !== null && !this.cats.has(input.parentId)) throw new KbAuthoringError('support.kb_category_unknown');
    this.cats.set(input.id, { ...input });
    return { ...input };
  }

  async createSection(input: SupportKbSection): Promise<SupportKbSection> {
    const prior = this.secs.get(input.id);
    if (prior) {
      if (sameSection(prior, input)) return prior;
      throw new KbAuthoringError('support.kb_id_taken');
    }
    if (!this.cats.has(input.categoryId)) throw new KbAuthoringError('support.kb_category_unknown');
    this.secs.set(input.id, { ...input });
    return { ...input };
  }

  async saveDraft(input: SaveKbDraftInput, by: string, at: string): Promise<SupportKbDraft> {
    if (input.sectionId !== null && !this.secs.has(input.sectionId)) throw new KbAuthoringError('support.kb_section_unknown');
    const prior = this.drafts.get(input.articleId);
    if ((prior?.draftRevision ?? 0) !== input.expectedDraftRevision) throw new KbAuthoringError('support.kb_draft_stale');
    const { expectedDraftRevision, ...fields } = input;
    const draft: SupportKbDraft = { ...fields, draftRevision: expectedDraftRevision + 1, savedBy: by, savedAt: at };
    this.drafts.set(input.articleId, draft);
    return draft;
  }

  async getDraft(articleId: string): Promise<SupportKbDraft | null> {
    return this.drafts.get(articleId) ?? null;
  }

  async publish(articleId: string, revision: number, by: string, at: string): Promise<SupportKbAuthoredArticle> {
    const key = supportKbPublishKey(articleId, revision);
    const replay = this.rows.find((r) => r.publishKey === key);
    if (replay) return strip(replay);
    if ((this.heads.get(articleId) ?? 0) !== revision) throw new KbAuthoringError('support.kb.revision_stale');
    const draft = this.drafts.get(articleId);
    if (!draft) throw new KbAuthoringError('support.kb_draft_missing');
    const row: Stored = {
      articleId,
      version: revision + 1,
      language: draft.language,
      title: draft.title,
      body: draft.body,
      sectionId: draft.sectionId,
      publishedAt: at,
      publishKey: key,
    };
    void by;
    this.rows.push(row);
    this.heads.set(articleId, revision + 1);
    this.drafts.delete(articleId);
    return strip(row);
  }

  async listPublished(limit: number, language?: string): Promise<SupportKbAuthoredArticle[]> {
    const newest = [...this.heads.entries()].map(([id, v]) => this.rows.find((r) => r.articleId === id && r.version === v)!);
    return newest
      .filter((r) => language === undefined || r.language === language)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.articleId.localeCompare(b.articleId))
      .slice(0, limit)
      .map(strip);
  }

  async getPublished(articleId: string): Promise<SupportKbAuthoredArticle | null> {
    const v = this.heads.get(articleId);
    const row = v === undefined ? undefined : this.rows.find((r) => r.articleId === articleId && r.version === v);
    return row ? strip(row) : null;
  }

  async versions(articleId: string): Promise<SupportKbAuthoredArticle[]> {
    return this.rows.filter((r) => r.articleId === articleId).map(strip);
  }
}

type VersionRow = {
  article_id: string;
  version: number;
  language: string;
  title: string;
  body: string;
  section_id: string | null;
  published_at: Date | string;
};
const fromVersion = (r: VersionRow): SupportKbAuthoredArticle => ({
  articleId: r.article_id,
  version: r.version,
  language: r.language,
  title: r.title,
  body: r.body,
  sectionId: r.section_id,
  publishedAt: new Date(r.published_at).toISOString(),
});
type DraftRow = {
  article_id: string;
  language: string;
  title: string;
  body: string;
  section_id: string | null;
  draft_revision: number;
  saved_by: string;
  saved_at: Date | string;
};
const fromDraft = (r: DraftRow): SupportKbDraft => ({
  articleId: r.article_id,
  language: r.language,
  title: r.title,
  body: r.body,
  sectionId: r.section_id,
  draftRevision: r.draft_revision,
  savedBy: r.saved_by,
  savedAt: new Date(r.saved_at).toISOString(),
});

const isFkViolation = (err: unknown): boolean => (err as { code?: string } | null)?.code === '23503';

export class SqlKbAuthoringBook implements KbAuthoringBook {
  constructor(private readonly sql: Sql) {}

  async categories(): Promise<SupportKbCategories> {
    const cats = await this.sql<{ id: string; name: string; position: number; parent_id: string | null }[]>`
      SELECT id, name, position, parent_id FROM support.kb_categories ORDER BY position, name`;
    const secs = await this.sql<{ id: string; category_id: string; name: string; position: number }[]>`
      SELECT id, category_id, name, position FROM support.kb_sections ORDER BY position, name`;
    return {
      categories: cats.map((c) => ({ id: c.id, name: c.name, position: c.position, parentId: c.parent_id })),
      sections: secs.map((s) => ({ id: s.id, categoryId: s.category_id, name: s.name, position: s.position })),
    };
  }

  async createCategory(input: SupportKbCategory, by: string, at: string): Promise<SupportKbCategory> {
    try {
      await this.sql`
        INSERT INTO support.kb_categories (id, name, position, parent_id, created_by, created_at)
        VALUES (${input.id}, ${input.name}, ${input.position}, ${input.parentId}, ${by}, ${at})
        ON CONFLICT (id) DO NOTHING`;
    } catch (err) {
      if (isFkViolation(err)) throw new KbAuthoringError('support.kb_category_unknown');
      throw err;
    }
    const [row] = await this.sql<{ id: string; name: string; position: number; parent_id: string | null }[]>`
      SELECT id, name, position, parent_id FROM support.kb_categories WHERE id = ${input.id}`;
    const stored = { id: row!.id, name: row!.name, position: row!.position, parentId: row!.parent_id };
    if (!sameCategory(stored, input)) throw new KbAuthoringError('support.kb_id_taken');
    return stored;
  }

  async createSection(input: SupportKbSection, by: string, at: string): Promise<SupportKbSection> {
    try {
      await this.sql`
        INSERT INTO support.kb_sections (id, category_id, name, position, created_by, created_at)
        VALUES (${input.id}, ${input.categoryId}, ${input.name}, ${input.position}, ${by}, ${at})
        ON CONFLICT (id) DO NOTHING`;
    } catch (err) {
      if (isFkViolation(err)) throw new KbAuthoringError('support.kb_category_unknown');
      throw err;
    }
    const [row] = await this.sql<{ id: string; category_id: string; name: string; position: number }[]>`
      SELECT id, category_id, name, position FROM support.kb_sections WHERE id = ${input.id}`;
    const stored = { id: row!.id, categoryId: row!.category_id, name: row!.name, position: row!.position };
    if (!sameSection(stored, input)) throw new KbAuthoringError('support.kb_id_taken');
    return stored;
  }

  async saveDraft(input: SaveKbDraftInput, by: string, at: string): Promise<SupportKbDraft> {
    try {
      const rows =
        input.expectedDraftRevision === 0
          ? await this.sql<DraftRow[]>`
              INSERT INTO support.kb_drafts (article_id, language, title, body, section_id, draft_revision, saved_by, saved_at)
              VALUES (${input.articleId}, ${input.language}, ${input.title}, ${input.body}, ${input.sectionId}, 1, ${by}, ${at})
              ON CONFLICT (article_id) DO NOTHING
              RETURNING article_id, language, title, body, section_id, draft_revision, saved_by, saved_at`
          : await this.sql<DraftRow[]>`
              UPDATE support.kb_drafts
              SET language = ${input.language}, title = ${input.title}, body = ${input.body}, section_id = ${input.sectionId},
                  draft_revision = draft_revision + 1, saved_by = ${by}, saved_at = ${at}
              WHERE article_id = ${input.articleId} AND draft_revision = ${input.expectedDraftRevision}
              RETURNING article_id, language, title, body, section_id, draft_revision, saved_by, saved_at`;
      // Compare-and-set: no row means someone else saved (or published) since this author read the draft.
      if (!rows[0]) throw new KbAuthoringError('support.kb_draft_stale');
      return fromDraft(rows[0]);
    } catch (err) {
      if (isFkViolation(err)) throw new KbAuthoringError('support.kb_section_unknown');
      throw err;
    }
  }

  async getDraft(articleId: string): Promise<SupportKbDraft | null> {
    const [row] = await this.sql<DraftRow[]>`
      SELECT article_id, language, title, body, section_id, draft_revision, saved_by, saved_at FROM support.kb_drafts WHERE article_id = ${articleId}`;
    return row ? fromDraft(row) : null;
  }

  async publish(articleId: string, revision: number, by: string, at: string): Promise<SupportKbAuthoredArticle> {
    const key = supportKbPublishKey(articleId, revision);
    return this.sql.begin(async (tx) => {
      // Serialise publishers of one article on its draft row (or the head when there is no draft).
      await tx`SELECT 1 FROM support.kb_drafts WHERE article_id = ${articleId} FOR UPDATE`;
      await tx`SELECT 1 FROM support.kb_authored_articles WHERE id = ${articleId} FOR UPDATE`;
      const [replay] = await tx<VersionRow[]>`
        SELECT article_id, version, language, title, body, section_id, published_at
        FROM support.kb_authored_versions WHERE publish_key = ${key}`;
      if (replay) return fromVersion(replay);
      const [head] = await tx<{ revision: number }[]>`SELECT revision FROM support.kb_authored_articles WHERE id = ${articleId}`;
      if ((head?.revision ?? 0) !== revision) throw new KbAuthoringError('support.kb.revision_stale');
      const [draft] = await tx<DraftRow[]>`
        SELECT article_id, language, title, body, section_id, draft_revision, saved_by, saved_at FROM support.kb_drafts WHERE article_id = ${articleId}`;
      if (!draft) throw new KbAuthoringError('support.kb_draft_missing');
      const version = revision + 1;
      await tx`
        INSERT INTO support.kb_authored_articles (id, revision, updated_at) VALUES (${articleId}, ${version}, ${at})
        ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at`;
      const [row] = await tx<VersionRow[]>`
        INSERT INTO support.kb_authored_versions
          (article_id, version, publish_key, language, title, body, section_id, published_by, published_at)
        VALUES (${articleId}, ${version}, ${key}, ${draft.language}, ${draft.title}, ${draft.body}, ${draft.section_id}, ${by}, ${at})
        RETURNING article_id, version, language, title, body, section_id, published_at`;
      await tx`DELETE FROM support.kb_drafts WHERE article_id = ${articleId}`;
      return fromVersion(row!);
    }) as Promise<SupportKbAuthoredArticle>;
  }

  async listPublished(limit: number, language?: string): Promise<SupportKbAuthoredArticle[]> {
    const rows = await this.sql<VersionRow[]>`
      SELECT v.article_id, v.version, v.language, v.title, v.body, v.section_id, v.published_at
      FROM support.kb_authored_articles a
      JOIN support.kb_authored_versions v ON v.article_id = a.id AND v.version = a.revision
      WHERE ${language === undefined ? this.sql`true` : this.sql`v.language = ${language}`}
      ORDER BY v.published_at DESC, v.article_id
      LIMIT ${limit}`;
    return rows.map(fromVersion);
  }

  async getPublished(articleId: string): Promise<SupportKbAuthoredArticle | null> {
    const [row] = await this.sql<VersionRow[]>`
      SELECT v.article_id, v.version, v.language, v.title, v.body, v.section_id, v.published_at
      FROM support.kb_authored_articles a
      JOIN support.kb_authored_versions v ON v.article_id = a.id AND v.version = a.revision
      WHERE a.id = ${articleId}`;
    return row ? fromVersion(row) : null;
  }

  async versions(articleId: string): Promise<SupportKbAuthoredArticle[]> {
    const rows = await this.sql<VersionRow[]>`
      SELECT article_id, version, language, title, body, section_id, published_at
      FROM support.kb_authored_versions WHERE article_id = ${articleId} ORDER BY version`;
    return rows.map(fromVersion);
  }
}
