import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  crmRetentionStatusSchema,
  crmErasurePreviewInputSchema,
  crmErasurePreviewSchema,
  crmErasureStatusInputSchema,
  crmErasureStatusSchema,
  crmRetentionReviewInputSchema,
  crmRetentionReviewSchema,
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
  crmDuplicateListInputSchema,
  crmDuplicatePageSchema,
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
} from './crm-workflows.js';
import {
  crmListInputSchema,
  crmOpportunityPageSchema,
  crmAssignmentInputSchema,
  crmOpportunitySchema,
  crmNextActionInputSchema,
  crmNoteInputSchema,
  crmActivitySchema,
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
