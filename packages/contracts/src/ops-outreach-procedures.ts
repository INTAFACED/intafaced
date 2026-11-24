import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { crmRetentionStatusSchema } from './crm-privacy.js';
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
