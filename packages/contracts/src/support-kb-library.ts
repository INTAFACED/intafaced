/**
 * The help library (SP-kb-01): categories, the sections under them, and articles typed in the desk.
 *
 * Browser safe: nothing here imports Node. A category or section is created by support staff and is never seeded: an
 * empty library is an empty list. An article is filed under one section. Its title and body are plain text, shown as
 * text (a tag in the body is characters, never markup); paragraphs are separated by a blank line.
 */
import { z } from 'zod';
import { SUPPORT_KB_BODY_MAX, SUPPORT_KB_LIBRARY_ID_MAX, SUPPORT_KB_TITLE_MAX } from './support.js';

export const SUPPORT_KB_TITLE_BLANK = 'support.kb_title_blank';
export const SUPPORT_KB_TITLE_INVALID = 'support.kb_title_invalid';
export const SUPPORT_KB_BODY_INVALID = 'support.kb_body_invalid';
export const SUPPORT_KB_SECTION_UNKNOWN = 'support.kb_section_unknown';
export const SUPPORT_KB_CATEGORY_UNKNOWN = 'support.kb_category_unknown';
export const SUPPORT_KB_LIBRARY_INVALID = 'support.kb_library_invalid';

export const SUPPORT_KB_LIBRARY_ERROR_CODES = [
  SUPPORT_KB_TITLE_BLANK,
  SUPPORT_KB_TITLE_INVALID,
  SUPPORT_KB_BODY_INVALID,
  SUPPORT_KB_SECTION_UNKNOWN,
  SUPPORT_KB_CATEGORY_UNKNOWN,
  SUPPORT_KB_LIBRARY_INVALID,
] as const;

export const SUPPORT_KB_LIBRARY_NAME_MAX = 120;
export const SUPPORT_KB_LIBRARY_POSITION_MAX = 10_000;
export const SUPPORT_KB_LIBRARY_REASON_MAX = 500;

/** A library id: lower-case letters, digits and hyphens, chosen by the author so a link stays stable. */
export const supportKbLibraryIdSchema = z
  .string()
  .min(1)
  .max(SUPPORT_KB_LIBRARY_ID_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const BODY_CONTROL = /[\p{Cf}\u2028\u2029]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** Why a title cannot be stored, or `null`. */
export function supportKbTitleProblem(value: string): string | null {
  const text = value.trim();
  if (text === '') return SUPPORT_KB_TITLE_BLANK;
  if (text.length > SUPPORT_KB_TITLE_MAX || CONTROL.test(text)) return SUPPORT_KB_TITLE_INVALID;
  return null;
}

/** Why a body cannot be stored, or `null`. Line breaks and tabs are text; other control characters are not. */
export function supportKbBodyProblem(value: string): string | null {
  const text = value.trim();
  if (text === '' || text.length > SUPPORT_KB_BODY_MAX || BODY_CONTROL.test(text)) return SUPPORT_KB_BODY_INVALID;
  return null;
}

/** Why a category or section name cannot be stored, or `null`. */
export function supportKbLibraryNameProblem(value: string): string | null {
  const text = value.trim();
  if (text === '' || text.length > SUPPORT_KB_LIBRARY_NAME_MAX || CONTROL.test(text)) return SUPPORT_KB_LIBRARY_INVALID;
  return null;
}

/** The paragraphs of a stored body, as the reader sees them. */
export function supportKbParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const name = z.string().trim().min(1).max(SUPPORT_KB_LIBRARY_NAME_MAX);
const position = z.number().int().min(0).max(SUPPORT_KB_LIBRARY_POSITION_MAX);
const reason = z.string().trim().min(1).max(SUPPORT_KB_LIBRARY_REASON_MAX);

export const supportKbSectionSchema = z
  .object({
    id: z.string().min(1),
    categoryId: z.string().min(1),
    name: z.string().min(1),
    position: z.number().int().min(0),
    /** Published articles in this section the reader may see. Measured, never a guess. */
    articleCount: z.number().int().min(0),
  })
  .strict();
export type SupportKbSection = z.infer<typeof supportKbSectionSchema>;

export const supportKbCategorySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    position: z.number().int().min(0),
    sections: z.array(supportKbSectionSchema),
  })
  .strict();
export type SupportKbCategory = z.infer<typeof supportKbCategorySchema>;

/** What a reader browses: the open categories in order, each with its open sections. Empty until staff create one. */
export const supportKbLibrarySchema = z.object({ categories: z.array(supportKbCategorySchema) }).strict();
export type SupportKbLibrary = z.infer<typeof supportKbLibrarySchema>;

/** Create or change a category. `retired` takes it (and its sections) off the reader's list; nothing is deleted. */
export const supportKbSaveCategoryInputSchema = z
  .object({ id: supportKbLibraryIdSchema, name, position, retired: z.boolean().optional(), reason })
  .strict();
export type SupportKbSaveCategoryInput = z.infer<typeof supportKbSaveCategoryInputSchema>;

export const supportKbSaveSectionInputSchema = z
  .object({ id: supportKbLibraryIdSchema, categoryId: supportKbLibraryIdSchema, name, position, retired: z.boolean().optional(), reason })
  .strict();
export type SupportKbSaveSectionInput = z.infer<typeof supportKbSaveSectionInputSchema>;

/**
 * Publish an article typed in the desk. `baseRevision` 0 creates it; otherwise it is the revision the author read, and
 * a stale one refuses `support.kb.revision_stale`. A replay of the publish that made the current revision (same
 * text, section, language and tags from the same `baseRevision`) returns that revision instead of refusing.
 */
export const supportKbPublishTextInputSchema = z
  .object({
    id: supportKbLibraryIdSchema,
    title: z.string().max(SUPPORT_KB_TITLE_MAX + 50),
    body: z.string().max(SUPPORT_KB_BODY_MAX + 50),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/),
    sectionId: supportKbLibraryIdSchema,
    tags: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    baseRevision: z.number().int().nonnegative(),
  })
  .strict();
export type SupportKbPublishTextInput = z.infer<typeof supportKbPublishTextInputSchema>;

/** A reader's page of one section: published articles in it the reader may see, ordered by title. */
export const supportKbSectionReadInputSchema = z
  .object({ sectionId: z.string().min(1).max(SUPPORT_KB_LIBRARY_ID_MAX), limit: z.number().int().positive().max(500).optional() })
  .strict();
