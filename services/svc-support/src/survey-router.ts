import { TRPCError } from '@trpc/server';
import { scopedProcedure, supportSurveyConfigureInputSchema, supportSurveyListSchema, supportSurveySchema } from '@intafaced/contracts';
import { SurveyCapError, SurveyNotFoundError, SurveyStaleError, type SurveyBook } from './survey-settings.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * SP-csat-02: `surveys` is the operator read (cap unset with its code, and the surveys); `configureSurvey` is the lead's
 * write from the revision they read. As for the attachment settings, the lead role is the control until a settings
 * scope exists. A new survey is refused at the owner cap (`support.survey_cap_reached`) or past the first when the cap is blank (`support.survey_cap_unset`).
 */
export function surveyProcedures(book: SurveyBook, support: Pick<SupportService, 'listStaff'>) {
  return {
    surveys: scopedProcedure('support:ops')
      .output(supportSurveyListSchema)
      .query(({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return book.list();
      }),

    configureSurvey: scopedProcedure('support:ops')
      .input(supportSurveyConfigureInputSchema)
      .output(supportSurveySchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        const actorId = ctx.principal!.userId;
        const actor = (await support.listStaff()).find((member) => member.userId === actorId);
        if (actor?.role !== 'lead') throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_lead') });
        try {
          return await book.configure({ ...input, by: actorId, at: new Date().toISOString() });
        } catch (err) {
          if (err instanceof SurveyCapError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.code, cause: err });
          if (err instanceof SurveyStaleError) throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
          if (err instanceof SurveyNotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
          throw err;
        }
      }),
  };
}
