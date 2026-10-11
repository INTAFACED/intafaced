import { z } from 'zod';
import {
  outreachAudienceSchema,
  crmOpportunityStageSchema,
  crmContactSchema,
  crmSubmissionSchema,
  crmTaskSchema,
  crmActivitySchema,
  crmOpportunitySchema,
  outreachContactCaptureSchema,
} from './outreach-crm.js';

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const revision = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const text = z.string().trim().min(1).max(160);
const reason = z.string().trim().min(1).max(2000);
const sourceKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const cursor = z.string().min(1).max(512);
const nextAction = z.object({ description: text, dueAt: timestamp }).strict();
const evidenceRef = z.string().trim().min(1).max(128);

/** Source mapping is campaign evidence, never verified recipient or email ownership. */
export const crmCampaignSchema = z
  .object({
    id,
    revision,
    name: text,
    channel: text,
    status: z.enum(['active', 'disabled']),
    documentRef: evidenceRef.nullable(),
    providerLinkId: evidenceRef.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const crmCampaignWriteInputSchema = z
  .object({
    requestId: id,
    id,
    expectedRevision: count,
    name: text,
    channel: text,
    status: z.enum(['active', 'disabled']),
    documentRef: evidenceRef.nullable(),
    providerLinkId: evidenceRef.nullable(),
    reason,
  })
  .strict();
export const crmSourceMappingSchema = z
  .object({
    id,
    revision,
    sourceKey,
    campaignId: id,
    status: z.enum(['active', 'disabled']),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const crmSourceMappingWriteInputSchema = z
  .object({
    requestId: id,
    id,
    expectedRevision: count,
    sourceKey,
    campaignId: id,
    status: z.enum(['active', 'disabled']),
    reason,
  })
  .strict();
export const crmCampaignListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: cursor.optional(),
  })
  .strict();
export const crmCampaignPageSchema = z
  .object({
    items: z.array(crmCampaignSchema).max(100),
    nextCursor: cursor.nullable(),
  })
  .strict();

export const crmSourceMappingListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: cursor.optional(),
    campaignId: id.optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();
export const crmSourceMappingPageSchema = z
  .object({
    items: z.array(crmSourceMappingSchema).max(100),
    nextCursor: cursor.nullable(),
  })
  .strict();

export const crmAttributionSchema = z
  .object({
    sourceHint: sourceKey.nullable(),
    sourceMappingId: id.nullable(),
    sourceMappingRevision: revision.nullable(),
    campaign: z
      .object({
        id,
        revision,
        name: text,
        channel: text,
        documentRef: evidenceRef.nullable(),
        providerLinkId: evidenceRef.nullable(),
      })
      .strict()
      .nullable(),
    recipientLinkage: z.literal('unknown'),
    capturedAt: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    const empty = value.campaign === null && value.sourceMappingId === null && value.sourceMappingRevision === null;
    const resolved =
      value.campaign !== null && value.sourceMappingId !== null && value.sourceMappingRevision !== null && value.sourceHint !== null;
    if (!empty && !resolved)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Campaign attribution requires a resolved source mapping snapshot',
      });
  });
const filters = {
  audience: outreachAudienceSchema.optional(),
  stage: crmOpportunityStageSchema.optional(),
  ownerUserId: id.optional(),
  campaignId: id.optional(),
  sourceKey: sourceKey.optional(),
  capturedFrom: timestamp.optional(),
  capturedBefore: timestamp.optional(),
};
function validateCaptureInterval(value: { capturedFrom?: string; capturedBefore?: string }, ctx: z.RefinementCtx) {
  if (value.capturedFrom && value.capturedBefore && Date.parse(value.capturedFrom) >= Date.parse(value.capturedBefore))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Capture interval must be increasing' });
}
export const crmMetricsInputSchema = z.object(filters).strict().superRefine(validateCaptureInterval);
export const crmMetricsSchema = z
  .object({
    observedAt: timestamp,
    totals: z
      .object({
        opportunities: count,
        submissions: count,
        canonicalContacts: count,
        incompleteSubmissions: count,
        overdueTasks: count,
        manualCallInvitations: count,
        manualCallBookings: count,
      })
      .strict(),
    byAudience: z.array(z.object({ audience: outreachAudienceSchema, count }).strict()).max(5),
    byStage: z
      .array(
        z
          .object({
            audience: outreachAudienceSchema,
            stage: crmOpportunityStageSchema,
            count,
          })
          .strict(),
      )
      .max(25),
    bySource: z
      .array(
        z
          .object({
            sourceKey: sourceKey.nullable(),
            campaignId: id.nullable(),
            count,
          })
          .strict(),
      )
      .max(200),
    sourceGroupsTruncated: z.boolean(),
  })
  .strict();
export const crmDuplicateListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: cursor.optional(),
    query: z.string().trim().max(160).optional(),
  })
  .strict();
