/**
 * Writing, reviewing and publishing a help article (SP-kb-01, SP-kb-02).
 *
 * An author saves drafts: each one an immutable version above the live article, which readers never see. A draft goes
 * live only after a second operator approves that exact revision; the author approving their own words is refused. An
 * edit after approval is a new draft with no approval, so it returns to draft. Every refusal is a typed code, and a move
 * repeated after a lost reply answers what is stored instead of doing it twice.
 */
import {
  supportKbBodyProblem,
  supportKbTitleProblem,
  SUPPORT_KB_DRAFT_UNKNOWN,
  SUPPORT_KB_NOT_APPROVED,
  SUPPORT_KB_NOT_IN_REVIEW,
  SUPPORT_KB_SAME_OPERATOR,
  SUPPORT_KB_SECTION_UNKNOWN,
  SUPPORT_KB_TEMPLATE_STALE,
  SUPPORT_KB_TEMPLATE_UNKNOWN,
  type SupportKbArticle,
  type SupportKbDraft,
  type SupportKbDraftSaveInput,
  type SupportKbHistory,
  type SupportKbReviewState,
  type SupportKbTemplate,
  type SupportKbTemplateSaveInput,
} from '@intafaced/contracts';
import { namesVendor } from './kb-catalog.js';
import type { KbReview, KbReviewBook, KbReviewResult } from './kb-review.js';
import type { KbDraft, SupportStore } from './store.js';

export const SUPPORT_KB_REVISION_STALE = 'support.kb.revision_stale';
const ALREADY_IN_REVIEW = 'support.kb_already_in_review';

/** A refusal with its code; the router maps it to a status. */
export class KbAuthoringError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'KbAuthoringError';
  }
}

type DraftStore = Pick<SupportStore, 'saveKbDraft' | 'getKbDraft' | 'listKbHistory' | 'publishKbDraft' | 'getPublishedKb'>;

const stateOf = (review: KbReview | null): SupportKbReviewState => review?.state ?? 'draft';

function view(draft: KbDraft, review: KbReview | null): SupportKbDraft {
  return {
    id: draft.id,
    revision: draft.revision,
    state: stateOf(review),
    authorId: draft.authorId,
    templateId: draft.templateId,
    title: draft.title,
    body: draft.body,
    language: draft.language,
    sectionId: draft.sectionId,
    tags: [...draft.tags],
    audience: draft.audience,
    createdAt: draft.createdAt,
  };
}

function refused(result: KbReviewResult): KbReview {
  if (result.status === 'ok') return result.review;
  if (result.reason === 'same_operator') throw new KbAuthoringError(SUPPORT_KB_SAME_OPERATOR);
  if (result.reason === 'not_approved') throw new KbAuthoringError(SUPPORT_KB_NOT_APPROVED);
  if (result.reason === 'already_reviewed') throw new KbAuthoringError(ALREADY_IN_REVIEW);
  throw new KbAuthoringError(SUPPORT_KB_NOT_IN_REVIEW);
}

