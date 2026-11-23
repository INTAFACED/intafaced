import type { OutreachPublicErrorCode } from '@intafaced/contracts';
import {
  crmQueueMessageInputSchema,
  crmQueueMessageReceiptSchema,
  crmMessageListInputSchema,
  crmMessagePageSchema,
} from '@intafaced/contracts/crm-notifications';
import { crmRetentionReviewStatusInputSchema, crmRetentionReviewSchema } from '@intafaced/contracts/crm-privacy';
import {
  crmMetricsInputSchema,
  crmMetricsSchema,
  crmMergeInputSchema,
  crmMergeReceiptSchema,
  crmContactProvenanceInputSchema,
  crmContactProvenanceSchema,
  crmExportInputSchema,
  crmExportPageSchema,
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
  crmOpportunitySchema,
  crmOpportunityDetailSchema,
  crmStageChangeInputSchema,
} from '@intafaced/contracts/outreach-crm';
import { router, publicProcedure, scopedProcedure } from '@intafaced/contracts/trpc';
import { OPS_OUTREACH_PUBLIC_SETTINGS } from '@intafaced/contracts/ops-public-procedures';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import type { OutreachCrm } from './crm.js';
import { OutreachError } from './config.js';
import type { FounderAuthority } from './authority.js';
import { PublicSettingsStaleError, publicChangesOf, type PublicSettingsBook } from './public-settings.js';
import {
  OPS_OUTREACH_PRIVACY_RETENTION_STATUS,
  OPS_OUTREACH_OWNERS,
  OPS_OUTREACH_LIST_WORKFLOW_AUDIT,
  OPS_OUTREACH_PRIVACY_PREVIEW,
  OPS_OUTREACH_PRIVACY_STATUS,
  OPS_OUTREACH_PRIVACY_RETENTION_REVIEW,
  OPS_OUTREACH_PRIVACY_BEGIN,
  OPS_OUTREACH_PRIVACY_ADVANCE,
  OPS_OUTREACH_LIST_OPPORTUNITIES,
  OPS_OUTREACH_ASSIGN,
  OPS_OUTREACH_UPDATE_NEXT_ACTION,
  OPS_OUTREACH_ADD_NOTE,
  OPS_OUTREACH_LIST_CAMPAIGNS,
  OPS_OUTREACH_LIST_SOURCE_MAPPINGS,
  OPS_OUTREACH_LIST_DUPLICATES,
  OPS_OUTREACH_LIST_TASKS,
  OPS_OUTREACH_DOCUMENT_PROVIDER_STATUS,
  OPS_OUTREACH_UPSERT_CAMPAIGN,
  OPS_OUTREACH_UPSERT_SOURCE_MAPPING,
  OPS_OUTREACH_CREATE_TASK,
  OPS_OUTREACH_TRANSITION_TASK,
  OPS_OUTREACH_RECORD_INTERACTION,
} from '@intafaced/contracts/ops-outreach-procedures';

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
    privacyPreview: mountRecord(
      OPS_OUTREACH_PRIVACY_PREVIEW,
      ({ input, ctx }) => mapped(() => crm.privacy.preview(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    privacyBegin: mountRecord(
      OPS_OUTREACH_PRIVACY_BEGIN,
      ({ input, ctx }) => mapped(() => crm.privacy.begin(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    privacyAdvance: mountRecord(
      OPS_OUTREACH_PRIVACY_ADVANCE,
      ({ input, ctx }) => mapped(() => crm.privacy.advance(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    privacyStatus: mountRecord(
      OPS_OUTREACH_PRIVACY_STATUS,
      ({ input, ctx }) => mapped(() => crm.privacy.status(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    privacyRetentionStatus: mountRecord(
      OPS_OUTREACH_PRIVACY_RETENTION_STATUS,
      ({ ctx }) => mapped(() => crm.privacy.retentionStatus(ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    privacyRetentionReviewStatus: staffRead
      .input(crmRetentionReviewStatusInputSchema)
      .output(crmRetentionReviewSchema.nullable())
      .query(({ input, ctx }) => mapped(() => crm.privacy.retentionReviewStatus(input, ctx.principal!.userId))),
    privacyRetentionReview: mountRecord(
      OPS_OUTREACH_PRIVACY_RETENTION_REVIEW,
      ({ input, ctx }) => mapped(() => crm.privacy.retentionReview(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
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
    listOpportunities: mountRecord(OPS_OUTREACH_LIST_OPPORTUNITIES, ({ input }) => mapped(() => crm.listOpportunities(input)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    getOpportunity: staffRead
      .input(z.object({ opportunityId: z.string().guid() }).strict())
      .output(crmOpportunityDetailSchema)
      .query(({ input }) => mapped(() => crm.getOpportunity(input))),
    assign: mountRecord(OPS_OUTREACH_ASSIGN, ({ input, ctx }) => mapped(() => crm.assign(input, ctx.principal!.userId)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    changeStage: staffWrite
      .input(crmStageChangeInputSchema)
      .output(crmOpportunitySchema)
      .mutation(({ input, ctx }) => mapped(() => crm.changeStage(input, ctx.principal!.userId))),
    updateNextAction: mountRecord(
      OPS_OUTREACH_UPDATE_NEXT_ACTION,
      ({ input, ctx }) => mapped(() => crm.updateNextAction(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    addNote: mountRecord(OPS_OUTREACH_ADD_NOTE, ({ input, ctx }) => mapped(() => crm.addNote(input, ctx.principal!.userId)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    owners: mountRecord(OPS_OUTREACH_OWNERS, () => mapped(async () => crm.owners()), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    listCampaigns: mountRecord(OPS_OUTREACH_LIST_CAMPAIGNS, ({ input, ctx }) => mapped(() => crm.listCampaigns(input)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    upsertCampaign: mountRecord(
      OPS_OUTREACH_UPSERT_CAMPAIGN,
      ({ input, ctx }) => mapped(() => crm.upsertCampaign(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    listSourceMappings: mountRecord(OPS_OUTREACH_LIST_SOURCE_MAPPINGS, ({ input, ctx }) => mapped(() => crm.listSourceMappings(input)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    upsertSourceMapping: mountRecord(
      OPS_OUTREACH_UPSERT_SOURCE_MAPPING,
      ({ input, ctx }) => mapped(() => crm.upsertSourceMapping(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    metrics: staffRead
      .input(crmMetricsInputSchema)
      .output(crmMetricsSchema)
      .query(({ input, ctx }) => mapped(() => crm.metrics(input))),
    listDuplicates: mountRecord(OPS_OUTREACH_LIST_DUPLICATES, ({ input, ctx }) => mapped(() => crm.listDuplicates(input)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
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
    listTasks: mountRecord(OPS_OUTREACH_LIST_TASKS, ({ input, ctx }) => mapped(() => crm.listTasks(input)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    createTask: mountRecord(OPS_OUTREACH_CREATE_TASK, ({ input, ctx }) => mapped(() => crm.createTask(input, ctx.principal!.userId)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    transitionTask: mountRecord(
      OPS_OUTREACH_TRANSITION_TASK,
      ({ input, ctx }) => mapped(() => crm.transitionTask(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    recordInteraction: mountRecord(
      OPS_OUTREACH_RECORD_INTERACTION,
      ({ input, ctx }) => mapped(() => crm.recordInteraction(input, ctx.principal!.userId)),
      {
        refusalOf: storageRefusal,
        checks: {
          authority: (ctx) =>
            mapped(async () => {
              await authority(ctx);
            }),
        },
      },
    ),
    queueMessage: staffWrite
      .input(crmQueueMessageInputSchema)
      .output(crmQueueMessageReceiptSchema)
      .mutation(({ input, ctx }) => mapped(() => crm.queueMessage(input, ctx.principal!.userId))),
    listMessages: staffRead
      .input(crmMessageListInputSchema)
      .output(crmMessagePageSchema)
      .query(({ input }) => mapped(() => crm.listMessages(input))),
    listWorkflowAudit: mountRecord(OPS_OUTREACH_LIST_WORKFLOW_AUDIT, ({ input, ctx }) => mapped(() => crm.listWorkflowAudit(input)), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
    documentProviderStatus: mountRecord(OPS_OUTREACH_DOCUMENT_PROVIDER_STATUS, () => papermarkFreeAdapter.status(), {
      refusalOf: storageRefusal,
      checks: {
        authority: (ctx) =>
          mapped(async () => {
            await authority(ctx);
          }),
      },
    }),
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