export const crmDuplicatePageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            contact: crmContactSchema,
            revision,
            matchingUnmergedContactCount: count,
          })
          .strict(),
      )
      .max(100),
    nextCursor: cursor.nullable(),
  })
  .strict();
export const crmMergeInputSchema = z
  .object({
    requestId: id,
    sourceContactId: id,
    targetContactId: id,
    sourceExpectedRevision: revision,
    targetExpectedRevision: revision,
    confirmed: z.literal(true),
    reason,
  })
  .strict()
  .refine((value) => value.sourceContactId.toLowerCase() !== value.targetContactId.toLowerCase(), 'Choose two distinct contacts');
export const crmMergeReceiptSchema = z
  .object({
    mergeId: id,
    sourceContactId: id,
    targetContactId: id,
    sourceRevision: revision,
    targetRevision: revision,
    movedOpportunityCount: count,
    mergedAt: timestamp,
  })
  .strict();
export const crmContactProvenanceInputSchema = z.object({ contactId: id }).strict();
export const crmContactProvenanceSchema = z
  .object({
    originalContact: crmContactSchema,
    canonicalContact: crmContactSchema,
    originalRevision: revision,
    canonicalRevision: revision,
    firstKnownSource: crmAttributionSchema.nullable(),
    latestKnownSource: crmAttributionSchema.nullable(),
  })
  .strict();
export const crmExportInputSchema = z
  .object({
    requestId: id,
    limit: z.number().int().min(1).max(200),
    cursor: cursor.optional(),
    ...filters,
  })
  .strict()
  .superRefine(validateCaptureInterval);
export const crmExportPageSchema = z
  .object({
    exportId: id,
    generatedAt: timestamp,
    items: z
      .array(
        z
          .object({
            submission: crmSubmissionSchema,
            /** Original capture selection/consent; additions never rewrite this. */
            initialContact: outreachContactCaptureSchema,
            firstCompletedAt: timestamp.nullable(),
            originalContact: crmContactSchema,
            canonicalContact: crmContactSchema,
            attribution: crmAttributionSchema,
          })
          .strict(),
      )
      .max(200),
    nextCursor: cursor.nullable(),
  })
  .strict();

export const crmWorkflowTaskKindSchema = z.enum(['next_action', 'follow_up', 'call_invitation']);
export const crmWorkflowTaskSchema = z
  .object({
    task: crmTaskSchema,
    revision,
    kind: crmWorkflowTaskKindSchema,
    createdAt: timestamp.nullable(),
  })
  .strict();
export const crmTaskListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    cursor: cursor.optional(),
    ownerUserId: id.optional(),
    status: z.enum(['pending', 'completed', 'cancelled']).optional(),
    opportunityId: id.optional(),
    dueBefore: timestamp.optional(),
  })
  .strict();
export const crmTaskPageSchema = z
  .object({
    items: z.array(crmWorkflowTaskSchema).max(100),
    nextCursor: cursor.nullable(),
  })
  .strict();
export const crmTaskCreateInputSchema = z
  .object({
    requestId: id,
    opportunityId: id,
    expectedRevision: revision,
    ownerUserId: id,
    description: text,
    dueAt: timestamp,
    kind: z.enum(['follow_up', 'call_invitation']),
    reason,
  })
  .strict();
export const crmTaskTransitionInputSchema = z
  .object({
    requestId: id,
    opportunityId: id,
    expectedRevision: revision,
    taskId: id,
    expectedTaskRevision: revision,
    status: z.enum(['completed', 'cancelled']),
    replacementNextAction: nextAction.optional(),
    reason,
  })
  .strict();
export const crmTaskMutationReceiptSchema = z.object({ task: crmWorkflowTaskSchema, opportunity: crmOpportunitySchema }).strict();
export const crmInteractionInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      requestId: id,
      opportunityId: id,
      expectedRevision: revision,
      kind: z.literal('call_invited'),
      occurredAt: timestamp,
      evidenceRef,
      nextAction,
      reason,
    })
    .strict(),
  z
    .object({
      requestId: id,
      opportunityId: id,
      expectedRevision: revision,
      kind: z.literal('call_booked'),
      occurredAt: timestamp,
      evidenceRef,
      scheduledAt: timestamp,
      reason,
    })
    .strict(),
  z
    .object({
      requestId: id,
      opportunityId: id,
      expectedRevision: revision,
      kind: z.literal('follow_up'),
      occurredAt: timestamp,
      evidenceRef,
      nextAction,
      reason,
    })
    .strict(),
]);
export const crmInteractionSchema = z
  .object({
    id,
    opportunityId: id,
    kind: z.enum(['call_invited', 'call_booked', 'follow_up']),
    actorUserId: id,
    status: z.literal('manually_recorded'),
    evidenceRef,
    occurredAt: timestamp,
    recordedAt: timestamp,
    scheduledAt: timestamp.nullable(),
  })
  .strict();
export const crmInteractionReceiptSchema = z
  .object({
    interaction: crmInteractionSchema,
    activity: crmActivitySchema,
    opportunity: crmOpportunitySchema,
  })
  .strict();
