import { TRPCError } from '@trpc/server';
import {
  SUPPORT_SURVEY_EMAIL_DELIVERY,
  scopedProcedure,
  supportSurveyConfigureInputSchema,
  supportSurveyListViewSchema,
  supportSurveyViewSchema,
} from '@intafaced/contracts';
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
      .output(supportSurveyListViewSchema)
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return { ...(await book.list()), emailDelivery: SUPPORT_SURVEY_EMAIL_DELIVERY };
      }),

    configureSurvey: scopedProcedure('support:ops')
      .input(supportSurveyConfigureInputSchema)
      .output(supportSurveyViewSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        const actorId = ctx.principal!.userId;
        const actor = (await support.listStaff()).find((member) => member.userId === actorId);
        if (actor?.role !== 'lead') throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_lead') });
        try {
          const survey = await book.configure({ ...input, by: actorId, at: new Date().toISOString() });
          return { ...survey, emailDelivery: SUPPORT_SURVEY_EMAIL_DELIVERY };
        } catch (err) {
          // User copy on `message`; the machine code rides on `cause.code`.
          if (err instanceof SurveyCapError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(err.code), cause: err });
          if (err instanceof SurveyStaleError) throw new TRPCError({ code: 'CONFLICT', message: userCopy(err.code), cause: err });
          if (err instanceof SurveyNotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: userCopy(err.code), cause: err });
          throw err;
        }
      }),
  };
}
