import {
  crmAssignmentInputSchema,
  crmListInputSchema,
  crmNoteInputSchema,
  crmStageChangeInputSchema,
  crmOpportunityPageSchema,
  crmOpportunitySchema,
  crmContactSchema,
  crmOrganisationSchema,
  crmSubmissionSchema,
  crmActivitySchema,
  crmTaskSchema,
  crmContactProvenanceSchema,
} from '@intafaced/contracts';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function writeSchema(action: unknown) {
  if (action === 'assign') return crmAssignmentInputSchema;
  if (action === 'changeStage') return crmStageChangeInputSchema;
  if (action === 'addNote') return crmNoteInputSchema;
  return null;
}
function detailResponse(data: unknown, id: string) {
  if (data === null) return null;
  if (!record(data)) throw new AdminSessionError('admin.upstream_invalid', 502);
  const opportunity = crmOpportunitySchema.safeParse(data.opportunity);
  const contact = crmContactSchema.safeParse(data.contact);
  const submission = crmSubmissionSchema.safeParse(data.submission);
  const organisation = data.organisation === null ? null : crmOrganisationSchema.safeParse(data.organisation);
  if (
    !opportunity.success ||
    !contact.success ||
    !submission.success ||
    (organisation !== null && !organisation.success) ||
    opportunity.data.id !== id ||
    opportunity.data.contactId !== contact.data.id ||
    opportunity.data.submissionId !== submission.data.submissionId ||
    opportunity.data.organisationId !== (organisation?.success ? organisation.data.id : null) ||
    !Array.isArray(data.activities) ||
    !Array.isArray(data.tasks) ||
    !Array.isArray(data.deliveries)
  )
    throw new AdminSessionError('admin.upstream_invalid', 502);
  const activities = data.activities.map((value) => crmActivitySchema.safeParse(value));
  const tasks = data.tasks.map((value) => crmTaskSchema.safeParse(value));
  if (
    activities.some((value) => !value.success || value.data.opportunityId !== id) ||
    tasks.some((value) => !value.success || value.data.opportunityId !== id) ||
    data.deliveries.some(
      (value) =>
        !record(value) || !['pending', 'unconfigured', 'accepted', 'delivered', 'failed', 'unresolved'].includes(String(value.status)),
    )
  )
    throw new AdminSessionError('admin.upstream_invalid', 502);
  return {
    opportunity: opportunity.data,
    contact: contact.data,
    submission: submission.data,
    organisation: organisation?.success ? organisation.data : null,
    activities: activities.map((value) => value.data),
    tasks: tasks.map((value) => value.data),
    deliveries: data.deliveries
      .filter((value) => !('kind' in value) || value.kind === 'enquiry_acknowledgement')
      .map((value) => ({
        status: (value as Record<string, unknown>).status,
        errorCode: typeof value.error_code === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value.error_code) ? value.error_code : null,
      })),
  };
}

export async function GET(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if (params.get('view') === 'owners' && [...params.keys()].every((key) => key === 'view')) {
      const data = await founderEdgeCall(config, 'ops', 'outreach.owners', 'GET', {}, session.accessToken);
      if (
        !record(data) ||
        !Array.isArray(data.ownerUserIds) ||
        data.ownerUserIds.length !== 2 ||
        !data.ownerUserIds.every((id) => typeof id === 'string' && uuid.test(id)) ||
        new Set(data.ownerUserIds.map((id: string) => id.toLowerCase())).size !== 2 ||
        typeof data.initialOwnerUserId !== 'string' ||
        !data.ownerUserIds.includes(data.initialOwnerUserId)
      )
        throw new AdminSessionError('admin.upstream_invalid', 502);
      const ownerUserIds = data.ownerUserIds;
      if (
        !Array.isArray(data.owners) ||
        data.owners.length !== 2 ||
        data.owners.some(
          (owner) => !record(owner) || !ownerUserIds.includes(owner.userId) || !['Nitro', 'Phantom'].includes(String(owner.displayName)),
        ) ||
        new Set(data.owners.map((owner) => owner.userId)).size !== 2 ||
        new Set(data.owners.map((owner) => owner.displayName)).size !== 2
      )
        throw new AdminSessionError('admin.upstream_invalid', 502);
      return Response.json(
        {
          ownerUserIds: data.ownerUserIds,
          initialOwnerUserId: data.initialOwnerUserId,
          owners: data.owners.map(({ userId, displayName }) => ({ userId, displayName })),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    const id = params.get('opportunityId');
    let data: unknown;
    if (id !== null) {
      if (!uuid.test(id) || [...params.keys()].some((key) => key !== 'opportunityId')) throw new AdminSessionError('admin.crm_input', 400);
      data = await founderEdgeCall(config, 'ops', 'outreach.getOpportunity', 'GET', { opportunityId: id }, session.accessToken);
      const detail = detailResponse(data, id.toLowerCase());
      data = detail;
      if (detail) {
        const provenance = crmContactProvenanceSchema.safeParse(
          await founderEdgeCall(
            config,
            'ops',
            'outreach.getContactProvenance',
            'GET',
            { contactId: detail.submission.contactId },
            session.accessToken,
          ),
        );
        if (
          !provenance.success ||
          provenance.data.originalContact.id !== detail.submission.contactId ||
          provenance.data.canonicalContact.id !== detail.opportunity.contactId ||
          provenance.data.canonicalContact.id !== detail.contact.id
        )
          throw new AdminSessionError('admin.upstream_invalid', 502);
        data = { ...detail, provenance: provenance.data };
      }
    } else {
      const raw: Record<string, unknown> = Object.fromEntries(params);
      if ('limit' in raw) raw.limit = Number(raw.limit);
      const parsed = crmListInputSchema.safeParse(raw);
      if (!parsed.success) throw new AdminSessionError('admin.crm_input', 400);
      data = await founderEdgeCall(config, 'ops', 'outreach.listOpportunities', 'GET', parsed.data, session.accessToken);
      const page = crmOpportunityPageSchema.safeParse(data);
      if (!page.success) throw new AdminSessionError('admin.upstream_invalid', 502);
      data = page.data;
    }
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const body = await readAdminJson(request);
    if (Object.keys(body).some((key) => !['action', 'input'].includes(key))) throw new AdminSessionError('admin.crm_input', 400);
    const schema = writeSchema(body.action);
    const parsed = schema?.safeParse(body.input);
    if (!parsed?.success) throw new AdminSessionError('admin.crm_input', 400);
    const data = await founderEdgeCall(config, 'ops', `outreach.${String(body.action)}`, 'POST', parsed.data, session.accessToken);
    const result = body.action === 'addNote' ? crmActivitySchema.safeParse(data) : crmOpportunitySchema.safeParse(data);
    if (!result.success) throw new AdminSessionError('admin.upstream_invalid', 502);
    const row = result.data;
    if (
      ('opportunityId' in row ? row.opportunityId : row.id) !== parsed.data.opportunityId.toLowerCase() ||
      ('actor' in row && (row.actor.kind !== 'operator' || row.actor.userId !== session.userId.toLowerCase()))
    )
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(row, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
