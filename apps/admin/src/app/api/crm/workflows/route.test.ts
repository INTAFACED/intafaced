import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { GET as detailGet, POST as crmPost } from '../route';
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
// What a founder sees when listing or opening an enquiry: the record plus its derived reply state.
const replyState = { firstReplyAt: null, lastTouchAt: null, waitingSince: now };
const row = { ...opportunity, ...replyState };
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
  opportunity: row,
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
      getOpportunity: wrong === 'opportunity' ? { ...detail, opportunity: { ...row, id: randomUUID() } } : detail,
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
      raise: {
        indicated: [{ currency: 'EUR', amount: '350000.5' }],
        softCircled: [{ currency: 'EUR', amount: '250000' }],
        committed: [{ currency: 'EUR', amount: '100000' }],
        counts: { indicated: 2, softCircled: 1, committed: 1, undecided: 0 },
      },
    };
    const fetcher = upstream({ metrics, documentProviderStatus: { status: 'disabled', reason: 'api_access_unavailable' } });
    const result = await GET(request('/api/crm/workflows?view=metrics&audience=investor'));
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.totals.opportunities).toBe(120);
    // The raise reaches the console as exact decimal strings per currency, never summed across currencies.
    expect(body.raise.committed).toEqual([{ currency: 'EUR', amount: '100000' }]);
    expect(body.raise.indicated).toEqual([{ currency: 'EUR', amount: '350000.5' }]);
    // Upstream that sends the totals as numbers is not shown.
    upstream({ metrics: { ...metrics, raise: { ...metrics.raise, committed: [{ currency: 'EUR', amount: 100000 }] } } });
    expect((await GET(request('/api/crm/workflows?view=metrics'))).status).toBe(502);
    upstream({ metrics: { ...metrics, raise: undefined } });
    expect((await GET(request('/api/crm/workflows?view=metrics'))).status).toBe(502);
    upstream({ metrics, documentProviderStatus: { status: 'disabled', reason: 'api_access_unavailable' } });
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
          staffText: input.staffText,
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
  it.each(['valid', 'foreign', 'revision', 'text', 'due', 'stage_field', 'reason_field'] as const)(
    'next-action edit binds the enquiry, one revision on, and the asked text and time: %s',
    async (wrong) => {
      const input = {
        requestId: randomUUID(),
        opportunityId,
        expectedRevision: 2,
        description: 'Send the deck',
        dueAt: '2026-10-20T09:00:00.000Z',
      };
      const result = {
        ...opportunity,
        id: wrong === 'foreign' ? randomUUID() : opportunityId,
        revision: wrong === 'revision' ? 5 : 3,
        nextAction: {
          description: wrong === 'text' ? 'Something else' : input.description,
          dueAt: wrong === 'due' ? '2026-10-21T09:00:00.000Z' : input.dueAt,
        },
      };
      const fetcher = upstream({ updateNextAction: result });
      const sent =
        wrong === 'stage_field' ? { ...input, stage: 'closed' } : wrong === 'reason_field' ? { ...input, reason: 'Because' } : input;
      const response = await crmPost(request('/api/crm', 'POST', { action: 'updateNextAction', input: sent }));
      expect(response.status).toBe(wrong === 'valid' ? 200 : wrong === 'stage_field' || wrong === 'reason_field' ? 400 : 502);
      const toOps = () => fetcher.mock.calls.filter(([url]) => String(url).includes('/api/ops/'));
      if (wrong === 'stage_field' || wrong === 'reason_field') expect(toOps()).toHaveLength(0);
      else {
        expect(String(fetcher.mock.calls[1]?.[0])).toContain('outreach.updateNextAction');
        expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(input);
        expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
      }
      if (wrong === 'valid') expect((await response.json()).nextAction).toEqual({ description: input.description, dueAt: input.dueAt });
    },
  );
  it('next-action edit refuses a missing CSRF token and a supplied actor before any upstream call', async () => {
    const fetcher = upstream({});
    const input = { requestId: randomUUID(), opportunityId, expectedRevision: 2, description: 'x', dueAt: now };
    const incoming = request('/api/crm', 'POST', { action: 'updateNextAction', input });
    incoming.headers.delete('x-intafaced-csrf');
    expect((await crmPost(incoming)).status).toBe(403);
    expect(
      (await crmPost(request('/api/crm', 'POST', { action: 'updateNextAction', input: { ...input, actorUserId: userId } }))).status,
    ).toBe(400);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/ops/'))).toHaveLength(0);
  });
  it('list pages pass an alias match through and refuse one for an enquiry that is not on the page', async () => {
    const page = {
      items: [row],
      contacts: [canonicalContact],
      submissions: [{ submissionId, completedAt: null, organisationName: null }],
      nextCursor: null,
    };
    const alias = { opportunityId, name: 'Old Name' };
    upstream({ listOpportunities: { ...page, aliasMatches: [alias] } });
    const found = await detailGet(request('/api/crm?limit=50&query=old'));
    expect(found.status).toBe(200);
    expect((await found.json()).aliasMatches).toEqual([alias]);
    upstream({ listOpportunities: page });
    expect((await (await detailGet(request('/api/crm?limit=50'))).json()).aliasMatches).toBeUndefined();
    upstream({ listOpportunities: { ...page, aliasMatches: [{ ...alias, opportunityId: randomUUID() }] } });
    expect((await detailGet(request('/api/crm?limit=50&query=old'))).status).toBe(502);
  });
  it('message pages bind the enquiry and enforce the requested bound', async () => {
    const message = {
      id: randomUUID(),
      opportunityId,
      submissionId,
      kind: 'follow_up',
      staffText: 'Are you free on Friday?',
      actorUserId: userId,
      status: 'unresolved',
      createdAt: now,
      notification: null,
    };
    upstream({ listMessages: { items: [message], nextCursor: null } });
    const url = `/api/crm/workflows?view=listMessages&opportunityId=${opportunityId}&limit=1`;
    const page = await GET(request(url));
    expect(page.status).toBe(200);
    // The founder's own text reaches the console; a message saved before the field existed reads as null, not as a fault.
    expect((await page.json()).items[0].staffText).toBe('Are you free on Friday?');
    const { staffText: _omitted, ...withoutText } = message;
    upstream({ listMessages: { items: [withoutText], nextCursor: null } });
    const old = await GET(request(url));
    expect(old.status).toBe(200);
    expect((await old.json()).items[0].staffText).toBeNull();
    upstream({ listMessages: { items: [{ ...message, staffText: null }], nextCursor: null } });
    expect((await (await GET(request(url))).json()).items[0].staffText).toBeNull();
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
              staffText: 'Are you free on Friday?',
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
  describe('reply sent outside the console', () => {
    const input = (extra: Record<string, unknown> = {}) => ({
      requestId: randomUUID(),
      opportunityId,
      expectedRevision: 2,
      kind: 'reply_sent',
      occurredAt: now,
      nextAction: { description: 'Check in', dueAt: now },
      reason: 'Replied from Gmail',
      ...extra,
    });
    const receipt = (body: Record<string, unknown>, extra: { evidenceRef?: string | null; kind?: string } = {}) => ({
      opportunity: { ...opportunity, revision: 3 },
      interaction: {
        id: randomUUID(),
        opportunityId,
        kind: extra.kind ?? 'reply_sent',
        actorUserId: userId,
        status: 'manually_recorded',
        evidenceRef: extra.evidenceRef === undefined ? (body.evidenceRef ?? null) : extra.evidenceRef,
        occurredAt: now,
        recordedAt: now,
        scheduledAt: null,
      },
      activity: {
        id: randomUUID(),
        opportunityId,
        sequence: 1,
        kind: 'reply_sent',
        actor: { kind: 'operator', userId },
        note: body.reason,
        referenceId: body.evidenceRef ?? null,
        occurredAt: now,
      },
    });
    it('passes a reply with no evidence reference through and checks the receipt says the same', async () => {
      const body = input();
      const fetcher = upstream({
        recordInteraction: receipt(body),
        listWorkflowAudit: audit(body, 'opportunity', opportunityId, 'interaction_recorded'),
      });
      const response = await POST(request('/api/crm/workflows', 'POST', { action: 'recordInteraction', input: body }));
      expect(response.status).toBe(200);
      expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(body);
      expect((await response.json()).interaction.evidenceRef).toBeNull();
    });
    it('keeps an evidence reference when one is given, and refuses a receipt that drops or invents one', async () => {
      const body = input({ evidenceRef: 'gmail-thread-18f2' });
      const evidence = audit(body, 'opportunity', opportunityId, 'interaction_recorded');
      upstream({ recordInteraction: receipt(body), listWorkflowAudit: evidence });
      expect((await POST(request('/api/crm/workflows', 'POST', { action: 'recordInteraction', input: body }))).status).toBe(200);
      upstream({ recordInteraction: receipt(body, { evidenceRef: null }), listWorkflowAudit: evidence });
      expect((await POST(request('/api/crm/workflows', 'POST', { action: 'recordInteraction', input: body }))).status).toBe(502);
      const bare = input();
      upstream({
        recordInteraction: receipt(bare, { evidenceRef: 'invented' }),
        listWorkflowAudit: audit(bare, 'opportunity', opportunityId, 'interaction_recorded'),
      });
      expect((await POST(request('/api/crm/workflows', 'POST', { action: 'recordInteraction', input: bare }))).status).toBe(502);
    });
    it('still needs evidence for the other kinds, and a reason and next step for a reply', async () => {
      const fetcher = upstream({});
      const post = (body: unknown) => POST(request('/api/crm/workflows', 'POST', { action: 'recordInteraction', input: body }));
      expect((await post(input({ kind: 'follow_up' }))).status).toBe(400);
      expect((await post(input({ reason: undefined }))).status).toBe(400);
      expect((await post(input({ nextAction: undefined }))).status).toBe(400);
      expect((await post(input({ actorUserId: userId }))).status).toBe(400);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/ops/'))).toHaveLength(0);
    });
  });
  describe('commitment', () => {
    const input = (extra: Record<string, unknown> = {}) => ({
      requestId: randomUUID(),
      opportunityId,
      expectedRevision: 2,
      commitment: { tier: 'soft_circled', amount: '250000', currency: 'EUR', evidenceRef: 'call notes' },
      reason: 'After the call',
      ...extra,
    });
    const saved = (body: ReturnType<typeof input>, patch: Record<string, unknown> = {}) => ({
      ...opportunity,
      revision: 3,
      commitment: body.commitment === null ? null : { ...body.commitment, recordedAt: now, recordedBy: userId },
      ...patch,
    });
    const send = (body: unknown) => POST(request('/api/crm/workflows', 'POST', { action: 'setCommitment', input: body }));
    it('passes a commitment through, verifies the receipt and the founder audit, and keeps the amount a string', async () => {
      const body = input({ commitment: { tier: 'committed', amount: '12345678901234567890.123456789', currency: 'EUR' } });
      const fetcher = upstream({
        setCommitment: saved(body),
        listWorkflowAudit: audit(body, 'opportunity', opportunityId, 'commitment_changed'),
      });
      const response = await send(body);
      expect(response.status).toBe(200);
      expect(String(fetcher.mock.calls[1]?.[0])).toContain('outreach.setCommitment');
      expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(body);
      expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
      expect((await response.json()).commitment.amount).toBe('12345678901234567890.123456789');
    });
    it('clears a commitment', async () => {
      const body = input({ commitment: null });
      upstream({ setCommitment: saved(body), listWorkflowAudit: audit(body, 'opportunity', opportunityId, 'commitment_changed') });
      const response = await send(body);
      expect(response.status).toBe(200);
      expect((await response.json()).commitment).toBeNull();
    });
    it.each([
      'foreign',
      'revision',
      'tier',
      'amount',
      'currency',
      'cleared',
      'invented',
      'author',
      'audience',
      'audit_actor',
      'audit_kind',
    ] as const)('refuses a receipt or audit that does not match what was asked: %s', async (wrong) => {
      // "invented": the founder asked to clear it and the receipt still carries one.
      const body = wrong === 'invented' ? input({ commitment: null }) : input();
      const commitment = { ...input().commitment!, recordedAt: now, recordedBy: userId };
      const result = {
        foreign: saved(body, { id: randomUUID() }),
        revision: saved(body, { revision: 9 }),
        tier: saved(body, { commitment: { ...commitment, tier: 'committed' } }),
        amount: saved(body, { commitment: { ...commitment, amount: '250001' } }),
        currency: saved(body, { commitment: { ...commitment, currency: 'USD' } }),
        cleared: saved(body, { commitment: null }),
        invented: saved(body, { commitment }),
        author: saved(body, { commitment: { ...commitment, recordedBy: randomUUID() } }),
        audience: { ...saved(body), audience: 'trader', stage: 'new', indicativeContribution: undefined, commitment: undefined },
        audit_actor: saved(body),
        audit_kind: saved(body),
      }[wrong];
      const evidence = audit(
        body,
        'opportunity',
        opportunityId,
        wrong === 'audit_kind' ? 'stage_changed' : 'commitment_changed',
        wrong === 'audit_actor' ? randomUUID() : userId,
      );
      upstream({ setCommitment: result, listWorkflowAudit: evidence });
      expect((await send(body)).status).toBe(502);
    });
    it('refuses bad money, an unknown currency, a smuggled identity and a missing reason before anything leaves the console', async () => {
      const fetcher = upstream({});
      for (const bad of [
        input({ commitment: { tier: 'committed', amount: '-5', currency: 'EUR' } }),
        input({ commitment: { tier: 'committed', amount: '1e6', currency: 'EUR' } }),
        input({ commitment: { tier: 'committed', amount: 100, currency: 'EUR' } }),
        input({ commitment: { tier: 'committed', amount: '0', currency: 'EUR' } }),
        input({ commitment: { tier: 'committed', amount: '100', currency: 'ZZZ' } }),
        input({ commitment: { tier: 'received', amount: '100', currency: 'EUR' } }),
        input({ commitment: { tier: 'committed', amount: '100', currency: 'EUR', recordedBy: userId } }),
        input({ actorUserId: userId }),
        input({ reason: '' }),
        input({ commitment: undefined }),
      ])
        expect((await send(bad)).status).toBe(400);
      const incoming = request('/api/crm/workflows', 'POST', { action: 'setCommitment', input: input() });
      incoming.headers.delete('x-intafaced-csrf');
      expect((await POST(incoming)).status).toBe(403);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/ops/'))).toHaveLength(0);
    });
    it('shows the service refusing a commitment on a non-investor as a refusal, with its status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (url) =>
          String(url).includes('operatorStatus')
            ? Response.json({ result: { data: enabled } })
            : Response.json({ error: { message: 'ops.crm.commitment_investor_only' } }, { status: 412 }),
        ),
      );
      const response = await send(input());
      expect(response.status).toBe(412);
      expect(await response.json()).toEqual({ code: 'admin.upstream_refused' });
    });
  });
  describe('waiting queue', () => {
    const waiting = (items: unknown[]) => ({
      items,
      contacts: [canonicalContact],
      submissions: [{ submissionId, completedAt: null, organisationName: null }],
      nextCursor: null,
    });
    const at = (hours: number) => new Date(Date.parse(now) + hours * 3_600_000).toISOString();
    it('passes queue=waiting to the service and returns the rows with their waiting time', async () => {
      const fetcher = upstream({ listOpportunities: waiting([{ ...row, waitingSince: at(-5) }]) });
      const response = await detailGet(request('/api/crm?limit=50&queue=waiting'));
      expect(response.status).toBe(200);
      const call = fetcher.mock.calls.find(([url]) => String(url).includes('outreach.listOpportunities'))!;
      expect(JSON.parse(new URL(String(call[0])).searchParams.get('input')!)).toEqual({ limit: 50, queue: 'waiting' });
      expect((await response.json()).items[0]).toMatchObject({ firstReplyAt: null, lastTouchAt: null, waitingSince: at(-5) });
    });
    it('refuses an unknown queue name', async () => {
      const fetcher = upstream({});
      expect((await detailGet(request('/api/crm?limit=50&queue=overdue'))).status).toBe(400);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/api/ops/'))).toHaveLength(0);
    });
    it('does not show a queue that is out of order, includes a closed enquiry or has no waiting time', async () => {
      const second = { ...row, id: randomUUID(), contactId: canonicalId, submissionId };
      upstream({
        listOpportunities: waiting([
          { ...row, waitingSince: at(-5) },
          { ...second, waitingSince: at(-4) },
        ]),
      });
      expect((await detailGet(request('/api/crm?limit=50&queue=waiting'))).status).toBe(200);
      upstream({
        listOpportunities: waiting([
          { ...row, waitingSince: at(-4) },
          { ...second, waitingSince: at(-5) },
        ]),
      });
      expect((await detailGet(request('/api/crm?limit=50&queue=waiting'))).status).toBe(502);
      // The same order is fine in the default listing, which makes no such promise.
      expect((await detailGet(request('/api/crm?limit=50'))).status).toBe(200);
      const closed = {
        ...row,
        stage: 'closed',
        nextAction: null,
        closedDisposition: 'declined',
        closingEvidenceRef: 'no',
        waitingSince: null,
      };
      upstream({ listOpportunities: waiting([closed]) });
      expect((await detailGet(request('/api/crm?limit=50&queue=waiting'))).status).toBe(502);
      expect((await detailGet(request('/api/crm?limit=50'))).status).toBe(200);
      upstream({ listOpportunities: waiting([row].map(({ waitingSince: _w, ...rest }) => rest)) });
      expect((await detailGet(request('/api/crm?limit=50&queue=waiting'))).status).toBe(502);
    });
  });
});
