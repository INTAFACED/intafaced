import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  crmRetentionStatusSchema,
  crmRetentionReviewStatusInputSchema,
  crmRetentionReviewSchema,
  crmErasurePreviewInputSchema,
  crmErasurePreviewSchema,
  crmErasureStatusInputSchema,
  crmErasureStatusSchema,
  crmRetentionReviewInputSchema,
  crmErasureBeginInputSchema,
  crmErasureAdvanceInputSchema,
} from './crm-privacy.js';
import {
  crmWorkflowAuditListInputSchema,
  crmWorkflowAuditPageSchema,
  crmCampaignListInputSchema,
  crmCampaignPageSchema,
  crmSourceMappingListInputSchema,
  crmSourceMappingPageSchema,
  crmTaskListInputSchema,
  crmTaskPageSchema,
  crmDocumentProviderStatusSchema,
  crmCampaignWriteInputSchema,
  crmCampaignSchema,
  crmSourceMappingWriteInputSchema,
  crmSourceMappingSchema,
  crmTaskCreateInputSchema,
  crmTaskMutationReceiptSchema,
  crmTaskTransitionInputSchema,
  crmInteractionInputSchema,
  crmInteractionReceiptSchema,
  crmContactProvenanceInputSchema,
  crmContactProvenanceSchema,
  crmMetricsInputSchema,
  crmMetricsSchema,
  crmDuplicateListInputSchema,
  crmDuplicatePageSchema,
  crmMergeInputSchema,
  crmMergeReceiptSchema,
  crmExportInputSchema,
  crmExportPageSchema,
} from './crm-workflows.js';
import {
  crmMessageListInputSchema,
  crmMessagePageSchema,
  crmQueueMessageInputSchema,
  crmQueueMessageReceiptSchema,
} from './crm-notifications.js';
import {
  crmAssignmentInputSchema,
  crmOpportunitySchema,
  crmNextActionInputSchema,
  crmNoteInputSchema,
  crmActivitySchema,
  crmStageChangeInputSchema,
  crmOpportunityDetailSchema,
  crmListInputSchema,
  crmOpportunityPageSchema,
} from './outreach-crm.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `outreach.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_OUTREACH_PRIVACY_RETENTION_STATUS = defineProcedure({
  ...base,
  name: 'ops.outreach.privacyRetentionStatus',
  kind: 'query',
  path: 'outreach.privacyRetentionStatus',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: NO_INPUT,
  output: crmRetentionStatusSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_OUTREACH_OWNERS = defineProcedure({
  ...base,
  name: 'ops.outreach.owners',
  kind: 'query',
  path: 'outreach.owners',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: NO_INPUT,
  output: z
    .object({
      ownerUserIds: z.array(z.string().guid()).length(2),
      initialOwnerUserId: z.string().guid(),
      owners: z.tuple([
        z.object({ userId: z.string().guid(), displayName: z.literal('Nitro') }).strict(),
        z.object({ userId: z.string().guid(), displayName: z.literal('Phantom') }).strict(),
      ]),
    })
    .strict(),
  samples: [{ verdict: 'accept' }],
});

