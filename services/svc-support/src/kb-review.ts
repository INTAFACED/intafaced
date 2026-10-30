/**
 * Review of help-article drafts by a second operator, and article templates (SP-kb-02, SP-kb-01).
 *
 * One review per draft version. Its state only moves forward: in review → approved → published, or in review → sent
 * back. The approver is never the draft's author (refused here and by the table's check). Every move writes one trail
 * row; repeating a move already made (a lost reply retried) answers the stored review and writes nothing.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { SupportKbReviewAction, SupportKbTemplate, SupportKbTemplateSaveInput } from '@intafaced/contracts';

export type KbReviewState = 'in_review' | 'approved' | 'published' | 'sent_back';

export interface KbReview {
  readonly articleId: string;
  readonly revision: number;
  readonly authorId: string;
  readonly state: KbReviewState;
  readonly submittedBy: string;
  readonly approvedBy: string | null;
  readonly publishedBy: string | null;
  readonly publishedRevision: number | null;
}

export interface KbReviewTrailRow {
  readonly revision: number;
  readonly action: SupportKbReviewAction;
  readonly actorId: string;
  readonly reason: string | null;
  readonly at: string;
}

export interface KbTemplateLogRow {
  readonly revision: number;
  readonly name: string;
  readonly retired: boolean;
  readonly actorId: string;
  readonly reason: string;
  readonly at: string;
}

export type KbReviewRefusal = 'same_operator' | 'not_in_review' | 'not_approved' | 'already_reviewed' | 'template_stale';
export type KbReviewResult = { status: 'ok'; review: KbReview; changed: boolean } | { status: 'refuse'; reason: KbReviewRefusal };

export interface KbReviewBook {
  get(articleId: string, revision: number): Promise<KbReview | null>;
  list(articleId: string): Promise<KbReview[]>;
  trail(articleId: string): Promise<KbReviewTrailRow[]>;
  submit(input: { articleId: string; revision: number; authorId: string; by: string; at: string }): Promise<KbReviewResult>;
  approve(input: { articleId: string; revision: number; by: string; at: string }): Promise<KbReviewResult>;
  sendBack(input: { articleId: string; revision: number; by: string; reason: string; at: string }): Promise<KbReviewResult>;
  /** Mark an approved review published, naming the live version it made. */
  published(input: { articleId: string; revision: number; by: string; publishedRevision: number; at: string }): Promise<KbReviewResult>;
  listTemplates(): Promise<SupportKbTemplate[]>;
  /** Every change to one template, oldest first, with who made it and why. */
  templateLog(id: string): Promise<KbTemplateLogRow[]>;
  getTemplate(id: string): Promise<SupportKbTemplate | null>;
  saveTemplate(
    input: SupportKbTemplateSaveInput & { by: string; at: string },
  ): Promise<{ status: 'ok'; template: SupportKbTemplate } | { status: 'refuse'; reason: 'template_stale' }>;
}

/** The move a review may make from where it is: the result, or why not. A move already made is a replay. */
function move(
  review: KbReview | null,
  action: SupportKbReviewAction,
  by: string,
): { kind: 'apply' } | { kind: 'replay' } | { kind: 'refuse'; reason: KbReviewRefusal } {
  if (action === 'submit') {
    // A draft sent back is not submitted again unchanged: the author saves a new draft, which has its own review.
    if (!review) return { kind: 'apply' };
    return review.state === 'in_review' && review.submittedBy === by ? { kind: 'replay' } : { kind: 'refuse', reason: 'already_reviewed' };
  }
  if (!review) return { kind: 'refuse', reason: action === 'publish' ? 'not_approved' : 'not_in_review' };
  if (action === 'approve') {
    if (review.authorId === by) return { kind: 'refuse', reason: 'same_operator' };
    if (review.state === 'approved' && review.approvedBy === by) return { kind: 'replay' };
    return review.state === 'in_review' ? { kind: 'apply' } : { kind: 'refuse', reason: 'not_in_review' };
  }
  if (action === 'send_back') {
    if (review.state === 'sent_back') return { kind: 'replay' };
    return review.state === 'in_review' ? { kind: 'apply' } : { kind: 'refuse', reason: 'not_in_review' };
  }
  if (review.state === 'published') return { kind: 'replay' };
  return review.state === 'approved' ? { kind: 'apply' } : { kind: 'refuse', reason: 'not_approved' };
}

export class MemoryKbReviewBook implements KbReviewBook {
  private readonly reviews = new Map<string, KbReview>();
  private readonly log: (KbReviewTrailRow & { articleId: string })[] = [];
  private readonly templates = new Map<string, SupportKbTemplate>();
  private readonly templateChanges: (KbTemplateLogRow & { id: string })[] = [];