export const crmWorkflowAuditSchema = z
  .object({
    id,
    requestId: id,
    actorUserId: id,
    subjectType: z.enum(['campaign', 'source_mapping', 'contact', 'opportunity', 'task', 'export']),
    subjectId: id,
    kind: z.enum([
      'campaign_written',
      'source_mapping_written',
      'contacts_merged',
      'stage_changed',
      'task_created',
      'task_transitioned',
      'interaction_recorded',
      'message_queued',
      'export_generated',
    ]),
    reason,
    occurredAt: timestamp,
    facts: z.record(z.unknown()),
  })
  .strict();
export const crmWorkflowAuditListInputSchema = z
  .object({
    subjectType: crmWorkflowAuditSchema.shape.subjectType,
    subjectId: id,
    limit: z.number().int().min(1).max(100),
    cursor: cursor.optional(),
  })
  .strict();
export const crmWorkflowAuditPageSchema = z
  .object({
    items: z.array(crmWorkflowAuditSchema).max(100),
    nextCursor: cursor.nullable(),
  })
  .strict();

/** Prepared provider seam only. Free entitlement never produces fabricated zero analytics. */
export const crmDocumentProviderStatusSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('disabled'),
      reason: z.enum(['api_access_unavailable', 'unconfigured']),
    })
    .strict(),
  z.object({ status: z.literal('ready'), verifiedAt: timestamp }).strict(),
]);
export const crmDocumentProviderReadInputSchema = z
  .object({
    providerLinkId: evidenceRef,
    limit: z.number().int().min(1).max(100),
    cursor: cursor.optional(),
  })
  .strict();
export const crmDocumentViewSchema = z
  .object({
    providerViewId: evidenceRef,
    providerLinkId: evidenceRef,
    occurredAt: timestamp,
    viewerEmail: z.string().max(254).email().nullable(),
    viewerVerification: z.enum(['verified', 'unverified', 'unknown']),
  })
  .strict();
export const crmDocumentProviderReadResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum(['api_access_unavailable', 'unconfigured']),
    })
    .strict(),
  z
    .object({
      status: z.literal('page'),
      items: z.array(crmDocumentViewSchema).max(100),
      nextCursor: cursor.nullable(),
    })
    .strict(),
]);
export interface CrmDocumentProviderAdapter {
  status(): Promise<z.infer<typeof crmDocumentProviderStatusSchema>>;
  readViews(input: z.infer<typeof crmDocumentProviderReadInputSchema>): Promise<z.infer<typeof crmDocumentProviderReadResultSchema>>;
}
export interface CrmWorkflowsContract {
  metrics(input: z.infer<typeof crmMetricsInputSchema>): Promise<z.infer<typeof crmMetricsSchema>>;
  listCampaigns(input: z.infer<typeof crmCampaignListInputSchema>): Promise<z.infer<typeof crmCampaignPageSchema>>;
  listSourceMappings(input: z.infer<typeof crmSourceMappingListInputSchema>): Promise<z.infer<typeof crmSourceMappingPageSchema>>;
  upsertCampaign(input: z.infer<typeof crmCampaignWriteInputSchema>, actorUserId: string): Promise<z.infer<typeof crmCampaignSchema>>;
  upsertSourceMapping(
    input: z.infer<typeof crmSourceMappingWriteInputSchema>,
    actorUserId: string,
  ): Promise<z.infer<typeof crmSourceMappingSchema>>;
  listDuplicates(input: z.infer<typeof crmDuplicateListInputSchema>): Promise<z.infer<typeof crmDuplicatePageSchema>>;
  mergeContacts(input: z.infer<typeof crmMergeInputSchema>, actorUserId: string): Promise<z.infer<typeof crmMergeReceiptSchema>>;
  getContactProvenance(input: z.infer<typeof crmContactProvenanceInputSchema>): Promise<z.infer<typeof crmContactProvenanceSchema> | null>;
  exportSubmissions(input: z.infer<typeof crmExportInputSchema>, actorUserId: string): Promise<z.infer<typeof crmExportPageSchema>>;
  listTasks(input: z.infer<typeof crmTaskListInputSchema>): Promise<z.infer<typeof crmTaskPageSchema>>;
  createTask(input: z.infer<typeof crmTaskCreateInputSchema>, actorUserId: string): Promise<z.infer<typeof crmTaskMutationReceiptSchema>>;
  transitionTask(
    input: z.infer<typeof crmTaskTransitionInputSchema>,
    actorUserId: string,
  ): Promise<z.infer<typeof crmTaskMutationReceiptSchema>>;
  recordInteraction(
    input: z.infer<typeof crmInteractionInputSchema>,
    actorUserId: string,
  ): Promise<z.infer<typeof crmInteractionReceiptSchema>>;
  listWorkflowAudit(input: z.infer<typeof crmWorkflowAuditListInputSchema>): Promise<z.infer<typeof crmWorkflowAuditPageSchema>>;
}
