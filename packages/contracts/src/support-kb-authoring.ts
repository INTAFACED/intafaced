/**
 * Help-centre authoring (SP-kb-01): desk-written article bodies, categories and sections, drafts and keyed publish.
 *
 * - A body is plain text in a restricted formatting set: paragraphs (blank line), `- ` list items, `**bold**`,
 *   `*italic*` and `[text](https://…)` links. Raw HTML of any kind (`<tag`, `</tag`, `<!`, `<?`) is refused
 *   `support.kb_body_invalid`, and the renderer below escapes everything else, so a script tag can only ever show as text.
 * - A blank title is `support.kb_title_blank`. A section that does not exist is `support.kb_section_unknown`.
 * - Sections and categories are owner content: none are seeded. An article with `sectionId: null` sits in the one
 *   default section, which is what a desk with no sections shows.
 * - A draft save carries `expectedDraftRevision` (0 when there is no draft), so two authors never silently overwrite
 *   each other: a stale save refuses `support.kb_draft_stale`.
 * - Bodies are returned raw. Clients MUST render them only through `renderSupportKbBody`, never a generic
 *   markdown or HTML renderer: that function is the safe-render guarantee.
 * - Publish is keyed (article, revision): the revision the author read. A replay of the same key returns the same
 *   version; any other stale revision refuses with the existing `support.kb.revision_stale`.
 */
import { z } from 'zod';

export const SUPPORT_KB_AUTHORING_ERROR_CODES = [
  'support.kb_body_invalid',
  'support.kb_section_unknown',
  'support.kb_title_blank',
  'support.kb.revision_stale',
  'support.kb_draft_missing',
  'support.kb_category_unknown',
  /** The same client id was used again with different fields (CONFLICT). */
  'support.kb_id_taken',
  /** No published version of that article (NOT_FOUND on the public get). */
  'support.kb.not_published',
  /** The draft changed since the author read it (CONFLICT). */
  'support.kb_draft_stale',
] as const;
export type SupportKbAuthoringErrorCode = (typeof SUPPORT_KB_AUTHORING_ERROR_CODES)[number];

export const SUPPORT_KB_TITLE_MAX = 200;
export const SUPPORT_KB_BODY_MAX = 20_000;
export const SUPPORT_KB_NAME_MAX = 120;

/** Raw markup the restricted set never accepts: an opening or closing tag, a comment/doctype or a processing instruction. */
const RAW_MARKUP = /<\s*[a-zA-Z/!?]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Why a body cannot be stored, or null. */
export function supportKbBodyProblem(body: string): 'blank' | 'too_long' | 'raw_markup' | 'control_character' | null {
  if (body.trim() === '') return 'blank';
  if (body.length > SUPPORT_KB_BODY_MAX) return 'too_long';
  if (RAW_MARKUP.test(body)) return 'raw_markup';
  if (CONTROL.test(body)) return 'control_character';
  return null;
}

export const supportKbBodySchema = z.string().refine((b) => supportKbBodyProblem(b) === null, { message: 'support.kb_body_invalid' });
export const supportKbTitleSchema = z
  .string()
  .trim()
  .min(1, { message: 'support.kb_title_blank' })
  .max(SUPPORT_KB_TITLE_MAX)
  .refine((t) => !CONTROL.test(t) && !t.includes('\n'), { message: 'support.kb_title_blank' });
/** BCP 47 language of the version, e.g. `en` or `pt-BR`. */
export const supportKbLanguageSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https:\/\/[^\s)*]+|mailto:[^\s)*]+)\)/g, (_m, label: string, href: string) => {
    return `<a href="${href}" rel="noopener noreferrer nofollow">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

/**
 * The only HTML a body becomes. Every character of the source is escaped first; only the restricted set is turned
 * back into tags, and a link is kept only for `https:` or `mailto:`. So `<script>` renders as the text `&lt;script&gt;`.
 */
export function renderSupportKbBody(body: string): string {
  const blocks = body.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return blocks
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => l.startsWith('- '))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

export const supportKbCategorySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(SUPPORT_KB_NAME_MAX),
    position: z.number().int().min(0),
    parentId: z.string().uuid().nullable(),
  })
  .strict();
export type SupportKbCategory = z.infer<typeof supportKbCategorySchema>;

export const supportKbSectionSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    name: z.string().min(1).max(SUPPORT_KB_NAME_MAX),
    position: z.number().int().min(0),
  })
  .strict();
export type SupportKbSection = z.infer<typeof supportKbSectionSchema>;

/** Public read: every category and section in order. Empty until the owner creates them (one default section). */
export const supportKbCategoriesSchema = z
  .object({ categories: z.array(supportKbCategorySchema), sections: z.array(supportKbSectionSchema) })
  .strict();
export type SupportKbCategories = z.infer<typeof supportKbCategoriesSchema>;

export const createKbCategoryInputSchema = z
  .object({
    /** Client-chosen id: a replay with the same id and fields returns the same row. */
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(SUPPORT_KB_NAME_MAX),
    position: z.number().int().min(0).max(10_000),
    parentId: z.string().uuid().nullable(),
  })
  .strict();
export const createKbSectionInputSchema = z
  .object({
    id: z.string().uuid(),
    categoryId: z.string().uuid(),
    name: z.string().trim().min(1).max(SUPPORT_KB_NAME_MAX),
    position: z.number().int().min(0).max(10_000),
  })
  .strict();

const versionFields = {
  language: supportKbLanguageSchema,
  title: supportKbTitleSchema,
  body: supportKbBodySchema,
  /** null is the default section. */
  sectionId: z.string().uuid().nullable(),
};

export const saveKbDraftInputSchema = z
  .object({
    /** Client-chosen id for a new article; the existing id for an edit. */
    articleId: z.string().uuid(),
    /** The draft revision the author read; 0 when the article has no draft. */
    expectedDraftRevision: z.number().int().min(0).max(2_147_483_646),
    ...versionFields,
  })
  .strict();
export type SaveKbDraftInput = z.infer<typeof saveKbDraftInputSchema>;

export const supportKbDraftSchema = z
  .object({
    articleId: z.string().uuid(),
    language: z.string(),
    title: z.string(),
    body: z.string(),
    sectionId: z.string().uuid().nullable(),
    /** Bumps on every save; a publish removes the draft. */
    draftRevision: z.number().int().min(1),
    savedBy: z.string(),
    savedAt: z.string().datetime(),
  })
  .strict();
export type SupportKbDraft = z.infer<typeof supportKbDraftSchema>;

export const publishKbDraftInputSchema = z
  .object({
    articleId: z.string().uuid(),
    /** The article's revision the author read: 0 for a never-published article. Together with the id, the publish key. */
    revision: z.number().int().min(0).max(2_147_483_646),
  })
  .strict();
export type PublishKbDraftInput = z.infer<typeof publishKbDraftInputSchema>;

/** One immutable published version of a desk-written article. */
export const supportKbAuthoredArticleSchema = z
  .object({
    articleId: z.string().uuid(),
    version: z.number().int().min(1),
    language: z.string(),
    title: z.string(),
    body: z.string(),
    sectionId: z.string().uuid().nullable(),
    publishedAt: z.string().datetime(),
  })
  .strict();
export type SupportKbAuthoredArticle = z.infer<typeof supportKbAuthoredArticleSchema>;

/** The publish key: the article and the revision it moves from. */
export function supportKbPublishKey(articleId: string, revision: number): string {
  return `support.kb.publish:${articleId}:r${revision}`;
}
