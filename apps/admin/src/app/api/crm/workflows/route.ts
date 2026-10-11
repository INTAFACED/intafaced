import * as crm from '@intafaced/contracts';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';
type Schema = { safeParse(value: unknown): { success: true; data: unknown } | { success: false } };
const reads: Record<string, [Schema | null, Schema]> = {
  metrics: [crm.crmMetricsInputSchema, crm.crmMetricsSchema],
  listCampaigns: [crm.crmCampaignListInputSchema, crm.crmCampaignPageSchema],
  listSourceMappings: [crm.crmSourceMappingListInputSchema, crm.crmSourceMappingPageSchema],
  listDuplicates: [crm.crmDuplicateListInputSchema, crm.crmDuplicatePageSchema],
  getContactProvenance: [crm.crmContactProvenanceInputSchema, crm.crmContactProvenanceSchema.nullable()],
  listTasks: [crm.crmTaskListInputSchema, crm.crmTaskPageSchema],
  listMessages: [crm.crmMessageListInputSchema, crm.crmMessagePageSchema],
  listWorkflowAudit: [crm.crmWorkflowAuditListInputSchema, crm.crmWorkflowAuditPageSchema],
  documentProviderStatus: [null, crm.crmDocumentProviderStatusSchema],
};
const writes: Record<string, [Schema, Schema]> = {
  upsertCampaign: [crm.crmCampaignWriteInputSchema, crm.crmCampaignSchema],
  upsertSourceMapping: [crm.crmSourceMappingWriteInputSchema, crm.crmSourceMappingSchema],
  mergeContacts: [crm.crmMergeInputSchema, crm.crmMergeReceiptSchema],
  exportSubmissions: [crm.crmExportInputSchema, crm.crmExportPageSchema],
  createTask: [crm.crmTaskCreateInputSchema, crm.crmTaskMutationReceiptSchema],
  transitionTask: [crm.crmTaskTransitionInputSchema, crm.crmTaskMutationReceiptSchema],
  recordInteraction: [crm.crmInteractionInputSchema, crm.crmInteractionReceiptSchema],
  queueMessage: [crm.crmQueueMessageInputSchema, crm.crmQueueMessageReceiptSchema],
};
function parse(schema: Schema, value: unknown, upstream = false): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AdminSessionError(upstream ? 'admin.upstream_invalid' : 'admin.crm_input', upstream ? 502 : 400);
  return parsed.data;
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminSessionError('admin.upstream_invalid', 502);
  return value as Record<string, unknown>;
}
function equal(actual: unknown, expected: unknown): void {
  const normalize = (value: unknown) => (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : value);
  if (normalize(actual) !== normalize(expected)) throw new AdminSessionError('admin.upstream_invalid', 502);
}
function bindRead(action: string, input: Record<string, unknown>, value: unknown) {
  if (input.limit !== undefined && Array.isArray(row(value).items) && (row(value).items as unknown[]).length > Number(input.limit))
    throw new AdminSessionError('admin.upstream_invalid', 502);
  if (action === 'getContactProvenance' && value !== null) equal(row(row(value).originalContact).id, input.contactId);
  if (action === 'listTasks') {
    for (const item of row(value).items as unknown[]) {
      const task = row(row(item).task);
      for (const key of ['opportunityId', 'ownerUserId', 'status']) if (input[key] !== undefined) equal(task[key], input[key]);
      if (input.dueBefore && Date.parse(String(task.dueAt)) >= Date.parse(String(input.dueBefore)))
        throw new AdminSessionError('admin.upstream_invalid', 502);
    }
  }
  if (action === 'listMessages') for (const item of row(value).items as unknown[]) equal(row(item).opportunityId, input.opportunityId);
  if (action === 'listSourceMappings')
    for (const item of row(value).items as unknown[]) {
      for (const key of ['campaignId', 'status']) if (input[key] !== undefined) equal(row(item)[key], input[key]);
    }
  if (action === 'listWorkflowAudit')
    for (const item of row(value).items as unknown[]) {
      equal(row(item).subjectType, input.subjectType);
      equal(row(item).subjectId, input.subjectId);
    }
}
export async function GET(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams,
      action = params.get('view') ?? '';
    if (!Object.hasOwn(reads, action) || new Set(params.keys()).size !== [...params.keys()].length)
      throw new AdminSessionError('admin.crm_input', 400);
    const [inputSchema, outputSchema] = reads[action]!;
    const raw: Record<string, unknown> = Object.fromEntries([...params.entries()].filter(([key]) => key !== 'view'));
    if ('limit' in raw) raw.limit = Number(raw.limit);
    if (!inputSchema && Object.keys(raw).length) throw new AdminSessionError('admin.crm_input', 400);
    const input = inputSchema ? parse(inputSchema, raw) : {};
    const result = parse(outputSchema, await founderEdgeCall(config, 'ops', `outreach.${action}`, 'GET', input, session.accessToken), true);
    bindRead(action, row(input), result);
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const body = await readAdminJson(request),
      action = typeof body.action === 'string' ? body.action : '';
    if (Object.keys(body).some((key) => !['action', 'input'].includes(key)) || !Object.hasOwn(writes, action))
      throw new AdminSessionError('admin.crm_input', 400);
    const [inputSchema, outputSchema] = writes[action]!;
    const input = row(parse(inputSchema, body.input));
    const result = row(
      parse(outputSchema, await founderEdgeCall(config, 'ops', `outreach.${action}`, 'POST', input, session.accessToken), true),
    );
    if (action === 'queueMessage') {
      const opportunity = row(result.opportunity),
        message = row(result.message),
        activity = row(result.activity);
      equal(opportunity.id, input.opportunityId);
      equal(opportunity.revision, Number(input.expectedRevision) + 1);
      equal(message.opportunityId, input.opportunityId);
      equal(message.submissionId, opportunity.submissionId);
      equal(message.kind, input.kind);
      equal(message.actorUserId, session.userId);
      equal(activity.opportunityId, input.opportunityId);
      equal(row(activity.actor).kind, 'operator');
      equal(row(activity.actor).userId, session.userId);
      equal(activity.kind, 'email_status');
      equal(activity.referenceId, message.id);
      equal(activity.note, `Message queued: ${String(input.kind)}`);
      if (!['pending', 'unconfigured'].includes(String(message.status)) || message.notification !== null)
        throw new AdminSessionError('admin.upstream_invalid', 502);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    }
    let subjectType: string, subjectId: unknown, kind: string;
    switch (action) {
      case 'upsertCampaign':
        for (const key of ['id', 'name', 'channel', 'status', 'documentRef', 'providerLinkId']) equal(result[key], input[key]);
        equal(result.revision, Number(input.expectedRevision) + 1);
        subjectType = 'campaign';
        subjectId = input.id;
        kind = 'campaign_written';
        break;
      case 'upsertSourceMapping':
        for (const key of ['id', 'sourceKey', 'campaignId', 'status']) equal(result[key], input[key]);
        equal(result.revision, Number(input.expectedRevision) + 1);
        subjectType = 'source_mapping';
        subjectId = input.id;
        kind = 'source_mapping_written';
        break;
      case 'mergeContacts':
        equal(result.sourceContactId, input.sourceContactId);
        equal(result.targetContactId, input.targetContactId);
        equal(result.sourceRevision, Number(input.sourceExpectedRevision) + 1);
        equal(result.targetRevision, Number(input.targetExpectedRevision) + 1);
        subjectType = 'contact';
        subjectId = input.sourceContactId;
        kind = 'contacts_merged';
        break;
      case 'exportSubmissions':
        if ((result.items as unknown[]).length > Number(input.limit)) throw new AdminSessionError('admin.upstream_invalid', 502);
        for (const item of result.items as unknown[]) {
          const value = row(item),
            submission = row(value.submission);
          equal(row(value.originalContact).id, submission.contactId);
          if (input.audience && !(row(submission.contact).interests as unknown[]).includes(input.audience))
            throw new AdminSessionError('admin.upstream_invalid', 502);
          if (input.campaignId) equal(row(row(value.attribution).campaign).id, input.campaignId);
          if (input.sourceKey) equal(row(value.attribution).sourceHint, input.sourceKey);
        }
        subjectType = 'export';
        subjectId = result.exportId;
        kind = 'export_generated';
        break;
      case 'createTask':
      case 'transitionTask': {
        const opportunity = row(result.opportunity),
          wrapper = row(result.task),
          task = row(wrapper.task);
        equal(opportunity.id, input.opportunityId);
        equal(task.opportunityId, input.opportunityId);
        equal(opportunity.revision, Number(input.expectedRevision) + 1);
        if (action === 'createTask') {
          for (const key of ['ownerUserId', 'description', 'dueAt']) equal(task[key], input[key]);
          equal(wrapper.kind, input.kind);
          equal(task.status, 'pending');
        } else {
          equal(task.id, input.taskId);
          equal(task.status, input.status);
          equal(wrapper.revision, Number(input.expectedTaskRevision) + 1);
        }
        subjectType = 'task';
        subjectId = task.id;
        kind = action === 'createTask' ? 'task_created' : 'task_transitioned';
        break;
      }
      default: {
        const interaction = row(result.interaction),
          activity = row(result.activity),
          opportunity = row(result.opportunity);
        for (const key of ['opportunityId', 'kind', 'occurredAt', 'evidenceRef']) equal(interaction[key], input[key]);
        equal(interaction.actorUserId, session.userId);
        equal(interaction.status, 'manually_recorded');
        equal(opportunity.id, input.opportunityId);
        equal(opportunity.revision, Number(input.expectedRevision) + 1);
        equal(activity.opportunityId, input.opportunityId);
        equal(row(activity.actor).kind, 'operator');
        equal(row(activity.actor).userId, session.userId);
        subjectType = 'opportunity';
        subjectId = input.opportunityId;
        kind = 'interaction_recorded';
      }
    }
    // Receipts without actor fields are verified against the protected immutable audit.
    const audit = crm.crmWorkflowAuditPageSchema.safeParse(
      await founderEdgeCall(
        config,
        'ops',
        'outreach.listWorkflowAudit',
        'GET',
        { subjectType, subjectId, limit: 100 },
        session.accessToken,
      ),
    );
    if (
      !audit.success ||
      audit.data.items.some((item) => item.subjectType !== subjectType || item.subjectId !== String(subjectId).toLowerCase()) ||
      !audit.data.items.some(
        (item) =>
          item.requestId === String(input.requestId).toLowerCase() &&
          item.actorUserId === session.userId.toLowerCase() &&
          item.kind === kind &&
          (input.reason === undefined || item.reason === input.reason),
      )
    )
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
