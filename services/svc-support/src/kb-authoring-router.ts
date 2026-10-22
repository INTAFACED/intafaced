import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  createKbCategoryInputSchema,
  createKbSectionInputSchema,
  publicProcedure,
  publishKbDraftInputSchema,
  supportKbLanguageSchema,
  saveKbDraftInputSchema,
  scopedProcedure,
  supportKbAuthoredArticleSchema,
  supportKbCategoriesSchema,
  supportKbCategorySchema,
  supportKbDraftSchema,
  supportKbSectionSchema,
} from '@intafaced/contracts';
import { KbAuthoringError, type KbAuthoringBook } from './kb-authoring.js';
import { requireSupportOps } from './support-service.js';

/** The longest public page of desk-written articles. A wire bound, not an owner value. */
export const KB_AUTHORED_LIST_MAX = 100;

/**
 * Help-centre authoring (SP-kb-01). Reads are public and return published versions only; drafts never leave the desk.
 * Writes need a `support:ops` session, the same control as the existing `publishKb`.
 */
export function kbAuthoringProcedures(book: KbAuthoringBook, now: () => Date = () => new Date()) {
  const refuse = (err: unknown): never => {
    if (err instanceof KbAuthoringError) {
      const code =
        err.code === 'support.kb.revision_stale' || err.code === 'support.kb_id_taken' || err.code === 'support.kb_draft_stale'
          ? 'CONFLICT'
          : err.code === 'support.kb_draft_missing'
            ? 'NOT_FOUND'
            : 'BAD_REQUEST';
      throw new TRPCError({ code, message: err.code, cause: err });
    }
    throw err;
  };
  const at = () => now().toISOString();
  return {
    listKbCategories: publicProcedure.output(supportKbCategoriesSchema).query(() => book.categories()),

    listKbAuthored: publicProcedure
      .input(z.object({ limit: z.number().int().min(1).max(KB_AUTHORED_LIST_MAX), language: supportKbLanguageSchema.optional() }).strict())
      .output(z.array(supportKbAuthoredArticleSchema))
      .query(({ input }) => book.listPublished(input.limit, input.language)),

    getKbAuthored: publicProcedure
      .input(z.object({ articleId: z.string().uuid(), language: supportKbLanguageSchema.optional() }).strict())
      .output(supportKbAuthoredArticleSchema)
      .query(async ({ input }) => {
        const found = await book.getPublished(input.articleId);
        // An article holds one language; asking for another reads the same as not published in it.
        if (!found || (input.language !== undefined && found.language !== input.language))
          throw new TRPCError({ code: 'NOT_FOUND', message: 'support.kb.not_published' });
        return found;
      }),

    createKbCategory: scopedProcedure('support:ops')
      .input(createKbCategoryInputSchema)
      .output(supportKbCategorySchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return book.createCategory(input, ctx.principal!.userId, at()).catch(refuse);
      }),

    createKbSection: scopedProcedure('support:ops')
      .input(createKbSectionInputSchema)
      .output(supportKbSectionSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return book.createSection(input, ctx.principal!.userId, at()).catch(refuse);
      }),

    saveKbDraft: scopedProcedure('support:ops')
      .input(saveKbDraftInputSchema)
      .output(supportKbDraftSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return book.saveDraft(input, ctx.principal!.userId, at()).catch(refuse);
      }),

    getKbDraft: scopedProcedure('support:ops')
      .input(z.object({ articleId: z.string().uuid() }).strict())
      .output(supportKbDraftSchema.nullable())
      .query(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return book.getDraft(input.articleId);
      }),

    publishKbDraft: scopedProcedure('support:ops')
      .input(publishKbDraftInputSchema)
      .output(supportKbAuthoredArticleSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return book.publish(input.articleId, input.revision, ctx.principal!.userId, at()).catch(refuse);
      }),

    kbAuthoredVersions: scopedProcedure('support:ops')
      .input(z.object({ articleId: z.string().uuid() }).strict())
      .output(z.array(supportKbAuthoredArticleSchema))
      .query(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        return book.versions(input.articleId);
      }),
  };
}