export const OPS_OUTREACH_LIST_WORKFLOW_AUDIT = defineProcedure({
  ...base,
  name: 'ops.outreach.listWorkflowAudit',
  kind: 'query',
  path: 'outreach.listWorkflowAudit',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmWorkflowAuditListInputSchema,
  output: crmWorkflowAuditPageSchema,
  samples: [
    { verdict: 'accept', input: { subjectType: 'campaign', subjectId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_LIST_CAMPAIGNS = defineProcedure({
  ...base,
  name: 'ops.outreach.listCampaigns',
  kind: 'query',
  path: 'outreach.listCampaigns',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmCampaignListInputSchema,
  output: crmCampaignPageSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_LIST_SOURCE_MAPPINGS = defineProcedure({
  ...base,
  name: 'ops.outreach.listSourceMappings',
  kind: 'query',
  path: 'outreach.listSourceMappings',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmSourceMappingListInputSchema,
  output: crmSourceMappingPageSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_LIST_TASKS = defineProcedure({
  ...base,
  name: 'ops.outreach.listTasks',
  kind: 'query',
  path: 'outreach.listTasks',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmTaskListInputSchema,
  output: crmTaskPageSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_LIST_MESSAGES = defineProcedure({
  ...base,
  name: 'ops.outreach.listMessages',
  kind: 'query',
  path: 'outreach.listMessages',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmMessageListInputSchema,
  output: crmMessagePageSchema,
  outputChecks: {
    crm_message_holds: {
      at: 'output.items[]',
      says: 'Notification evidence must belong to this queued message; Acceptance requires a verified gateway receipt',
    },
    guest_notification_receipt_holds: {
      at: 'output.items[].notification',
      says: 'Acceptance requires actual attempt and acceptance evidence; Unaccepted states cannot claim gateway acceptance; Pending work cannot carry a terminal error; Queued work has not been attempted; An in-flight or uncertain outcome requires an actual attempt; Refusal and uncertainty require a typed reason; Acceptance cannot precede the attempt',
    },
  },
  samples: [
    { verdict: 'accept', input: { opportunityId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_DOCUMENT_PROVIDER_STATUS = defineProcedure({
  ...base,
  name: 'ops.outreach.documentProviderStatus',
  kind: 'query',
  path: 'outreach.documentProviderStatus',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: NO_INPUT,
  output: crmDocumentProviderStatusSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_OUTREACH_UPSERT_CAMPAIGN = defineProcedure({
  ...base,
  name: 'ops.outreach.upsertCampaign',
  kind: 'mutation',
  path: 'outreach.upsertCampaign',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmCampaignWriteInputSchema,
  output: crmCampaignSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        id: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 0,
        name: 'USDC',
        channel: 'USDC',
        status: 'active',
        documentRef: 'USDC',
        providerLinkId: 'USDC',
        reason: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_UPSERT_SOURCE_MAPPING = defineProcedure({
  ...base,
  name: 'ops.outreach.upsertSourceMapping',
  kind: 'mutation',
  path: 'outreach.upsertSourceMapping',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmSourceMappingWriteInputSchema,
  output: crmSourceMappingSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        id: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 0,
        sourceKey: '11111111-1111-4111-8111-111111111111',
        campaignId: '11111111-1111-4111-8111-111111111111',
        status: 'active',
        reason: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_CREATE_TASK = defineProcedure({
  ...base,
  name: 'ops.outreach.createTask',
  kind: 'mutation',
  path: 'outreach.createTask',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmTaskCreateInputSchema,
  output: crmTaskMutationReceiptSchema,
  outputChecks: {
    crm_opportunity_holds: {
      at: 'output.opportunity',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        ownerUserId: '11111111-1111-4111-8111-111111111111',
        description: 'USDC',
        dueAt: '2026-01-01T00:00:00.000Z',
        kind: 'follow_up',
        reason: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_TRANSITION_TASK = defineProcedure({
  ...base,
  name: 'ops.outreach.transitionTask',
  kind: 'mutation',
  path: 'outreach.transitionTask',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmTaskTransitionInputSchema,
  output: crmTaskMutationReceiptSchema,
  outputChecks: {
    crm_opportunity_holds: {
      at: 'output.opportunity',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        taskId: '11111111-1111-4111-8111-111111111111',
        expectedTaskRevision: 1,
        status: 'completed',
        reason: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_RECORD_INTERACTION = defineProcedure({
  ...base,
  name: 'ops.outreach.recordInteraction',
  kind: 'mutation',
  path: 'outreach.recordInteraction',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmInteractionInputSchema,
  output: crmInteractionReceiptSchema,
  outputChecks: {
    crm_opportunity_holds: {
      at: 'output.opportunity',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        kind: 'call_invited',
        occurredAt: '2026-01-01T00:00:00.000Z',
        evidenceRef: 'USDC',
        nextAction: { description: 'USDC', dueAt: '2026-01-01T00:00:00.000Z' },
        reason: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_QUEUE_MESSAGE = defineProcedure({
  ...base,
  name: 'ops.outreach.queueMessage',
  kind: 'mutation',
  path: 'outreach.queueMessage',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmQueueMessageInputSchema,
  output: crmQueueMessageReceiptSchema,
  outputChecks: {
    crm_opportunity_holds: {
      at: 'output.opportunity',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
    crm_message_holds: {
      at: 'output.message',
      says: 'Notification evidence must belong to this queued message; Acceptance requires a verified gateway receipt',
    },
    guest_notification_receipt_holds: {
      at: 'output.message.notification',
      says: 'Acceptance requires actual attempt and acceptance evidence; Unaccepted states cannot claim gateway acceptance; Pending work cannot carry a terminal error; Queued work has not been attempted; An in-flight or uncertain outcome requires an actual attempt; Refusal and uncertainty require a typed reason; Acceptance cannot precede the attempt',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        kind: 'information_request',
        staffText: 'USDC',
        reason: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_ASSIGN = defineProcedure({
  ...base,
  name: 'ops.outreach.assign',
  kind: 'mutation',
  path: 'outreach.assign',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmAssignmentInputSchema,
  output: crmOpportunitySchema,
  outputChecks: {
    crm_opportunity_holds: {
      at: 'output',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        ownerUserId: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_UPDATE_NEXT_ACTION = defineProcedure({
  ...base,
  name: 'ops.outreach.updateNextAction',
  kind: 'mutation',
  path: 'outreach.updateNextAction',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmNextActionInputSchema,
  output: crmOpportunitySchema,
  outputChecks: {
    crm_opportunity_holds: {
      at: 'output',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        description: 'USDC',
        dueAt: '2026-01-01T00:00:00.000Z',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_ADD_NOTE = defineProcedure({
  ...base,
  name: 'ops.outreach.addNote',
  kind: 'mutation',
  path: 'outreach.addNote',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmNoteInputSchema,
  output: crmActivitySchema,
  samples: [
    {
      verdict: 'accept',
      input: { requestId: '11111111-1111-4111-8111-111111111111', opportunityId: '11111111-1111-4111-8111-111111111111', note: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_PRIVACY_RETENTION_REVIEW_STATUS = defineProcedure({
  ...base,
  name: 'ops.outreach.privacyRetentionReviewStatus',
  kind: 'query',
  path: 'outreach.privacyRetentionReviewStatus',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmRetentionReviewStatusInputSchema,
  output: crmRetentionReviewSchema.nullable(),
  outputChecks: {
    crm_retention_review_holds: {
      at: 'output',
      says: 'Inactive reviews do not exempt a contact; Active review must expire within 30 days',
    },
  },
  samples: [
    { verdict: 'accept', input: { canonicalContactId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_PRIVACY_PREVIEW = defineProcedure({
  ...base,
  name: 'ops.outreach.privacyPreview',
  kind: 'query',
  path: 'outreach.privacyPreview',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmErasurePreviewInputSchema,
  output: crmErasurePreviewSchema,
  samples: [
    { verdict: 'accept', input: { canonicalContactId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_PRIVACY_STATUS = defineProcedure({
  ...base,
  name: 'ops.outreach.privacyStatus',
  kind: 'query',
  path: 'outreach.privacyStatus',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmErasureStatusInputSchema,
  output: crmErasureStatusSchema,
  outputChecks: {
    crm_erasure_status_holds: {
      at: 'output',
      says: 'Erasure attribution must match its actual actor; Completion requires all original notification erasure receipts; Pending erasure cannot claim completion',
    },
  },
  samples: [
    { verdict: 'accept', input: { intentId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_PRIVACY_RETENTION_REVIEW = defineProcedure({
  ...base,
  name: 'ops.outreach.privacyRetentionReview',
  kind: 'mutation',
  path: 'outreach.privacyRetentionReview',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmRetentionReviewInputSchema,
  output: crmRetentionReviewSchema,
  outputChecks: {
    crm_retention_review_holds: {
      at: 'output',
      says: 'Inactive reviews do not exempt a contact; Active review must expire within 30 days',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        canonicalContactId: '11111111-1111-4111-8111-111111111111',
        expectedCanonicalRevision: 1,
        expectedReviewRevision: 0,
        state: 'active',
        evidenceRef: 'USDC',
        reason: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_PRIVACY_BEGIN = defineProcedure({
  ...base,
  name: 'ops.outreach.privacyBegin',
  kind: 'mutation',
  path: 'outreach.privacyBegin',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmErasureBeginInputSchema,
  output: crmErasureStatusSchema,
  outputChecks: {
    crm_erasure_status_holds: {
      at: 'output',
      says: 'Erasure attribution must match its actual actor; Completion requires all original notification erasure receipts; Pending erasure cannot claim completion',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        canonicalContactId: '11111111-1111-4111-8111-111111111111',
        expectedCanonicalRevision: 1,
        snapshot: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        confirmedEntireCluster: true,
        reason: 'confirmed_privacy_request',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_PRIVACY_ADVANCE = defineProcedure({
  ...base,
  name: 'ops.outreach.privacyAdvance',
  kind: 'mutation',
  path: 'outreach.privacyAdvance',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmErasureAdvanceInputSchema,
  output: crmErasureStatusSchema,
  outputChecks: {
    crm_erasure_status_holds: {
      at: 'output',
      says: 'Erasure attribution must match its actual actor; Completion requires all original notification erasure receipts; Pending erasure cannot claim completion',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: { requestId: '11111111-1111-4111-8111-111111111111', intentId: '11111111-1111-4111-8111-111111111111', expectedRevision: 1 },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_CHANGE_STAGE = defineProcedure({
  ...base,
  name: 'ops.outreach.changeStage',
  kind: 'mutation',
  path: 'outreach.changeStage',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmStageChangeInputSchema,
  checks: { crm_stage_change_input_holds: { at: 'input', says: 'Closing facts must match the stage; Next action must match the stage' } },
  output: crmOpportunitySchema,
  outputChecks: {
    crm_opportunity_holds: {
      at: 'output',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        stage: 'new',
        reason: 'USDC',
        closedDisposition: null,
        closingEvidenceRef: null,
        nextAction: { description: 'USDC', dueAt: '2026-01-01T00:00:00.000Z' },
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'crm_stage_change_input_holds',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        stage: 'new',
        reason: 'USDC',
        closedDisposition: 'proceeded',
        closingEvidenceRef: 'USDC',
        nextAction: { description: 'USDC', dueAt: '2026-01-01T00:00:00.000Z' },
      },
    },
  ],
});

export const OPS_OUTREACH_GET_OPPORTUNITY = defineProcedure({
  ...base,
  name: 'ops.outreach.getOpportunity',
  kind: 'query',
  path: 'outreach.getOpportunity',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: z.object({ opportunityId: z.string().guid() }).strict(),
  output: crmOpportunityDetailSchema,
  outputChecks: {
    crm_opportunity_holds: {
      at: 'output.opportunity',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
    unique_holds: {
      at: [
        'output.contact.interests',
        'output.submission.contact.interests',
        'output.submission.questionnaires[]|1.answers.markets',
        'output.submission.questionnaires[]|2.answers.operatingCountries',
        'output.submission.questionnaires[]|2.answers.services',
        'output.submission.questionnaires[]|3.answers.subjects',
      ],
      says: 'Duplicate selections are not allowed',
    },
    crm_submission_holds: {
      at: 'output.submission',
      says: 'Duplicate audience answers; Audience is outside selected interests; Selected questionnaires are incomplete; Completion precedes capture',
    },
    website_holds: {
      at: ['output.submission.questionnaires[]|2.answers.website', 'output.organisation.website'],
      says: 'Website must use HTTP or HTTPS',
    },
  },
  samples: [
    { verdict: 'accept', input: { opportunityId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_GET_CONTACT_PROVENANCE = defineProcedure({
  ...base,
  name: 'ops.outreach.getContactProvenance',
  kind: 'query',
  path: 'outreach.getContactProvenance',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmContactProvenanceInputSchema,
  output: crmContactProvenanceSchema.nullable(),
  outputChecks: {
    unique_holds: {
      at: ['output.originalContact.interests', 'output.canonicalContact.interests'],
      says: 'Duplicate selections are not allowed',
    },
    crm_attribution_holds: {
      at: ['output.firstKnownSource', 'output.latestKnownSource'],
      says: 'Campaign attribution requires a resolved source mapping snapshot',
    },
  },
  samples: [
    { verdict: 'accept', input: { contactId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_LIST_OPPORTUNITIES = defineProcedure({
  ...base,
  name: 'ops.outreach.listOpportunities',
  kind: 'query',
  path: 'outreach.listOpportunities',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmListInputSchema,
  output: crmOpportunityPageSchema,
  outputChecks: {
    crm_opportunity_page_holds: {
      at: 'output',
      says: 'List contacts must match the visible opportunities; List submissions must match the visible opportunities; Alias matches must belong to the visible opportunities',
    },
    crm_opportunity_holds: {
      at: 'output.items[]',
      says: 'Closed stage requires disposition and evidence; Open stage cannot carry closing facts; Open opportunities require a next action; closed opportunities do not',
    },
    unique_holds: { at: 'output.contacts[].interests', says: 'Duplicate selections are not allowed' },
  },
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_METRICS = defineProcedure({
  ...base,
  name: 'ops.outreach.metrics',
  kind: 'query',
  path: 'outreach.metrics',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmMetricsInputSchema,
  checks: { crm_metrics_input_holds: { at: 'input', says: 'Capture interval must be increasing' } },
  output: crmMetricsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'crm_metrics_input_holds',
      input: { capturedFrom: '2026-01-01T00:00:00.000Z', capturedBefore: '2026-01-01T00:00:00.000Z' },
    },
  ],
});

export const OPS_OUTREACH_LIST_DUPLICATES = defineProcedure({
  ...base,
  name: 'ops.outreach.listDuplicates',
  kind: 'query',
  path: 'outreach.listDuplicates',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmDuplicateListInputSchema,
  output: crmDuplicatePageSchema,
  outputChecks: { unique_holds: { at: 'output.items[].contact.interests', says: 'Duplicate selections are not allowed' } },
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_OUTREACH_MERGE_CONTACTS = defineProcedure({
  ...base,
  name: 'ops.outreach.mergeContacts',
  kind: 'mutation',
  path: 'outreach.mergeContacts',
  access: { caller: 'scope', scope: 'ops:write', check: 'authority' },
  refusals: {},
  input: crmMergeInputSchema,
  checks: { crm_merge_input_holds: { at: 'input', says: 'Choose two distinct contacts' } },
  output: crmMergeReceiptSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        sourceContactId: '22222222-2222-4222-8222-222222222222',
        targetContactId: '11111111-1111-4111-8111-111111111111',
        sourceExpectedRevision: 1,
        targetExpectedRevision: 1,
        confirmed: true,
        reason: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'crm_merge_input_holds',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        sourceContactId: '11111111-1111-4111-8111-111111111111',
        targetContactId: '11111111-1111-4111-8111-111111111111',
        sourceExpectedRevision: 1,
        targetExpectedRevision: 1,
        confirmed: true,
        reason: 'USDC',
      },
    },
  ],
});

export const OPS_OUTREACH_EXPORT_SUBMISSIONS = defineProcedure({
  ...base,
  name: 'ops.outreach.exportSubmissions',
  kind: 'mutation',
  path: 'outreach.exportSubmissions',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmExportInputSchema,
  checks: { crm_export_input_holds: { at: 'input', says: 'Capture interval must be increasing' } },
  output: crmExportPageSchema,
  outputChecks: {
    crm_submission_holds: {
      at: 'output.items[].submission',
      says: 'Duplicate audience answers; Audience is outside selected interests; Selected questionnaires are incomplete; Completion precedes capture',
    },
    unique_holds: {
      at: [
        'output.items[].submission.contact.interests',
        'output.items[].submission.questionnaires[]|1.answers.markets',
        'output.items[].submission.questionnaires[]|2.answers.operatingCountries',
        'output.items[].submission.questionnaires[]|2.answers.services',
        'output.items[].submission.questionnaires[]|3.answers.subjects',
        'output.items[].initialContact.interests',
        'output.items[].originalContact.interests',
        'output.items[].canonicalContact.interests',
      ],
      says: 'Duplicate selections are not allowed',
    },
    website_holds: { at: 'output.items[].submission.questionnaires[]|2.answers.website', says: 'Website must use HTTP or HTTPS' },
    crm_attribution_holds: { at: 'output.items[].attribution', says: 'Campaign attribution requires a resolved source mapping snapshot' },
  },
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'crm_export_input_holds',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        limit: 1,
        capturedFrom: '2026-01-01T00:00:00.000Z',
        capturedBefore: '2026-01-01T00:00:00.000Z',
      },
    },
  ],
});