export class KbAuthoring {
  constructor(
    private readonly store: DraftStore,
    private readonly book: KbReviewBook,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async saveDraft(by: string, input: SupportKbDraftSaveInput): Promise<SupportKbDraft> {
    const titleProblem = supportKbTitleProblem(input.title);
    if (titleProblem) throw new KbAuthoringError(titleProblem);
    const bodyProblem = supportKbBodyProblem(input.body);
    if (bodyProblem) throw new KbAuthoringError(bodyProblem);
    const tags = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
    // Readers will see this text once it is published, so it is held to the no-vendor rule from the first draft.
    if (namesVendor(`${input.title} ${input.body} ${tags.join(' ')}`)) throw new KbAuthoringError('support.kb_vendor_name');
    const templateId = input.templateId ?? null;
    if (templateId) {
      const template = await this.book.getTemplate(templateId);
      if (!template || template.retired) throw new KbAuthoringError(SUPPORT_KB_TEMPLATE_UNKNOWN);
    }
    const saved = await this.store.saveKbDraft({
      id: input.id,
      baseRevision: input.baseRevision,
      authorId: by,
      templateId,
      title: input.title.trim(),
      body: input.body.trim(),
      language: input.language.trim(),
      sectionId: input.sectionId,
      tags,
    });
    if (saved.status === 'refuse') {
      throw new KbAuthoringError(saved.reason === 'section_unknown' ? SUPPORT_KB_SECTION_UNKNOWN : SUPPORT_KB_REVISION_STALE);
    }
    return view(saved.draft, null);
  }

  async draft(id: string, revision: number): Promise<SupportKbDraft> {
    const draft = await this.store.getKbDraft(id, revision);
    if (!draft) throw new KbAuthoringError(SUPPORT_KB_DRAFT_UNKNOWN);
    return view(draft, await this.book.get(id, revision));
  }

  async history(id: string): Promise<SupportKbHistory> {
    const [versions, reviews, trail] = await Promise.all([this.store.listKbHistory(id), this.book.list(id), this.book.trail(id)]);
    const byRevision = new Map(reviews.map((r) => [r.revision, r]));
    return {
      id,
      versions: versions.map((v) => ({ ...v, state: v.draft ? stateOf(byRevision.get(v.revision) ?? null) : null })),
      trail: trail.map((row) => ({ ...row })),
    };
  }

  /** The draft, refused unless it is still the newest version (an edit since makes it stale). */
  private async newestDraft(id: string, revision: number): Promise<KbDraft> {
    const draft = await this.store.getKbDraft(id, revision);
    if (!draft) throw new KbAuthoringError(SUPPORT_KB_DRAFT_UNKNOWN);
    const versions = await this.store.listKbHistory(id);
    if (versions.some((v) => v.revision > revision)) throw new KbAuthoringError(SUPPORT_KB_REVISION_STALE);
    return draft;
  }

  async submit(by: string, input: { id: string; revision: number }): Promise<SupportKbDraft> {
    const draft = await this.newestDraft(input.id, input.revision);
    const review = refused(
      await this.book.submit({ articleId: input.id, revision: input.revision, authorId: draft.authorId, by, at: this.now() }),
    );
    return view(draft, review);
  }

  async approve(by: string, input: { id: string; revision: number }): Promise<SupportKbDraft> {
    const draft = await this.newestDraft(input.id, input.revision);
    const review = refused(await this.book.approve({ articleId: input.id, revision: input.revision, by, at: this.now() }));
    return view(draft, review);
  }

  async sendBack(by: string, input: { id: string; revision: number; reason: string }): Promise<SupportKbDraft> {
    const draft = await this.newestDraft(input.id, input.revision);
    const review = refused(
      await this.book.sendBack({ articleId: input.id, revision: input.revision, by, reason: input.reason, at: this.now() }),
    );
    return view(draft, review);
  }

  /**
   * Publish an approved draft once. A replay after the publish answers the live article and writes nothing; a publish
   * whose write landed before its review row did (a crash between them) is settled by the replay.
   */
  async publish(by: string, input: { id: string; revision: number }): Promise<SupportKbArticle> {
    const draft = await this.store.getKbDraft(input.id, input.revision);
    if (!draft) throw new KbAuthoringError(SUPPORT_KB_DRAFT_UNKNOWN);
    const review = await this.book.get(input.id, input.revision);
    if (review?.state === 'published') return this.live(input.id);
    if (review?.state !== 'approved') throw new KbAuthoringError(SUPPORT_KB_NOT_APPROVED);
    const written = await this.store.publishKbDraft({ id: input.id, revision: input.revision });
    let publishedRevision: number;
    if (written.status === 'ok') {
      publishedRevision = written.article.revision ?? written.article.version ?? input.revision + 1;
    } else if (written.status === 'refuse' && written.reason === 'section_unknown') {
      throw new KbAuthoringError(SUPPORT_KB_SECTION_UNKNOWN);
    } else {
      // Newer than the draft: either this draft's own publish, which landed before a crash (settle it, whatever was
      // saved since), or an edit since (stale).
      const versions = await this.store.listKbHistory(input.id);
      const own = versions.find((v) => !v.draft && v.sourceRevision === input.revision);
      if (!own) throw new KbAuthoringError(SUPPORT_KB_REVISION_STALE);
      publishedRevision = own.revision;
    }
    refused(await this.book.published({ articleId: input.id, revision: input.revision, by, publishedRevision, at: this.now() }));
    return this.live(input.id);
  }

  private async live(id: string): Promise<SupportKbArticle> {
    const article = await this.store.getPublishedKb(id);
    if (!article) throw new KbAuthoringError(SUPPORT_KB_DRAFT_UNKNOWN);
    return article;
  }

  listTemplates(): Promise<SupportKbTemplate[]> {
    return this.book.listTemplates();
  }

  async saveTemplate(by: string, input: SupportKbTemplateSaveInput): Promise<SupportKbTemplate> {
    if (namesVendor(`${input.name} ${input.body}`)) throw new KbAuthoringError('support.kb_vendor_name');
    const saved = await this.book.saveTemplate({ ...input, by, at: this.now() });
    if (saved.status === 'refuse') throw new KbAuthoringError(SUPPORT_KB_TEMPLATE_STALE);
    return saved.template;
  }
}
