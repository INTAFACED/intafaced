import type { OutreachPublicErrorCode } from '@intafaced/contracts';
import {
  crmQueueMessageInputSchema,
  crmQueueMessageReceiptSchema,
  crmMessageListInputSchema,
  crmMessagePageSchema,
} from '@intafaced/contracts/crm-notifications';
import {
  crmErasurePreviewInputSchema,
  crmErasurePreviewSchema,
  crmErasureBeginInputSchema,
  crmErasureStatusSchema,
  crmErasureAdvanceInputSchema,
  crmErasureStatusInputSchema,
  crmRetentionStatusSchema,
  crmRetentionReviewStatusInputSchema,
  crmRetentionReviewSchema,
  crmRetentionReviewInputSchema,
} from '@intafaced/contracts/crm-privacy';
import {
  crmCampaignListInputSchema,
  crmCampaignPageSchema,
  crmCampaignWriteInputSchema,
  crmCampaignSchema,
  crmSourceMappingListInputSchema,
  crmSourceMappingPageSchema,
  crmSourceMappingWriteInputSchema,
  crmSourceMappingSchema,
  crmMetricsInputSchema,
  crmMetricsSchema,
  crmDuplicateListInputSchema,
  crmDuplicatePageSchema,
  crmMergeInputSchema,
  crmMergeReceiptSchema,
  crmContactProvenanceInputSchema,
  crmContactProvenanceSchema,
  crmExportInputSchema,
  crmExportPageSchema,
  crmTaskListInputSchema,
  crmTaskPageSchema,
  crmTaskCreateInputSchema,
  crmTaskMutationReceiptSchema,
  crmTaskTransitionInputSchema,
  crmInteractionInputSchema,
  crmInteractionReceiptSchema,
  crmWorkflowAuditListInputSchema,
  crmWorkflowAuditPageSchema,
  crmDocumentProviderStatusSchema,
  crmDocumentProviderReadInputSchema,
  crmDocumentProviderReadResultSchema,
} from '@intafaced/contracts/crm-workflows';
import { outreachAddInterestsInputSchema } from '@intafaced/contracts/outreach-interests';
import { outreachPublicSettingsSetInputSchema, outreachPublicSettingsSchema } from '@intafaced/contracts/outreach-public';
import { papermarkFreeAdapter } from './document-provider.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from '@intafaced/contracts';
import {
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
} from '@intafaced/contracts/outreach-crm';
import { router, publicProcedure, scopedProcedure } from '@intafaced/contracts/trpc';
import { OPS_OUTREACH_PUBLIC_SETTINGS } from '@intafaced/contracts/ops-public-procedures';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
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

/**
 * The public read's one named refusal, as `settingsBook` and `mapped` already shape it: PRECONDITION_FAILED with the code
 * as its message. Passed on unchanged; any other error leaves as it did.
 */
