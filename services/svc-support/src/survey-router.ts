import { TRPCError } from '@trpc/server';
import {
  SUPPORT_SURVEY_EMAIL_DELIVERY,
  scopedProcedure,
  supportSurveyConfigureInputSchema,
  supportSurveyListViewSchema,
  supportSurveyViewSchema,
  type SupportSurveyConfigureInput,
} from '@intafaced/contracts';
import { SurveyCapError, SurveyIdConflictError, SurveyNotFoundError, SurveyStaleError, type SurveyBook } from './survey-settings.js';
import {
  ActionApprovalConsumeError,
  readApprovalIds,
  supportActionPayloadHash,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * SP-csat-02: `surveys` is the operator read (cap unset with its code, and the surveys); `configureSurvey` is the lead's
 * write from the revision they read. As for the attachment settings, the lead role is the control until a settings
 * scope exists. A new survey is refused at the owner cap (`support.survey_cap_reached`) or past the first when the cap is blank (`support.survey_cap_unset`).
 */
/** Action type the approval is bound to (identity `targetId`). */
export const SURVEY_CONFIGURE_ACTION = 'support.survey.configure' as const;

/** Payload the founder approved: the exact configure, so an approval for one change cannot carry another. */
export function surveyConfigurePayloadHash(input: SupportSurveyConfigureInput): string {
  return supportActionPayloadHash(SURVEY_CONFIGURE_ACTION, {
    surveyId: input.surveyId ?? 'new',
    newSurveyId: input.newSurveyId ?? '',
    expectedRevision: String(input.expectedRevision),
    config: JSON.stringify(input.config),
    reason: input.reason,
  });
}

/**
 * Dual control (spec Security row :58, owner decision D101): `configureSurvey` consumes an identity-issued action
 * approval bound to this action and payload. svc-support is not an operator target in identity, so the approver is a
 * founder. The approver must not be the caller; the approver and approval id are written to the audit row with the reason.
 */
export function surveyProcedures(
  book: SurveyBook,
  support: Pick<SupportService, 'listStaff'>,
  approvals: ActionApprovalConsumer = unwiredApprovalConsumer(),
) {
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
        let approvedBy: string;
        try {
          const ids = readApprovalIds(input);
          const payloadHash = surveyConfigurePayloadHash(input);
          const consumed = await approvals.consume({
            approvalId: ids.approvalId,
            operationId: ids.operationId,
            payloadHash,
            targetService: 'svc-support',
            targetId: SURVEY_CONFIGURE_ACTION,
            expectedVersion: '1',
          });
          if (
            consumed.targetService !== 'svc-support' ||
            consumed.targetId !== SURVEY_CONFIGURE_ACTION ||
            consumed.payloadHash !== payloadHash ||
            consumed.approvalId !== ids.approvalId ||
            consumed.status !== 'CONSUMED'
          ) {
            throw new ActionApprovalConsumeError('the approval is for a different action', 'action_approval.consume_failed');
          }
          if (!consumed.approverId || consumed.approverId === actorId) {
            throw new ActionApprovalConsumeError(
              'a second person must approve; self-approval is refused',
              'action_approval.consume_failed',
            );
          }
          approvedBy = consumed.approverId;
        } catch (err) {
          if (err instanceof ActionApprovalConsumeError) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} [${err.code}]`, cause: err });
          }
          throw err;
        }
        try {
          const survey = await book.configure({ ...input, by: actorId, approvedBy, at: new Date().toISOString() });
          return { ...survey, emailDelivery: SUPPORT_SURVEY_EMAIL_DELIVERY };
        } catch (err) {
          // User copy on `message`; the machine code rides on `cause.code`.
          if (err instanceof SurveyCapError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(err.code), cause: err });
          if (err instanceof SurveyIdConflictError) throw new TRPCError({ code: 'CONFLICT', message: userCopy(err.code), cause: err });
          if (err instanceof SurveyStaleError) throw new TRPCError({ code: 'CONFLICT', message: userCopy(err.code), cause: err });
          if (err instanceof SurveyNotFoundError) throw new TRPCError({ code: 'NOT_FOUND', message: userCopy(err.code), cause: err });
          throw err;
        }
      }),
  };
}
