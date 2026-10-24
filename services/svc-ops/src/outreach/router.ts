import * as workflow from '@intafaced/contracts';
import { papermarkFreeAdapter } from './document-provider.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  router,
  publicProcedure,
  scopedProcedure,
  outreachCaptureInputSchema,
  outreachCaptureReceiptSchema,
  outreachContinuationInputSchema,
  outreachDraftSchema,
  outreachQuestionnaireInputSchema,
  crmListInputSchema,
  crmOpportunitySchema,
  crmOpportunityPageSchema,
  crmAssignmentInputSchema,
  crmStageChangeInputSchema,
  crmNextActionInputSchema,
  crmNoteInputSchema,
  crmActivitySchema,
  type Context,
} from '@intafaced/contracts';
import type { OutreachCrm } from './crm.js';
import { OutreachError } from './config.js';
import type { FounderAuthority } from './authority.js';
import { PublicSettingsStaleError, publicChangesOf, type PublicSettingsBook } from './public-settings.js';

function abuseKey(ctx: Context): string {
  const key = (ctx as Context & { outreachAbuseKey?: string }).outreachAbuseKey;
  if (!key) throw new OutreachError('ops.crm.abuse_context_unavailable');
  return key;
}
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OutreachError) {
      let code: 'FORBIDDEN' | 'TOO_MANY_REQUESTS' | 'PRECONDITION_FAILED' = 'PRECONDITION_FAILED';
      if (error.code === 'ops.crm.operator_forbidden') code = 'FORBIDDEN';
      if (error.code === 'ops.crm.rate_limited') code = 'TOO_MANY_REQUESTS';
      throw new TRPCError({
        code,
        message: error.code,
        cause: error,
      });
    }
    throw error;
  }
}
/** The public settings store, or a refusal that names why there is none (svc-ops runs without its database). */
function settingsBook(book: PublicSettingsBook | undefined): PublicSettingsBook {
  if (!book) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'ops.crm.storage_unconfigured' });
  return book;
}

