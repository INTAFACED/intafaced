/**
 * Support help-centre authoring contract (SP-kb-01): the article body store, categories and sections, draft and
 * published versions, and the per-article history.
 *
 * Browser safe: nothing here imports Node.
 *
 * Rules carried by the shapes below:
 * - An article version carries a title and a body typed in the desk, in the language of the version. The body is
 *   text in a restricted formatting set (headings, lists, emphasis, links, code); raw HTML or script is refused at the
 *   wire, so a body can never inject markup. Rendering stays the reader's job and is always escaped.
 * - A version is `draft` or `published`. A draft is visible only to desk staff (author preview); readers see published
 *   versions only. Versions are immutable: a new save writes a new version, and `baseRevision` is the head the desk
 *   read (a stale one refuses with the existing `support.kb.revision_stale`).
 * - Categories and sections are desk rows (name, order, parent category). An article belongs to exactly one section.
 *   Nothing is seeded: an empty list is an honest empty help centre, never sample categories.
 * - Templates are owner-written; none ship. An empty template list is the honest answer.
 * - Scheduled publish is not part of this contract (it needs the sweep interval, ENGINE AU-3); publish is manual.
 */
import { z } from 'zod';
import { supportKbArticleSchema } from './support.js';

export const SUPPORT_KB_AUTHORING_ERROR_CODES = [
  'support.kb_body_markup_refused',
  'support.kb_section_unknown',
  'support.kb_category_unknown',
  'support.kb_category_not_empty',
  'support.kb_language_invalid',
] as const;
export type SupportKbAuthoringErrorCode = (typeof SUPPORT_KB_AUTHORING_ERROR_CODES)[number];

export const SUPPORT_KB_TITLE_MAX = 200;
export const SUPPORT_KB_BODY_MAX = 50_000;
export const SUPPORT_KB_NAME_MAX = 120;

/** Any tag-like opener (`<p`, `</div`, `<!--`, `<script`); `a < b` is text, browsers do not open a tag there is raw markup and refused. */
const RAW_MARKUP = /<[/!a-z]/i;

/** True when the text holds no raw HTML or script; the restricted formatting set is markdown-style text. */
export function kbBodyIsRestrictedFormat(text: string): boolean {
  return !RAW_MARKUP.test(text);
}

export const supportKbBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(SUPPORT_KB_BODY_MAX)
  .refine(kbBodyIsRestrictedFormat, { message: 'support.kb_body_markup_refused' });

export const supportKbTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(SUPPORT_KB_TITLE_MAX)
  .refine(kbBodyIsRestrictedFormat, { message: 'support.kb_body_markup_refused' });

/** BCP-47-ish language tag (`en`, `es`, `pt-BR`). Which languages are offered is checked by the service. */
export const supportKbLanguageSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);

export const supportKbVersionStateSchema = z.enum(['draft', 'published']);
export type SupportKbVersionState = z.infer<typeof supportKbVersionStateSchema>;

const nameSchema = z.string().trim().min(1).max(SUPPORT_KB_NAME_MAX);

export const supportKbCategorySchema = z
  .object({
    id: z.string().uuid(),
    name: nameSchema,
    order: z.number().int().nonnegative(),
  })
  .strict();
export type SupportKbCategory = z.infer<typeof supportKbCategorySchema>;

export const supportKbSectionSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    name: nameSchema,
    order: z.number().int().nonnegative(),
  })
  .strict();
export type SupportKbSection = z.infer<typeof supportKbSectionSchema>;

/** Public `listKbCategories` output: categories with their sections, both in desk order. Empty when none exist. */
export const supportKbCategoryTreeSchema = z.array(supportKbCategorySchema.extend({ sections: z.array(supportKbSectionSchema) }).strict());
export type SupportKbCategoryTree = z.infer<typeof supportKbCategoryTreeSchema>;

/** Desk `saveKbCategory`: create (no id) or rename/reorder. */
export const saveKbCategoryInputSchema = z
  .object({ id: z.string().uuid().optional(), name: nameSchema, order: z.number().int().nonnegative() })
  .strict();
export type SaveKbCategoryInput = z.infer<typeof saveKbCategoryInputSchema>;

/** Desk `saveKbSection`: create (no id) or rename/reorder/move under another category. */
export const saveKbSectionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    categoryId: z.string().uuid(),
    name: nameSchema,
    order: z.number().int().nonnegative(),
  })
  .strict();
export type SaveKbSectionInput = z.infer<typeof saveKbSectionInputSchema>;

/**
 * Desk `saveKbDraft` (`support:ops`): writes a new immutable draft version. `baseRevision` 0 creates the article.
 * `publishKb` with the same revision publishes it; nothing is published by a save.
 */
export const saveKbDraftInputSchema = z
  .object({
    id: z.string().min(1).max(200),
    baseRevision: z.number().int().nonnegative(),
    language: supportKbLanguageSchema,
    title: supportKbTitleSchema,
    body: supportKbBodySchema,
    sectionId: z.string().uuid(),
    tags: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();
export type SaveKbDraftInput = z.infer<typeof saveKbDraftInputSchema>;

/** One version as the desk sees it (preview and history). Readers keep using `supportKbArticleSchema`. */
export const supportKbVersionSchema = z
  .object({
    id: z.string().min(1).max(200),
    version: z.number().int().positive(),
    state: supportKbVersionStateSchema,
    language: supportKbLanguageSchema,
    title: supportKbTitleSchema,
    body: supportKbBodySchema,
    sectionId: z.string().uuid().nullable(),
    tags: z.array(z.string().min(1).max(200)).max(20),
    authorId: z.string().uuid().nullable(),
    savedAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SupportKbVersion = z.infer<typeof supportKbVersionSchema>;

/** Desk `kbHistory` input: newest first; `limit` required so omit never dumps a history. */
export const kbHistoryInputSchema = z.object({ id: z.string().min(1).max(200), limit: z.number().int().positive().max(200) }).strict();
export type KbHistoryInput = z.infer<typeof kbHistoryInputSchema>;

export const supportKbHistorySchema = z.array(supportKbVersionSchema.omit({ body: true }));
export type SupportKbHistory = z.infer<typeof supportKbHistorySchema>;

/** Owner-written article template. None ship; an empty list is the honest answer. */
export const supportKbTemplateSchema = z
  .object({ id: z.string().uuid(), name: nameSchema, title: supportKbTitleSchema, body: supportKbBodySchema })
  .strict();
export type SupportKbTemplate = z.infer<typeof supportKbTemplateSchema>;

/** A published reader article may now also name its section; omitted on rows written before sections. */
export const supportKbReaderArticleSchema = supportKbArticleSchema.extend({
  sectionId: z.string().uuid().optional(),
  language: supportKbLanguageSchema.optional(),
});
export type SupportKbReaderArticle = z.infer<typeof supportKbReaderArticleSchema>;
