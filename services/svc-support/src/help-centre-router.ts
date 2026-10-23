import { TRPCError } from '@trpc/server';
import {
  publicProcedure,
  scopedProcedure,
  supportHelpCentreLanguageInputSchema,
  supportHelpCentreLanguageSchema,
  supportHelpCentreSchema,
  supportHelpCentreSetInputSchema,
  supportHelpCentreTranslationListInputSchema,
  supportHelpCentreTranslationListSchema,
  supportHelpCentreTranslationSchema,
  supportHelpCentreTranslationSetInputSchema,
  SUPPORT_HELP_CENTRE_REVISION_STALE,
  SUPPORT_HELP_CENTRE_SETTING_INVALID,
  SUPPORT_LANGUAGES_UNSET,
  SUPPORT_HELP_CENTRE_LIST_LIMIT_UNSET,
} from '@intafaced/contracts';
import {
  HelpCentreInvalidError,
  HelpCentreLanguagesUnsetError,
  HelpCentreLimitUnsetError,
  HelpCentreNotFoundError,
  HelpCentreStaleError,
  helpCentreChangesOf,
  type HelpCentreBook,
} from './help-centre.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * `helpCentre` is the public read (SP-help-centre-03): a signed-out visitor reads it, and a blank switch is `null`,
 * not on and not off. `setHelpCentre` is the lead write. `helpCentreLanguage` refuses `support.languages_unset` when
 * a reader names a language and the owner has offered none. The settings scope `support:admin` does not exist yet;
 * until it lands a staff lead is the existing control for desk configuration.
 */
export function helpCentreProcedures(book: HelpCentreBook, support: Pick<SupportService, 'listStaff'>) {
  return {
    helpCentre: publicProcedure.output(supportHelpCentreSchema).query(() => book.get()),

    setHelpCentre: scopedProcedure('support:ops')
      .input(supportHelpCentreSetInputSchema)
      .output(supportHelpCentreSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        await requireLead(support, ctx.principal!.userId);
        try {
          return await book.set({
            changes: helpCentreChangesOf(input),
            expectedRevision: input.expectedRevision,
            by: ctx.principal!.userId,
            reason: input.reason,
            at: new Date().toISOString(),
          });
        } catch (err) {
          throw mapHelpCentre(err);
        }
      }),

    helpCentreLanguage: publicProcedure
      .input(supportHelpCentreLanguageInputSchema)
      .output(supportHelpCentreLanguageSchema)
      .query(async ({ input }) => {
        try {
          return await book.language(input);
        } catch (err) {
          throw mapHelpCentre(err);
        }
      }),

    setHelpCentreTranslation: scopedProcedure('support:ops')
      .input(supportHelpCentreTranslationSetInputSchema)
      .output(supportHelpCentreTranslationSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        try {
          return await book.setTranslation({ ...input, by: ctx.principal!.userId, at: new Date().toISOString() });
        } catch (err) {
          throw mapHelpCentre(err);
        }
      }),

    helpCentreTranslations: scopedProcedure('support:ops')
      .input(supportHelpCentreTranslationListInputSchema)
      .output(supportHelpCentreTranslationListSchema)
      .query(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        try {
          return await book.listTranslations(input.limit);
        } catch (err) {
          throw mapHelpCentre(err);
        }
      }),
  };
}

async function requireLead(support: Pick<SupportService, 'listStaff'>, actorId: string): Promise<void> {
  const actor = (await support.listStaff()).find((member) => member.userId === actorId);
  if (actor?.role !== 'lead') {
    throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_lead') });
  }
}

function mapHelpCentre(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof HelpCentreStaleError) {
    return new TRPCError({ code: 'CONFLICT', message: SUPPORT_HELP_CENTRE_REVISION_STALE, cause: err });
  }
  if (err instanceof HelpCentreInvalidError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: SUPPORT_HELP_CENTRE_SETTING_INVALID, cause: err });
  }
  if (err instanceof HelpCentreLanguagesUnsetError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: SUPPORT_LANGUAGES_UNSET, cause: err });
  }
  if (err instanceof HelpCentreLimitUnsetError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: SUPPORT_HELP_CENTRE_LIST_LIMIT_UNSET, cause: err });
  }
  if (err instanceof HelpCentreNotFoundError) {
    return new TRPCError({ code: 'NOT_FOUND', message: 'support.not_found', cause: err });
  }
  throw err;
}