  private key(articleId: string, revision: number): string {
    return `${articleId}\0${revision}`;
  }

  async get(articleId: string, revision: number): Promise<KbReview | null> {
    const row = this.reviews.get(this.key(articleId, revision));
    return row ? { ...row } : null;
  }

  async list(articleId: string): Promise<KbReview[]> {
    return [...this.reviews.values()].filter((r) => r.articleId === articleId).sort((a, b) => a.revision - b.revision);
  }

  async trail(articleId: string): Promise<KbReviewTrailRow[]> {
    return this.log.filter((r) => r.articleId === articleId).map(({ articleId: _a, ...row }) => ({ ...row }));
  }

  private act(
    articleId: string,
    revision: number,
    action: SupportKbReviewAction,
    by: string,
    at: string,
    next: (current: KbReview | null) => KbReview,
    reason: string | null = null,
  ): KbReviewResult {
    const current = this.reviews.get(this.key(articleId, revision)) ?? null;
    const decided = move(current, action, by);
    if (decided.kind === 'refuse') return { status: 'refuse', reason: decided.reason };
    if (decided.kind === 'replay') return { status: 'ok', review: { ...current! }, changed: false };
    const review = next(current);
    this.reviews.set(this.key(articleId, revision), review);
    this.log.push({ articleId, revision, action, actorId: by, reason, at });
    return { status: 'ok', review: { ...review }, changed: true };
  }

  async submit(input: { articleId: string; revision: number; authorId: string; by: string; at: string }): Promise<KbReviewResult> {
    return this.act(input.articleId, input.revision, 'submit', input.by, input.at, () => ({
      articleId: input.articleId,
      revision: input.revision,
      authorId: input.authorId,
      state: 'in_review',
      submittedBy: input.by,
      approvedBy: null,
      publishedBy: null,
      publishedRevision: null,
    }));
  }

  async approve(input: { articleId: string; revision: number; by: string; at: string }): Promise<KbReviewResult> {
    return this.act(input.articleId, input.revision, 'approve', input.by, input.at, (c) => ({
      ...c!,
      state: 'approved',
      approvedBy: input.by,
    }));
  }

  async sendBack(input: { articleId: string; revision: number; by: string; reason: string; at: string }): Promise<KbReviewResult> {
    return this.act(input.articleId, input.revision, 'send_back', input.by, input.at, (c) => ({ ...c!, state: 'sent_back' }), input.reason);
  }

  async published(input: {
    articleId: string;
    revision: number;
    by: string;
    publishedRevision: number;
    at: string;
  }): Promise<KbReviewResult> {
    return this.act(input.articleId, input.revision, 'publish', input.by, input.at, (c) => ({
      ...c!,
      state: 'published',
      publishedBy: input.by,
      publishedRevision: input.publishedRevision,
    }));
  }

