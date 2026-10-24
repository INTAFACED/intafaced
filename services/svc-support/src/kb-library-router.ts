import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import {
  publicProcedure,
  scopedProcedure,
  supportKbArticleSchema,
  supportKbLibraryNameProblem,
  supportKbLibrarySchema,
  supportKbPublishTextInputSchema,
  supportKbSaveCategoryInputSchema,
  supportKbSaveSectionInputSchema,
  supportKbSectionReadInputSchema,
  SUPPORT_KB_CATEGORY_UNKNOWN,
  SUPPORT_KB_LIBRARY_INVALID,
  SUPPORT_KB_SECTION_UNKNOWN,
  type SupportKbArticle,
  type SupportKbLibrary,
} from '@intafaced/contracts';
import { KbCategoryUnknownError, type KbCategoryRow, type KbLibraryBook, type KbSectionRow } from './kb-library.js';
import { namesVendor } from './kb-catalog.js';
import { assertListKbLimit, kbViewerOf, requireSupportOps, type SupportService } from './support-service.js';

type Gate = (principal: Pick<Principal, 'scopes'> | null | undefined) => Promise<void>;

/** A section the reader may open: it and its category exist and neither is retired. */
async function openSection(book: KbLibraryBook, sectionId: string): Promise<{ section: KbSectionRow; category: KbCategoryRow } | null> {
  const section = await book.section(sectionId);
  if (!section || section.retired) return null;
  const category = (await book.categories()).find((row) => row.id === section.categoryId && !row.retired);
  return category ? { section, category } : null;
}

/** Category and section names are shown to readers, so they follow the same no-vendor rule as article text. */
function refuseName(name: string): void {
  if (supportKbLibraryNameProblem(name)) throw new TRPCError({ code: 'BAD_REQUEST', message: SUPPORT_KB_LIBRARY_INVALID });
  if (namesVendor(name)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'support.kb_vendor_name' });
}

const byTitle = (a: SupportKbArticle, b: SupportKbArticle) => (a.title ?? a.id).localeCompare(b.title ?? b.id) || a.id.localeCompare(b.id);

/**
 * The help library (SP-kb-01). `kbLibrary` and `kbSection` are public reads behind the help-centre switch; counts and
 * lists only hold published articles the reader may see. The desk saves categories and sections and publishes an
 * article typed as text into an open section.
 */
export function kbLibraryProcedures(
  book: KbLibraryBook,
  support: Pick<SupportService, 'listKbVisible' | 'publishKbText'>,
  helpCentreOpen: Gate,
  mapError: (err: unknown) => never,
) {
  return {
    kbLibrary: publicProcedure.output(supportKbLibrarySchema).query(async ({ ctx }): Promise<SupportKbLibrary> => {
      await helpCentreOpen(ctx.principal);
      const [categories, sections, articles] = await Promise.all([
        book.categories(),
        book.sections(),
        support.listKbVisible(kbViewerOf(ctx.principal)),
      ]);
      const counts = new Map<string, number>();
      for (const article of articles) if (article.sectionId) counts.set(article.sectionId, (counts.get(article.sectionId) ?? 0) + 1);
      return {
        categories: categories
          .filter((category) => !category.retired)
          .map((category) => ({
            id: category.id,
            name: category.name,
            position: category.position,
            sections: sections
              .filter((section) => section.categoryId === category.id && !section.retired)
              .map((section) => ({
                id: section.id,
                categoryId: section.categoryId,
                name: section.name,
                position: section.position,
                articleCount: counts.get(section.id) ?? 0,
              })),
          })),
      };
    }),

    kbSection: publicProcedure
      .input(supportKbSectionReadInputSchema)
      .output(
        z.object({
          category: z.object({ id: z.string(), name: z.string() }),
          section: z.object({ id: z.string(), name: z.string() }),
          articles: z.array(supportKbArticleSchema),
        }),
      )
      .query(async ({ ctx, input }) => {
        await helpCentreOpen(ctx.principal);
        try {
          const limit = assertListKbLimit(input.limit);
          const [open, visible] = await Promise.all([openSection(book, input.sectionId), support.listKbVisible(kbViewerOf(ctx.principal))]);
          if (!open) throw new TRPCError({ code: 'NOT_FOUND', message: SUPPORT_KB_SECTION_UNKNOWN });
          const articles = visible
            .filter((article) => article.sectionId === open.section.id)
            .sort(byTitle)
            .slice(0, limit);
          return {
            category: { id: open.category.id, name: open.category.name },
            section: { id: open.section.id, name: open.section.name },
            articles,
          };
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          mapError(err);
        }
      }),

    kbSaveCategory: scopedProcedure('support:ops')
      .input(supportKbSaveCategoryInputSchema)
      .output(z.object({ id: z.string(), name: z.string(), position: z.number().int(), retired: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        refuseName(input.name);
        return book.saveCategory(
          { id: input.id, name: input.name.trim(), position: input.position, retired: input.retired ?? false },
          { actorId: ctx.principal!.userId, reason: input.reason },
        );
      }),

    kbSaveSection: scopedProcedure('support:ops')
      .input(supportKbSaveSectionInputSchema)
      .output(z.object({ id: z.string(), categoryId: z.string(), name: z.string(), position: z.number().int(), retired: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        refuseName(input.name);
        try {
          return await book.saveSection(
            {
              id: input.id,
              categoryId: input.categoryId,
              name: input.name.trim(),
              position: input.position,
              retired: input.retired ?? false,
            },
            { actorId: ctx.principal!.userId, reason: input.reason },
          );
        } catch (err) {
          if (err instanceof KbCategoryUnknownError) throw new TRPCError({ code: 'NOT_FOUND', message: SUPPORT_KB_CATEGORY_UNKNOWN });
          throw err;
        }
      }),

    kbPublishText: scopedProcedure('support:ops')
      .input(supportKbPublishTextInputSchema)
      .output(supportKbArticleSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        // Checked here for a clear refusal, and again under a lock where the version is written.
        if (!(await openSection(book, input.sectionId))) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: SUPPORT_KB_SECTION_UNKNOWN });
        }
        try {
          return await support.publishKbText(input);
        } catch (err) {
          mapError(err);
        }
      }),
  };
}
