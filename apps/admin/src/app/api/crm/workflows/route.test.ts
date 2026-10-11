import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { GET as detailGet } from '../route';
import { adminSessionConfig, ADMIN_COOKIE, sealFounderSession, type FounderSession } from '@/lib/founder-session';
const original = { ...process.env },
  now = new Date().toISOString();
const userId = randomUUID(),
  originalId = randomUUID(),
  canonicalId = randomUUID(),
  opportunityId = randomUUID(),
  submissionId = randomUUID();
const session: FounderSession = {
  userId,
  accessToken: 'actual-founder-access-token',
  refreshToken: 'private-refresh',
  issuedAt: now,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  csrf: randomBytes(32).toString('base64url'),
};
const contact = (id: string, name = 'Original Person') => ({
  id,
  name,
  email: 'original@example.invalid',
  emailEvidence: { status: 'unverified' },
  organisationIds: [],
  interests: ['investor'],
  platformIdentity: null,
  createdAt: now,
  updatedAt: now,
});
const originalContact = contact(originalId),
  canonicalContact = contact(canonicalId, 'Canonical Person');
const opportunity = {
  id: opportunityId,
  contactId: canonicalId,
  organisationId: null,
  submissionId,
  ownerUserId: userId,
  revision: 2,
  audience: 'investor',
  stage: 'qualified',
  indicativeContribution: { status: 'undecided' },
  nextAction: { description: 'Review enquiry', dueAt: now },
  closedDisposition: null,
  closingEvidenceRef: null,
  createdAt: now,
  updatedAt: now,
};
const submission = {
  submissionId,
  contactId: originalId,
  revision: 2,
  contact: { name: originalContact.name, email: originalContact.email, interests: ['investor'], marketingOptIn: false },
  questionnaires: [
    {
      audience: 'investor',
      version: 1,
      answers: {
        investorType: 'individual',
        participation: 'direct',
        decisionRole: 'decision_maker',
        indicativeContribution: { status: 'undecided' },
        timing: 'as_available',
        message: 'Preserve original answer',
      },
    },
  ],
  capturedAt: now,
  completedAt: now,
};
const provenance = {
  originalContact,
  canonicalContact,
  originalRevision: 2,
  canonicalRevision: 3,
  firstKnownSource: null,
  latestKnownSource: null,
};
const detail = {
  opportunity,
  submission,
  contact: canonicalContact,
  organisation: null,
  activities: [],
  tasks: [],
  deliveries: [{ status: 'unconfigured' }],
};
const enabled = { status: 'enabled', userId, version: '1', changedAt: now };
function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`https://admin.example${path}`, {
    method,
    headers: {
      cookie: `${ADMIN_COOKIE}=${sealFounderSession(session, adminSessionConfig())}`,
      ...(method === 'POST'
        ? { origin: 'https://admin.example', 'x-intafaced-csrf': session.csrf, 'content-type': 'application/json' }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function upstream(values: Record<string, unknown | ((input: Record<string, unknown>) => unknown)>) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)),
      procedure = path.pathname.split('.').at(-1)!;
    const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(path.searchParams.get('input') ?? '{}');
    const value = procedure === 'operatorStatus' ? enabled : values[procedure];
    return Response.json({ result: { data: typeof value === 'function' ? value(input) : value } });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function audit(input: Record<string, unknown>, type: string, id: string, kind: string, actor = userId) {
  return {
    items: [
      {
        id: randomUUID(),
        requestId: input.requestId,
        actorUserId: actor,
        subjectType: type,
        subjectId: id,
        kind,
        reason: input.reason ?? 'Founder requested a bounded original-submission export',
        occurredAt: now,
        facts: {},
      },
    ],
    nextCursor: null,
  };
}
beforeEach(() => {
  process.env.ADMIN_ORIGIN = 'https://admin.example';
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_SESSION_SECRET = randomBytes(32).toString('base64url');
  process.env.ADMIN_OPERATOR_TOKEN = 'must-never-be-used';
});
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('protected founder CRM workflows', () => {
  it('binds merged opportunity, original submission and canonical provenance without rewriting answers', async () => {
    const fetcher = upstream({ getOpportunity: detail, getContactProvenance: provenance });
    const result = await detailGet(request(`/api/crm?opportunityId=${opportunityId}`));
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.submission.contactId).toBe(originalId);
    expect(data.contact.id).toBe(canonicalId);
    expect(data.submission.questionnaires[0].answers.message).toBe('Preserve original answer');
    expect(fetcher.mock.calls[2]?.[0]).toContain('getContactProvenance');
    expect(new URL(String(fetcher.mock.calls[2]?.[0])).searchParams.get('input')).toBe(JSON.stringify({ contactId: originalId }));
    for (const [, init] of fetcher.mock.calls)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
  });
  it('keeps acknowledgement failures distinct from separately listed staff messages', async () => {
    upstream({
      getOpportunity: {
        ...detail,
        deliveries: [
          { kind: 'enquiry_acknowledgement', status: 'failed', error_code: 'ops.crm.notification_unconfigured' },
          { kind: 'follow_up', status: 'unconfigured' },
        ],
      },
      getContactProvenance: provenance,
    });
    const response = await detailGet(request(`/api/crm?opportunityId=${opportunityId}`));
    expect(response.status).toBe(200);
    expect((await response.json()).deliveries).toEqual([{ status: 'failed', errorCode: 'ops.crm.notification_unconfigured' }]);
  });
  it.each(['original', 'canonical', 'opportunity'] as const)('rejects foreign %s binding after merge', async (wrong) => {
    upstream({
      getOpportunity: wrong === 'opportunity' ? { ...detail, opportunity: { ...opportunity, id: randomUUID() } } : detail,
      getContactProvenance: {
        ...provenance,
        ...(wrong === 'original'
          ? { originalContact: contact(randomUUID()) }
          : wrong === 'canonical'
            ? { canonicalContact: contact(randomUUID()) }
            : {}),
      },
    });
    expect((await detailGet(request(`/api/crm?opportunityId=${opportunityId}`))).status).toBe(502);
  });
  it('refuses unauthenticated and cross-site workflows before identity or ops requests', async () => {
    const fetcher = upstream({});
    for (const view of [
      'metrics',
      'listCampaigns',
      'listSourceMappings',
      'listDuplicates',
      'listTasks',
      'listWorkflowAudit',
      'documentProviderStatus',
    ])
      expect((await GET(new Request(`https://admin.example/api/crm/workflows?view=${view}`))).status).toBe(401);
    const incoming = request('/api/crm/workflows', 'POST', { action: 'mergeContacts', input: {} });
    incoming.headers.delete('x-intafaced-csrf');
    expect((await POST(incoming)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps global metrics distinct from fabricated provider zeros and refuses unknown inputs', async () => {
    const metrics = {
      observedAt: now,
      totals: {
        opportunities: 120,
        submissions: 50,
        canonicalContacts: 40,
        incompleteSubmissions: 9,
        overdueTasks: 4,
        manualCallInvitations: 2,
        manualCallBookings: 1,
      },
      byAudience: [{ audience: 'investor', count: 120 }],
      byStage: [],
      bySource: [],
      sourceGroupsTruncated: false,
    };
    const fetcher = upstream({ metrics, documentProviderStatus: { status: 'disabled', reason: 'api_access_unavailable' } });
    const result = await GET(request('/api/crm/workflows?view=metrics&audience=investor'));
    expect(result.status).toBe(200);
    expect((await result.json()).totals.opportunities).toBe(120);
    expect((await (await GET(request('/api/crm/workflows?view=documentProviderStatus'))).json()).reason).toBe('api_access_unavailable');
    expect((await GET(request('/api/crm/workflows?view=metrics&actorUserId=' + randomUUID()))).status).toBe(400);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('outreach.metrics'))).toHaveLength(1);
  });
  it('rejects a well-formed task page outside the requested opportunity', async () => {
    upstream({
      listTasks: {
        items: [
          {
            task: {
              id: randomUUID(),
              opportunityId: randomUUID(),
              ownerUserId: userId,
              description: 'Foreign task',
              dueAt: now,
              status: 'pending',
              updatedAt: now,
            },
            revision: 1,
            kind: 'follow_up',
            createdAt: now,
          },
        ],
        nextCursor: null,
      },
    });
    expect((await GET(request(`/api/crm/workflows?view=listTasks&limit=50&opportunityId=${opportunityId}`))).status).toBe(502);
  });
  it.each(['valid', 'actor', 'request', 'target', 'revision'] as const)(
    'campaign receipt verifies immutable audit and requested fields: %s',
    async (wrong) => {
      const input = {
        id: randomUUID(),
        requestId: randomUUID(),
        expectedRevision: 0,
        name: 'Deck introduction',
        channel: 'deck',
        status: 'active',
        documentRef: null,
        providerLinkId: null,
        reason: 'Founder approved source campaign',
      };
      const result = {
        id: wrong === 'target' ? randomUUID() : input.id,
        revision: wrong === 'revision' ? 2 : 1,
        name: input.name,
        channel: input.channel,
        status: input.status,
        documentRef: null,
        providerLinkId: null,
        createdAt: now,
        updatedAt: now,
      };
      const evidence = audit(
        wrong === 'request' ? { ...input, requestId: randomUUID() } : input,
        'campaign',
        input.id,
        'campaign_written',
        wrong === 'actor' ? randomUUID() : userId,
      );
      const fetcher = upstream({ upsertCampaign: result, listWorkflowAudit: evidence });
      const response = await POST(request('/api/crm/workflows', 'POST', { action: 'upsertCampaign', input }));
      expect(response.status).toBe(wrong === 'valid' ? 200 : 502);
      expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(input);
      expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
    },
  );
  it('exports bounded originals with protected actor attribution and rejects supplied actor fields', async () => {
    const input = { requestId: randomUUID(), limit: 1, audience: 'investor' },
      exportId = randomUUID();
    const page = {
      exportId,
      generatedAt: now,
      items: [
        {
          submission,
          initialContact: submission.contact,
          firstCompletedAt: now,
          originalContact,
          canonicalContact,
          attribution: {
            sourceHint: null,
            sourceMappingId: null,
            sourceMappingRevision: null,
            campaign: null,
            recipientLinkage: 'unknown',
            capturedAt: now,
          },
        },
      ],
      nextCursor: null,
    };
    upstream({ exportSubmissions: page, listWorkflowAudit: audit(input, 'export', exportId, 'export_generated') });
    const result = await POST(request('/api/crm/workflows', 'POST', { action: 'exportSubmissions', input }));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await result.json()).items[0].submission.contactId).toBe(originalId);
    expect(
      (await POST(request('/api/crm/workflows', 'POST', { action: 'exportSubmissions', input: { ...input, actorUserId: userId } }))).status,
    ).toBe(400);
  });
  it.each(['createTask', 'transitionTask'] as const)('binds %s to task, opportunity revision and founder audit', async (action) => {
    const taskId = randomUUID();
    const input =
      action === 'createTask'
        ? {
            requestId: randomUUID(),
            opportunityId,
            expectedRevision: 2,
            ownerUserId: userId,
            description: 'Review original enquiry',
            dueAt: now,
            kind: 'follow_up',
            reason: 'Founder assigned follow-up',
          }
        : {
            requestId: randomUUID(),
            opportunityId,
            expectedRevision: 2,
            taskId,
            expectedTaskRevision: 1,
            status: 'completed',
            reason: 'Founder completed follow-up',
          };
    const result = {
      opportunity: { ...opportunity, revision: 3 },
      task: {
        task: {
          id: taskId,
          opportunityId,
          ownerUserId: userId,
          description: 'Review original enquiry',
          dueAt: now,
          status: action === 'createTask' ? 'pending' : 'completed',
          updatedAt: now,
        },
        kind: 'follow_up',
        revision: action === 'createTask' ? 1 : 2,
        createdAt: now,
      },
    };
    const evidence = audit(input, 'task', taskId, action === 'createTask' ? 'task_created' : 'task_transitioned');
    upstream({ [action]: result, listWorkflowAudit: evidence });
    expect((await POST(request('/api/crm/workflows', 'POST', { action, input }))).status).toBe(200);
    upstream({
      [action]: { ...result, task: { ...result.task, task: { ...result.task.task, opportunityId: randomUUID() } } },
      listWorkflowAudit: evidence,
    });
    expect((await POST(request('/api/crm/workflows', 'POST', { action, input }))).status).toBe(502);
  });
  it('merge confirms both chosen contacts and founder audit, refusing unconfirmed merge', async () => {
    const input = {
      requestId: randomUUID(),
      sourceContactId: originalId,
      targetContactId: canonicalId,
      sourceExpectedRevision: 2,
      targetExpectedRevision: 3,
      confirmed: true,
      reason: 'Founder manually verified the relationship',
    };
    const result = {
      mergeId: randomUUID(),
      sourceContactId: originalId,
      targetContactId: canonicalId,
      sourceRevision: 3,
      targetRevision: 4,
      movedOpportunityCount: 1,
      mergedAt: now,
    };
    upstream({ mergeContacts: result, listWorkflowAudit: audit(input, 'contact', originalId, 'contacts_merged') });
    expect((await POST(request('/api/crm/workflows', 'POST', { action: 'mergeContacts', input }))).status).toBe(200);
    expect(
      (await POST(request('/api/crm/workflows', 'POST', { action: 'mergeContacts', input: { ...input, confirmed: false } }))).status,
    ).toBe(400);
    upstream({ mergeContacts: { ...result, targetContactId: randomUUID() } });
    expect((await POST(request('/api/crm/workflows', 'POST', { action: 'mergeContacts', input }))).status).toBe(502);
  });
  it.each(['valid', 'actor', 'submission', 'reference', 'premature_acceptance'] as const)(
    'queue receipt is attributed original-recipient work, never an email acceptance claim: %s',
    async (wrong) => {
      const input = {
          requestId: randomUUID(),
          opportunityId,
          expectedRevision: 2,
          kind: 'information_request',
          staffText: 'Please share more information about your enquiry.',
          reason: 'Founder requests clarification',
        },
        messageId = randomUUID();
      const result = {
        opportunity: { ...opportunity, revision: 3 },
        message: {
          id: messageId,
          opportunityId,
          submissionId: wrong === 'submission' ? randomUUID() : submissionId,
          kind: input.kind,
          actorUserId: wrong === 'actor' ? randomUUID() : userId,
          status: wrong === 'premature_acceptance' ? 'accepted' : 'unconfigured',
          createdAt: now,
          notification: null,
        },
        activity: {
          id: randomUUID(),
          opportunityId,
          sequence: 1,
          kind: 'email_status',
          actor: { kind: 'operator', userId },
          note: 'Message queued: information_request',
          referenceId: wrong === 'reference' ? randomUUID() : messageId,
          occurredAt: now,
        },
      };
      const fetcher = upstream({ queueMessage: result });
      const response = await POST(request('/api/crm/workflows', 'POST', { action: 'queueMessage', input }));
      expect(response.status).toBe(wrong === 'valid' ? 200 : 502);
      expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(input);
      expect(
        (
          await POST(
            request('/api/crm/workflows', 'POST', {
              action: 'queueMessage',
              input: { ...input, recipientEmail: 'foreign@example.invalid' },
            }),
          )
        ).status,
      ).toBe(400);
    },
  );
  it('message pages bind the enquiry and enforce the requested bound', async () => {
    const message = {
      id: randomUUID(),
      opportunityId,
      submissionId,
      kind: 'follow_up',
      actorUserId: userId,
      status: 'unresolved',
      createdAt: now,
      notification: null,
    };
    upstream({ listMessages: { items: [message], nextCursor: null } });
    const url = `/api/crm/workflows?view=listMessages&opportunityId=${opportunityId}&limit=1`;
    expect((await GET(request(url))).status).toBe(200);
    upstream({ listMessages: { items: [{ ...message, opportunityId: randomUUID() }], nextCursor: null } });
    expect((await GET(request(url))).status).toBe(502);
    upstream({ listMessages: { items: [message, { ...message, id: randomUUID() }], nextCursor: null } });
    expect((await GET(request(url))).status).toBe(502);
  });
  it.each(['valid', 'missing_acceptance', 'foreign_business_key', 'delivered'] as const)(
    'message outcomes require bound gateway evidence and never claim delivery: %s',
    async (wrong) => {
      const id = randomUUID();
      const notification = {
        notificationId: randomUUID(),
        businessKey: wrong === 'foreign_business_key' ? `staff_message:${randomUUID()}` : `staff_message:${id}`,
        status: 'accepted',
        attemptedAt: now,
        acceptedAt: now,
        code: null,
        reference: 'synthetic-gateway-acceptance',
      };
      upstream({
        listMessages: {
          items: [
            {
              id,
              opportunityId,
              submissionId,
              kind: 'follow_up',
              actorUserId: userId,
              status: wrong === 'delivered' ? 'delivered' : 'accepted',
              createdAt: now,
              notification: wrong === 'missing_acceptance' ? null : notification,
            },
          ],
          nextCursor: null,
        },
      });
      expect((await GET(request(`/api/crm/workflows?view=listMessages&opportunityId=${opportunityId}&limit=1`))).status).toBe(
        wrong === 'valid' ? 200 : 502,
      );
    },
  );
  it.each(['valid', 'actor', 'foreign', 'sent'] as const)(
    'manual interaction binds the founder and never fabricates sent state: %s',
    async (wrong) => {
      const input = {
        requestId: randomUUID(),
        opportunityId,
        expectedRevision: 2,
        kind: 'follow_up',
        occurredAt: now,
        evidenceRef: 'owned-mail-reference',
        nextAction: { description: 'Review reply', dueAt: now },
        reason: 'Founder recorded the actual conversation',
      };
      const result = {
        opportunity: { ...opportunity, revision: 3 },
        interaction: {
          id: randomUUID(),
          opportunityId: wrong === 'foreign' ? randomUUID() : opportunityId,
          kind: 'follow_up',
          actorUserId: wrong === 'actor' ? randomUUID() : userId,
          status: wrong === 'sent' ? 'sent' : 'manually_recorded',
          evidenceRef: input.evidenceRef,
          occurredAt: now,
          recordedAt: now,
          scheduledAt: null,
        },
        activity: {
          id: randomUUID(),
          opportunityId,
          sequence: 1,
          kind: 'note',
          actor: { kind: 'operator', userId },
          note: input.reason,
          referenceId: input.evidenceRef,
          occurredAt: now,
        },
      };
      upstream({ recordInteraction: result, listWorkflowAudit: audit(input, 'opportunity', opportunityId, 'interaction_recorded') });
      const response = await POST(request('/api/crm/workflows', 'POST', { action: 'recordInteraction', input }));
      expect(response.status).toBe(wrong === 'valid' ? 200 : 502);
    },
  );
});