  async listTemplates(): Promise<SupportKbTemplate[]> {
    return [...this.templates.values()].map((t) => ({ ...t })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getTemplate(id: string): Promise<SupportKbTemplate | null> {
    const row = this.templates.get(id);
    return row ? { ...row } : null;
  }

  async saveTemplate(
    input: SupportKbTemplateSaveInput & { by: string; at: string },
  ): Promise<{ status: 'ok'; template: SupportKbTemplate } | { status: 'refuse'; reason: 'template_stale' }> {
    const current = this.templates.get(input.id);
    if ((current?.revision ?? 0) !== input.expectedRevision) return { status: 'refuse', reason: 'template_stale' };
    const template: SupportKbTemplate = {
      id: input.id,
      name: input.name.trim(),
      body: input.body.trim(),
      revision: input.expectedRevision + 1,
      retired: input.retired ?? false,
      updatedAt: input.at,
    };
    this.templates.set(input.id, template);
    this.templateChanges.push({
      id: input.id,
      revision: template.revision,
      name: template.name,
      retired: template.retired,
      actorId: input.by,
      reason: input.reason.trim(),
      at: input.at,
    });
    return { status: 'ok', template: { ...template } };
  }

  async templateLog(id: string): Promise<KbTemplateLogRow[]> {
    return this.templateChanges.filter((row) => row.id === id).map(({ id: _id, ...row }) => ({ ...row }));
  }
}

type PgReview = {
  article_id: string;
  revision: number;
  author_id: string;
  state: KbReviewState;
  submitted_by: string;
  approved_by: string | null;
  published_by: string | null;
  published_revision: number | null;
};

const reviewFromPg = (r: PgReview): KbReview => ({
  articleId: r.article_id,
  revision: Number(r.revision),
  authorId: r.author_id,
  state: r.state,
  submittedBy: r.submitted_by,
  approvedBy: r.approved_by,
  publishedBy: r.published_by,
  publishedRevision: r.published_revision === null ? null : Number(r.published_revision),
});

type PgTemplate = { id: string; name: string; body: string; revision: number; retired: boolean; updated_at: Date };
const templateFromPg = (r: PgTemplate): SupportKbTemplate => ({
  id: r.id,
  name: r.name,
  body: r.body,
  revision: Number(r.revision),
  retired: r.retired,
  updatedAt: r.updated_at.toISOString(),
});

export class SqlKbReviewBook implements KbReviewBook {
  constructor(private readonly sql: Sql) {}

  async get(articleId: string, revision: number): Promise<KbReview | null> {
    const [row] = await this.sql<PgReview[]>`
      SELECT article_id, revision, author_id, state, submitted_by, approved_by, published_by, published_revision
      FROM support.kb_reviews WHERE article_id = ${articleId} AND revision = ${revision}
    `;
    return row ? reviewFromPg(row) : null;
  }

  async list(articleId: string): Promise<KbReview[]> {
    const rows = await this.sql<PgReview[]>`
      SELECT article_id, revision, author_id, state, submitted_by, approved_by, published_by, published_revision
      FROM support.kb_reviews WHERE article_id = ${articleId} ORDER BY revision
    `;
    return rows.map(reviewFromPg);
  }

  async trail(articleId: string): Promise<KbReviewTrailRow[]> {
    const rows = await this.sql<{ revision: number; action: SupportKbReviewAction; actor_id: string; reason: string | null; at: Date }[]>`
      SELECT revision, action, actor_id, reason, at FROM support.kb_review_log WHERE article_id = ${articleId} ORDER BY id
    `;
    return rows.map((r) => ({
      revision: Number(r.revision),
      action: r.action,
      actorId: r.actor_id,
      reason: r.reason,
      at: r.at.toISOString(),
    }));
  }

  /** Lock the review row, decide the move, write the new state and one trail row in one transaction. */
  private async act(
    articleId: string,
    revision: number,
    action: SupportKbReviewAction,
    by: string,
    at: string,
    write: (tx: TransactionSql, current: KbReview | null) => Promise<PgReview>,
    reason: string | null = null,
  ): Promise<KbReviewResult> {
    try {
      return await this.sql.begin(async (tx): Promise<KbReviewResult> => {
        const [locked] = await tx<PgReview[]>`
          SELECT article_id, revision, author_id, state, submitted_by, approved_by, published_by, published_revision
          FROM support.kb_reviews WHERE article_id = ${articleId} AND revision = ${revision} FOR UPDATE
        `;
        const current = locked ? reviewFromPg(locked) : null;
        const decided = move(current, action, by);
        if (decided.kind === 'refuse') return { status: 'refuse', reason: decided.reason };
        if (decided.kind === 'replay') return { status: 'ok', review: current!, changed: false };
        const row = await write(tx, current);
        await tx`
          INSERT INTO support.kb_review_log (article_id, revision, action, actor_id, reason, at)
          VALUES (${articleId}, ${revision}, ${action}, ${by}, ${reason}, ${at})
        `;
        return { status: 'ok', review: reviewFromPg(row), changed: true };
      });
    } catch (err) {
      // Two first submits racing for one draft: the loser's insert hits the key. It reads as already in review.
      if ((err as { code?: string }).code === '23505') return { status: 'refuse', reason: 'already_reviewed' };
      throw err;
    }
  }

  async submit(input: { articleId: string; revision: number; authorId: string; by: string; at: string }): Promise<KbReviewResult> {
    return this.act(input.articleId, input.revision, 'submit', input.by, input.at, async (tx, current) => {
      const [row] = current
        ? await tx<PgReview[]>`
            UPDATE support.kb_reviews
            SET state = 'in_review', submitted_by = ${input.by}, submitted_at = ${input.at}, approved_by = NULL, approved_at = NULL,
                updated_at = now()
            WHERE article_id = ${input.articleId} AND revision = ${input.revision}
            RETURNING article_id, revision, author_id, state, submitted_by, approved_by, published_by, published_revision
          `
        : await tx<PgReview[]>`
            INSERT INTO support.kb_reviews (article_id, revision, author_id, state, submitted_by, submitted_at)
            VALUES (${input.articleId}, ${input.revision}, ${input.authorId}, 'in_review', ${input.by}, ${input.at})
            RETURNING article_id, revision, author_id, state, submitted_by, approved_by, published_by, published_revision
          `;
      return row!;
    });
  }

  async approve(input: { articleId: string; revision: number; by: string; at: string }): Promise<KbReviewResult> {
    return this.act(input.articleId, input.revision, 'approve', input.by, input.at, async (tx) => {
      const [row] = await tx<PgReview[]>`
        UPDATE support.kb_reviews SET state = 'approved', approved_by = ${input.by}, approved_at = ${input.at}, updated_at = now()
        WHERE article_id = ${input.articleId} AND revision = ${input.revision}
        RETURNING article_id, revision, author_id, state, submitted_by, approved_by, published_by, published_revision
      `;
      return row!;
    });
  }

  async sendBack(input: { articleId: string; revision: number; by: string; reason: string; at: string }): Promise<KbReviewResult> {
    return this.act(
      input.articleId,
      input.revision,
      'send_back',
      input.by,
      input.at,
      async (tx) => {
        const [row] = await tx<PgReview[]>`
          UPDATE support.kb_reviews SET state = 'sent_back', updated_at = now()
          WHERE article_id = ${input.articleId} AND revision = ${input.revision}
          RETURNING article_id, revision, author_id, state, submitted_by, approved_by, published_by, published_revision
        `;
        return row!;
      },
      input.reason,
    );
  }

  async published(input: {
    articleId: string;
    revision: number;
    by: string;
    publishedRevision: number;
    at: string;
  }): Promise<KbReviewResult> {
    return this.act(input.articleId, input.revision, 'publish', input.by, input.at, async (tx) => {
      const [row] = await tx<PgReview[]>`
        UPDATE support.kb_reviews
        SET state = 'published', published_by = ${input.by}, published_at = ${input.at},
            published_revision = ${input.publishedRevision}, updated_at = now()
        WHERE article_id = ${input.articleId} AND revision = ${input.revision}
        RETURNING article_id, revision, author_id, state, submitted_by, approved_by, published_by, published_revision
      `;
      return row!;
    });
  }

  async listTemplates(): Promise<SupportKbTemplate[]> {
    const rows = await this.sql<PgTemplate[]>`SELECT id, name, body, revision, retired, updated_at FROM support.kb_templates ORDER BY name`;
    return rows.map(templateFromPg);
  }

  async getTemplate(id: string): Promise<SupportKbTemplate | null> {
    const [row] = await this.sql<
      PgTemplate[]
    >`SELECT id, name, body, revision, retired, updated_at FROM support.kb_templates WHERE id = ${id}`;
    return row ? templateFromPg(row) : null;
  }

  async saveTemplate(
    input: SupportKbTemplateSaveInput & { by: string; at: string },
  ): Promise<{ status: 'ok'; template: SupportKbTemplate } | { status: 'refuse'; reason: 'template_stale' }> {
    const name = input.name.trim();
    const body = input.body.trim();
    const retired = input.retired ?? false;
    return this.sql.begin(async (tx) => {
      const rows =
        input.expectedRevision === 0
          ? await tx<PgTemplate[]>`
            INSERT INTO support.kb_templates (id, name, body, revision, retired, updated_by, updated_at)
            VALUES (${input.id}, ${name}, ${body}, 1, ${retired}, ${input.by}, ${input.at})
            ON CONFLICT (id) DO NOTHING
            RETURNING id, name, body, revision, retired, updated_at
          `
          : await tx<PgTemplate[]>`
            UPDATE support.kb_templates
            SET name = ${name}, body = ${body}, retired = ${retired}, revision = revision + 1, updated_by = ${input.by},
                updated_at = ${input.at}
            WHERE id = ${input.id} AND revision = ${input.expectedRevision}
            RETURNING id, name, body, revision, retired, updated_at
          `;
      if (!rows[0]) return { status: 'refuse', reason: 'template_stale' } as const;
      const template = templateFromPg(rows[0]);
      await tx`
        INSERT INTO support.kb_template_log (template_id, revision, name, body, retired, actor_id, reason, at)
        VALUES (${template.id}, ${template.revision}, ${name}, ${body}, ${retired}, ${input.by}, ${input.reason.trim()}, ${input.at})
      `;
      return { status: 'ok', template } as const;
    }) as Promise<{ status: 'ok'; template: SupportKbTemplate } | { status: 'refuse'; reason: 'template_stale' }>;
  }

  async templateLog(id: string): Promise<KbTemplateLogRow[]> {
    const rows = await this.sql<
      { revision: number; name: string; retired: boolean; actor_id: string; reason: string; at: Date }[]
    >`SELECT revision, name, retired, actor_id, reason, at FROM support.kb_template_log WHERE template_id = ${id} ORDER BY revision`;
    return rows.map((r) => ({
      revision: Number(r.revision),
      name: r.name,
      retired: r.retired,
      actorId: r.actor_id,
      reason: r.reason,
      at: r.at.toISOString(),
    }));
  }
}