const storageRefusal: RefusalOf = (err) =>
  err instanceof TRPCError && err.message === 'ops.crm.storage_unconfigured' ? { code: err.message, error: err } : undefined;

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
      .input(crmErasurePreviewInputSchema)
      .output(crmErasurePreviewSchema)
      .query(({ input, ctx }) => mapped(() => crm.privacy.preview(input, ctx.principal!.userId))),
    privacyBegin: staffWrite
      .input(crmErasureBeginInputSchema)
      .output(crmErasureStatusSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.privacy.begin(input, ctx.principal!.userId))),
    privacyAdvance: staffWrite
      .input(crmErasureAdvanceInputSchema)
      .output(crmErasureStatusSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.privacy.advance(input, ctx.principal!.userId))),
    privacyStatus: staffRead
      .input(crmErasureStatusInputSchema)
      .output(crmErasureStatusSchema)
      .query(({ input, ctx }) => mapped(() => crm.privacy.status(input, ctx.principal!.userId))),
    privacyRetentionStatus: staffRead
      .output(crmRetentionStatusSchema)
      .query(({ ctx }) => mapped(() => crm.privacy.retentionStatus(ctx.principal!.userId))),
    privacyRetentionReviewStatus: staffRead
      .input(crmRetentionReviewStatusInputSchema)
      .output(crmRetentionReviewSchema.nullable())
      .query(({ input, ctx }) => mapped(() => crm.privacy.retentionReviewStatus(input, ctx.principal!.userId))),
    privacyRetentionReview: staffWrite
      .input(crmRetentionReviewInputSchema)
      .output(crmRetentionReviewSchema)
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
      .input(outreachAddInterestsInputSchema)
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
      .input(crmCampaignListInputSchema)
      .output(crmCampaignPageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listCampaigns(input))),
    upsertCampaign: staffWrite
      .input(crmCampaignWriteInputSchema)
      .output(crmCampaignSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.upsertCampaign(input, ctx.principal!.userId))),
    listSourceMappings: staffRead
      .input(crmSourceMappingListInputSchema)
      .output(crmSourceMappingPageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listSourceMappings(input))),
    upsertSourceMapping: staffWrite
      .input(crmSourceMappingWriteInputSchema)
      .output(crmSourceMappingSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.upsertSourceMapping(input, ctx.principal!.userId))),
    metrics: staffRead
      .input(crmMetricsInputSchema)
      .output(crmMetricsSchema)
      .query(({ input, ctx }) => mapped(() => crm.metrics(input))),
    listDuplicates: staffRead
      .input(crmDuplicateListInputSchema)
      .output(crmDuplicatePageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listDuplicates(input))),
    mergeContacts: staffWrite
      .input(crmMergeInputSchema)
      .output(crmMergeReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.mergeContacts(input, ctx.principal!.userId))),
    getContactProvenance: staffRead
      .input(crmContactProvenanceInputSchema)
      .output(crmContactProvenanceSchema.nullable())
      .query(({ input, ctx }) => mapped(() => crm.getContactProvenance(input))),
    exportSubmissions: staffRead
      .input(crmExportInputSchema)
      .output(crmExportPageSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.exportSubmissions(input, ctx.principal!.userId))),
    listTasks: staffRead
      .input(crmTaskListInputSchema)
      .output(crmTaskPageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listTasks(input))),
    createTask: staffWrite
      .input(crmTaskCreateInputSchema)
      .output(crmTaskMutationReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.createTask(input, ctx.principal!.userId))),
    transitionTask: staffWrite
      .input(crmTaskTransitionInputSchema)
      .output(crmTaskMutationReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.transitionTask(input, ctx.principal!.userId))),
    recordInteraction: staffWrite
      .input(crmInteractionInputSchema)
      .output(crmInteractionReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.recordInteraction(input, ctx.principal!.userId))),
    queueMessage: staffWrite
      .input(crmQueueMessageInputSchema)
      .output(crmQueueMessageReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.queueMessage(input, ctx.principal!.userId))),
    listMessages: staffRead
      .input(crmMessageListInputSchema)
      .output(crmMessagePageSchema)
      .query(({ input }) => mapped(() => crm.listMessages(input))),
    listWorkflowAudit: staffRead
      .input(crmWorkflowAuditListInputSchema)
      .output(crmWorkflowAuditPageSchema)
      .query(({ input, ctx }) => mapped(() => crm.listWorkflowAudit(input))),
    documentProviderStatus: staffRead.output(crmDocumentProviderStatusSchema).query(() => papermarkFreeAdapter.status()),
    documentViews: staffRead
      .input(crmDocumentProviderReadInputSchema)
      .output(crmDocumentProviderReadResultSchema)
      .query(({ input }) => papermarkFreeAdapter.readViews(input)),
    engagement: staffRead
      .output(z.object({ status: z.literal('disabled'), reason: z.literal('api_access_unavailable') }))
      .query(() => ({ status: 'disabled' as const, reason: 'api_access_unavailable' as const })),
    // SP-pages-02: the public partner page reads where the invitation site is served and the programme terms. A blank
    // value is null, never an error; a founder sets them with a reason, from the revision they read.
    publicSettings: mountRecord(OPS_OUTREACH_PUBLIC_SETTINGS, () => mapped(() => settingsBook(publicSettings).get()), storageRefusal),
    setPublicSettings: staffWrite
      .input(outreachPublicSettingsSetInputSchema)
      .output(outreachPublicSettingsSchema)
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
              message: 'ops.public_settings_revision_stale' satisfies OutreachPublicErrorCode,
              cause: err,
            });
          }
          throw err;
        }
      }),
  });
}