export function createOutreachRouter(crm: OutreachCrm, authority: FounderAuthority, publicSettings?: PublicSettingsBook) {
  const staffRead = scopedProcedure('ops:read').use(async ({ ctx, next }) =>
    mapped(async () => {
      await authority(ctx);
      return next({ ctx });
    }),
  );
  const staffWrite = scopedProcedure('ops:write').use(async ({ ctx, next }) =>
    mapped(async () => {
      await authority(ctx);
      return next({ ctx });
    }),
  );
  return router({
    privacyPreview: staffRead
      .input(workflow.crmErasurePreviewInputSchema)
      .output(workflow.crmErasurePreviewSchema)
      .query(({ input, ctx }) => mapped(() => crm.privacy.preview(input, ctx.principal!.userId))),
    privacyBegin: staffWrite
      .input(workflow.crmErasureBeginInputSchema)
      .output(workflow.crmErasureStatusSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.privacy.begin(input, ctx.principal!.userId))),
    privacyAdvance: staffWrite
      .input(workflow.crmErasureAdvanceInputSchema)
      .output(workflow.crmErasureStatusSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.privacy.advance(input, ctx.principal!.userId))),
    privacyStatus: staffRead
      .input(workflow.crmErasureStatusInputSchema)
      .output(workflow.crmErasureStatusSchema)
      .query(({ input, ctx }) => mapped(() => crm.privacy.status(input, ctx.principal!.userId))),
    privacyRetentionStatus: staffRead
      .output(workflow.crmRetentionStatusSchema)
      .query(({ ctx }) => mapped(() => crm.privacy.retentionStatus(ctx.principal!.userId))),
    privacyRetentionReviewStatus: staffRead
      .input(workflow.crmRetentionReviewStatusInputSchema)
      .output(workflow.crmRetentionReviewSchema.nullable())
      .query(({ input, ctx }) => mapped(() => crm.privacy.retentionReviewStatus(input, ctx.principal!.userId))),
    privacyRetentionReview: staffWrite
      .input(workflow.crmRetentionReviewInputSchema)
      .output(workflow.crmRetentionReviewSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.privacy.retentionReview(input, ctx.principal!.userId))),
    capture: publicProcedure
      .input(outreachCaptureInputSchema)
      .output(outreachCaptureReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.capture(input, abuseKey(ctx)))),
    resume: publicProcedure
      .input(outreachContinuationInputSchema)
      .output(outreachDraftSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.resume(input, abuseKey(ctx)))),
    answer: publicProcedure
      .input(outreachQuestionnaireInputSchema)
      .output(outreachDraftSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.answer(input, abuseKey(ctx)))),
    addInterests: publicProcedure
      .input(workflow.outreachAddInterestsInputSchema)
      .output(outreachDraftSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.addInterests(input, abuseKey(ctx)))),
    listOpportunities: staffRead
      .input(crmListInputSchema)
      .output(crmOpportunityPageSchema)
      .query(({ input }) => mapped(() => crm.listOpportunities(input))),
    getOpportunity: staffRead
      .input(z.object({ opportunityId: z.string().guid() }).strict())
      .query(({ input }) => mapped(() => crm.getOpportunity(input))),
    assign: staffWrite
      .input(crmAssignmentInputSchema)
      .output(crmOpportunitySchema)
      .mutation(({ input, ctx }) => mapped(() => crm.assign(input, ctx.principal!.userId))),
    changeStage: staffWrite
      .input(crmStageChangeInputSchema)
      .output(crmOpportunitySchema)
      .mutation(({ input, ctx }) => mapped(() => crm.changeStage(input, ctx.principal!.userId))),
    updateNextAction: staffWrite
      .input(crmNextActionInputSchema)
      .output(crmOpportunitySchema)
      .mutation(({ input, ctx }) => mapped(() => crm.updateNextAction(input, ctx.principal!.userId))),
    addNote: staffWrite
      .input(crmNoteInputSchema)
      .output(crmActivitySchema)
      .mutation(({ input, ctx }) => mapped(() => crm.addNote(input, ctx.principal!.userId))),
    owners: staffRead
      .output(
        z
          .object({
            ownerUserIds: z.array(z.string().guid()).length(2),
            initialOwnerUserId: z.string().guid(),
            owners: z.tuple([
              z.object({ userId: z.string().guid(), displayName: z.literal('Nitro') }).strict(),
              z.object({ userId: z.string().guid(), displayName: z.literal('Phantom') }).strict(),
            ]),
          })
          .strict(),
      )
      .query(() => mapped(async () => crm.owners())),
    listCampaigns: staffRead
      .input(workflow.crmCampaignListInputSchema)
      .output(workflow.crmCampaignPageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listCampaigns(input))),
    upsertCampaign: staffWrite
      .input(workflow.crmCampaignWriteInputSchema)
      .output(workflow.crmCampaignSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.upsertCampaign(input, ctx.principal!.userId))),
    listSourceMappings: staffRead
      .input(workflow.crmSourceMappingListInputSchema)
      .output(workflow.crmSourceMappingPageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listSourceMappings(input))),
    upsertSourceMapping: staffWrite
      .input(workflow.crmSourceMappingWriteInputSchema)
      .output(workflow.crmSourceMappingSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.upsertSourceMapping(input, ctx.principal!.userId))),
    metrics: staffRead
      .input(workflow.crmMetricsInputSchema)
      .output(workflow.crmMetricsSchema)
      .query(({ input, ctx }) => mapped(() => crm.metrics(input))),
    listDuplicates: staffRead
      .input(workflow.crmDuplicateListInputSchema)
      .output(workflow.crmDuplicatePageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listDuplicates(input))),
    mergeContacts: staffWrite
      .input(workflow.crmMergeInputSchema)
      .output(workflow.crmMergeReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.mergeContacts(input, ctx.principal!.userId))),
    getContactProvenance: staffRead
      .input(workflow.crmContactProvenanceInputSchema)
      .output(workflow.crmContactProvenanceSchema.nullable())
      .query(({ input, ctx }) => mapped(() => crm.getContactProvenance(input))),
    exportSubmissions: staffRead
      .input(workflow.crmExportInputSchema)
      .output(workflow.crmExportPageSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.exportSubmissions(input, ctx.principal!.userId))),
    listTasks: staffRead
      .input(workflow.crmTaskListInputSchema)
      .output(workflow.crmTaskPageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listTasks(input))),
    createTask: staffWrite
      .input(workflow.crmTaskCreateInputSchema)
      .output(workflow.crmTaskMutationReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.createTask(input, ctx.principal!.userId))),
    transitionTask: staffWrite
      .input(workflow.crmTaskTransitionInputSchema)
      .output(workflow.crmTaskMutationReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.transitionTask(input, ctx.principal!.userId))),
    recordInteraction: staffWrite
      .input(workflow.crmInteractionInputSchema)
      .output(workflow.crmInteractionReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.recordInteraction(input, ctx.principal!.userId))),
    queueMessage: staffWrite
      .input(workflow.crmQueueMessageInputSchema)
      .output(workflow.crmQueueMessageReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.queueMessage(input, ctx.principal!.userId))),
    listMessages: staffRead
      .input(workflow.crmMessageListInputSchema)
      .output(workflow.crmMessagePageSchema)
      .query(({ input }) => mapped(() => crm.listMessages(input))),
    listWorkflowAudit: staffRead
      .input(workflow.crmWorkflowAuditListInputSchema)
      .output(workflow.crmWorkflowAuditPageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listWorkflowAudit(input))),
    documentProviderStatus: staffRead.output(workflow.crmDocumentProviderStatusSchema).query(() => papermarkFreeAdapter.status()),
    documentViews: staffRead
      .input(workflow.crmDocumentProviderReadInputSchema)
      .output(workflow.crmDocumentProviderReadResultSchema)
      .query(({ input }) => papermarkFreeAdapter.readViews(input)),
    engagement: staffRead
      .output(z.object({ status: z.literal('disabled'), reason: z.literal('api_access_unavailable') }))
      .query(() => ({ status: 'disabled' as const, reason: 'api_access_unavailable' as const })),
    // SP-pages-02: the public partner page reads where the invitation site is served and the programme terms. A blank
    // value is null, never an error; a founder sets them with a reason, from the revision they read.
    publicSettings: publicProcedure
      .output(workflow.outreachPublicSettingsSchema)
      .query(() => mapped(() => settingsBook(publicSettings).get())),
    setPublicSettings: staffWrite
      .input(workflow.outreachPublicSettingsSetInputSchema)
      .output(workflow.outreachPublicSettingsSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          return await mapped(() =>
            settingsBook(publicSettings).set({
              changes: publicChangesOf(input),
              expectedRevision: input.expectedRevision,
              by: ctx.principal!.userId,
              reason: input.reason,
              at: new Date().toISOString(),
            }),
          );
        } catch (err) {
          if (err instanceof PublicSettingsStaleError) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'ops.public_settings_revision_stale' satisfies workflow.OutreachPublicErrorCode,
              cause: err,
            });
          }
          throw err;
        }
      }),
  });
}
