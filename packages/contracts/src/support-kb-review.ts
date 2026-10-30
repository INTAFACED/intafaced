/**
 * Help-article drafts, review by a second operator, and templates (SP-kb-01, SP-kb-02).
 *
 * A draft is an immutable version above the live article; readers never see it. Publishing needs an approved review of
 * that exact draft, and the approver is never the draft's author. Browser safe: nothing here imports Node.
 */
import { z } from 'zod';
import { SUPPORT_KB_BODY_MAX, SUPPORT_KB_TITLE_MAX } from './support.js';
import { supportKbLibraryIdSchema, SUPPORT_KB_LIBRARY_REASON_MAX } from './support-kb-library.js';

/** The author tried to approve their own draft. */
export const SUPPORT_KB_SAME_OPERATOR = 'support.kb_same_operator';
/** Approve or send back on a draft that is not in review. */
export const SUPPORT_KB_NOT_IN_REVIEW = 'support.kb_not_in_review';
/** Publish on a draft that has no approval. */
export const SUPPORT_KB_NOT_APPROVED = 'support.kb_not_approved';
/** No draft with that revision. */
export const SUPPORT_KB_DRAFT_UNKNOWN = 'support.kb_draft_unknown';
/** A template the desk has not written, or has retired. */
export const SUPPORT_KB_TEMPLATE_UNKNOWN = 'support.kb_template_unknown';
/** Typed text goes live only through a reviewed draft. */
export const SUPPORT_KB_REVIEW_REQUIRED = 'support.kb_review_required';
/** A template change from a revision someone else already changed. */
export const SUPPORT_KB_TEMPLATE_STALE = 'support.kb_template_revision_stale';

export const SUPPORT_KB_TEMPLATE_NAME_MAX = 120;

export const supportKbReviewStateSchema = z.enum(['draft', 'in_review', 'approved', 'published', 'sent_back']);
export type SupportKbReviewState = z.infer<typeof supportKbReviewStateSchema>;

const language = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/);
const tags = z.array(z.string().trim().min(1).max(200)).max(20);
const reason = z.string().trim().min(1).max(SUPPORT_KB_LIBRARY_REASON_MAX);

/** Save a draft. `baseRevision` is the newest version the author read (0 for a new article). */
export const supportKbDraftSaveInputSchema = z
  .object({
    id: supportKbLibraryIdSchema,
    title: z.string().max(SUPPORT_KB_TITLE_MAX + 50),
    body: z.string().max(SUPPORT_KB_BODY_MAX + 50),
    language,
    sectionId: supportKbLibraryIdSchema,
    tags: tags.optional(),
    templateId: supportKbLibraryIdSchema.nullable().optional(),
    baseRevision: z.number().int().nonnegative(),
  })
  .strict();
export type SupportKbDraftSaveInput = z.infer<typeof supportKbDraftSaveInputSchema>;

export const supportKbDraftSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive(),
    state: supportKbReviewStateSchema,
    authorId: z.string(),
    templateId: z.string().nullable(),
    title: z.string(),
    body: z.string(),
    language: z.string(),
    sectionId: z.string(),
    tags: z.array(z.string()),
    audience: z.enum(['public', 'signed_in', 'staff']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type SupportKbDraft = z.infer<typeof supportKbDraftSchema>;

/** Submit, approve, send back or publish one draft revision. A send back needs a reason. */
export const supportKbReviewActInputSchema = z
  .object({ id: supportKbLibraryIdSchema, revision: z.number().int().positive(), reason: reason.optional() })
  .strict();
export type SupportKbReviewActInput = z.infer<typeof supportKbReviewActInputSchema>;

export const supportKbReviewActionSchema = z.enum(['submit', 'approve', 'send_back', 'publish']);
export type SupportKbReviewAction = z.infer<typeof supportKbReviewActionSchema>;

export const supportKbHistorySchema = z
  .object({
    id: z.string(),
    versions: z.array(
      z
        .object({
          revision: z.number().int().positive(),
          draft: z.boolean(),
          state: supportKbReviewStateSchema.nullable(),
          authorId: z.string().nullable(),
          title: z.string().nullable(),
          audience: z.enum(['public', 'signed_in', 'staff']),
          live: z.boolean(),
          createdAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    trail: z.array(
      z
        .object({
          revision: z.number().int().positive(),
          action: supportKbReviewActionSchema,
          actorId: z.string(),
          reason: z.string().nullable(),
          at: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export type SupportKbHistory = z.infer<typeof supportKbHistorySchema>;

export const supportKbTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    body: z.string(),
    revision: z.number().int().positive(),
    retired: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type SupportKbTemplate = z.infer<typeof supportKbTemplateSchema>;

/** Write or change a template. `expectedRevision` is 0 for a new one. */
export const supportKbTemplateSaveInputSchema = z
  .object({
    id: supportKbLibraryIdSchema,
    name: z.string().trim().min(1).max(SUPPORT_KB_TEMPLATE_NAME_MAX),
    body: z.string().trim().min(1).max(SUPPORT_KB_BODY_MAX),
    retired: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative(),
    reason,
  })
  .strict();
export type SupportKbTemplateSaveInput = z.infer<typeof supportKbTemplateSaveInputSchema>;
