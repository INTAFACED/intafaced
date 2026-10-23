import type { Principal } from '@intafaced/auth';
import { z } from 'zod';
import { supportKbArticleSchema, publicProcedure, scopedProcedure } from '@intafaced/contracts';
import { SEARCH_QUERY_CONTRACT_MAX } from './kb-feedback.js';
import { requireSupportOps, type SupportService } from './support-service.js';

const voteOutput = z.object({
  articleId: z.string(),
  version: z.number().int().positive(),
  helpful: z.boolean(),
});

const readerToken = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);

/**
 * SP-kb-03 procedures that the existing help screen does not call yet:
 * a signed-out vote, the desk's counts and miss list, a result click, and the
 * answer panel. `kbFeedback` itself stays on the main router so its input can
 * grow a comment and a request without moving the procedure the screen calls.
 */
export function kbFeedbackProcedures(
  support: SupportService,
  mapError: (err: unknown) => never,
  helpCentreOpen: (principal: Pick<Principal, 'scopes'> | null | undefined) => Promise<void> = async () => {},
) {
  return {
    /** Signed-out vote. Blank rate refuses and stores nothing. The token is not returned. */
    kbFeedbackPublic: publicProcedure
      .input(
        z.object({
          id: z.string().min(1).max(200),
          helpful: z.boolean(),
          clientRequestId: z.string().min(1).max(200),
          readerToken,
        }),
      )
      .output(voteOutput)
      .mutation(async ({ input }) => {
        await helpCentreOpen(null);
        try {
          return await support.kbFeedbackPublic(input);
        } catch (err) {
          mapError(err);
        }
      }),

    /** Helpful and unhelpful counts. support:ops. No reader id in the rows. */
    kbFeedbackSummary: scopedProcedure('support:ops')
      .input(z.object({ limit: z.number().int().positive().max(500).optional() }).optional())
      .output(
        z.array(
          z.object({
            articleId: z.string(),
            version: z.number().int().positive(),
            helpful: z.number().int().nonnegative(),
            unhelpful: z.number().int().nonnegative(),
          }),
        ),
      )
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.kbFeedbackSummary({ limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Searches that found nothing. support:ops. No reader id. */
    kbSearchMisses: scopedProcedure('support:ops')
      .input(z.object({ limit: z.number().int().positive().max(500).optional() }).optional())
      .output(z.array(z.object({ query: z.string(), at: z.string().datetime(), resultCount: z.literal(0) })))
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await support.kbSearchMisses({ limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    /** One click per request id, only on an article this caller may see. */
    kbSearchClick: publicProcedure
      .input(
        z.object({
          articleId: z.string().min(1).max(200),
          query: z.string().min(1).max(SEARCH_QUERY_CONTRACT_MAX),
          clientRequestId: z.string().min(1).max(200),
        }),
      )
      .output(z.object({ recorded: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          await helpCentreOpen(ctx.principal);
          return await support.kbSearchClick({
            ...input,
            viewer: { signedIn: Boolean(ctx.principal), staff: Boolean(ctx.principal?.scopes.includes('support:ops')) },
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Answer panel. A blank model refuses `support.assistant_model_unset`.
     * The body is the ranked articles and nothing else: no provider name.
     */
    kbAnswer: publicProcedure
      .input(
        z
          .object({
            q: z.string().max(SEARCH_QUERY_CONTRACT_MAX).optional(),
            limit: z.number().int().positive().max(500).optional(),
          })
          .optional(),
      )
      .output(z.object({ sources: z.array(supportKbArticleSchema) }))
      .query(async ({ ctx, input }) => {
        try {
          await helpCentreOpen(ctx.principal);
          return await support.kbAnswer(input?.q ?? '', {
            limit: input?.limit,
            viewer: { signedIn: Boolean(ctx.principal), staff: Boolean(ctx.principal?.scopes.includes('support:ops')) },
          });
        } catch (err) {
          mapError(err);
        }
      }),
  };
}
