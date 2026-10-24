import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { ADMIN_COOKIE, adminSessionConfig, sealFounderSession, type FounderSession } from '@/lib/founder-session';
import { privacyWrite, PrivacyReviewedStateChanged, type PendingPrivacyWrite } from '@/components/crm-privacy';

const original = { ...process.env },
  now = new Date().toISOString();
const userId = randomUUID(),
  canonicalContactId = randomUUID(),
  intentId = randomUUID(),
  submissionId = randomUUID();
const session: FounderSession = {
  userId,
  accessToken: 'actual-founder-token',
  refreshToken: 'private-refresh-token',
  issuedAt: now,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  csrf: randomBytes(32).toString('base64url'),
};
const preview = {
  canonicalContactId,
  canonicalRevision: 2,
  contacts: [{ contactId: canonicalContactId, revision: 2 }],
  submissionIds: [submissionId],
  counts: { contacts: 1, submissions: 1, opportunities: 1, tasks: 1, messages: 1 },
  snapshot: 'a'.repeat(64),
};
const pending = {
  intentId,
  canonicalContactId,
  revision: 1,
  status: 'pending_notify',
  actorKind: 'founder',
  requestedBy: userId,
  requestedAt: now,
  completedAt: null,
  pendingSubmissionCount: 1,
  code: null,
};
const review = {
  reviewId: randomUUID(),
  canonicalContactId,
  revision: 1,
  state: 'active',
  reviewedBy: userId,
  reviewedAt: now,
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  evidenceRef: 'call-2026-10-11',
  reason: 'Ongoing discussion confirmed.',
};
const begin = {
  requestId: randomUUID(),
  canonicalContactId,
  expectedCanonicalRevision: 2,
  snapshot: preview.snapshot,
  confirmedEntireCluster: true as const,
  reason: 'confirmed_privacy_request' as const,
};
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://admin.example${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      cookie: `${ADMIN_COOKIE}=${sealFounderSession(session, adminSessionConfig())}`,
      ...(body ? { origin: 'https://admin.example', 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function upstream(values: Record<string, unknown>) {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const action = String(url).split('/trpc/')[1]?.split('?')[0]?.split('.').at(-1) ?? '';
    if (action === 'operatorStatus')
      return Response.json({ result: { data: { status: 'enabled', userId, version: '1', changedAt: now } } });
    return Response.json({ result: { data: values[action] } });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => {
  process.env.ADMIN_ORIGIN = 'https://admin.example';
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_SESSION_SECRET = randomBytes(32).toString('base64url');
  process.env.ADMIN_OPERATOR_TOKEN = 'must-not-be-used';
});
afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('founder-only privacy BFF', () => {
  it('recovers an existing intent by canonical contact alone using only a private read and the current founder', async () => {
    const receipt = { ...pending, requestedBy: randomUUID() };
    const fetcher = upstream({ privacyStatus: receipt });
    const response = await GET(request(`/api/crm/privacy?view=privacyStatus&canonicalContactId=${canonicalContactId}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const [url, options] = fetcher.mock.calls[1]!;
    expect(JSON.parse(new URL(String(url)).searchParams.get('input')!)).toEqual({ canonicalContactId });
    expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it.each(['canonical', 'intent'] as const)('rejects a mismatched recovery receipt: %s', async (wrong) => {
    upstream({
      privacyStatus: { ...pending, ...(wrong === 'canonical' ? { canonicalContactId: randomUUID() } : { intentId: randomUUID() }) },
    });
    const suffix = wrong === 'intent' ? `&intentId=${intentId}` : '';
    expect((await GET(request(`/api/crm/privacy?view=privacyStatus&canonicalContactId=${canonicalContactId}${suffix}`))).status).toBe(502);
  });
  it.each([
    '',
    `&intentId=${intentId}`,
    '&canonicalContactId=invalid',
    `&canonicalContactId=${canonicalContactId}&email=private@example.invalid`,
    `&canonicalContactId=${canonicalContactId}&canonicalContactId=${canonicalContactId}`,
    `&canonicalContactId=${canonicalContactId}&intentId=invalid`,
  ])('rejects invalid recovery selection before OPS: %s', async (suffix) => {
    const fetcher = upstream({});
    expect((await GET(request(`/api/crm/privacy?view=privacyStatus${suffix}`))).status).toBe(400);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('keeps known-intent canonical binding while sending only the strict intent selector upstream', async () => {
    const fetcher = upstream({ privacyStatus: pending });
    expect(
      (await GET(request(`/api/crm/privacy?view=privacyStatus&intentId=${intentId}&canonicalContactId=${canonicalContactId}`))).status,
    ).toBe(200);
    expect(JSON.parse(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('input')!)).toEqual({ intentId });
  });
  it('does not substitute missing intents with successful or newly started erasure', async () => {
    const fetcher = upstream({});
    fetcher.mockImplementationOnce(async () =>
      Response.json({ result: { data: { status: 'enabled', userId, version: '1', changedAt: now } } }),
    );
    fetcher.mockImplementationOnce(async () => Response.json({ error: { message: 'ops.crm.erasure_not_found' } }, { status: 412 }));
    const response = await GET(request(`/api/crm/privacy?view=privacyStatus&canonicalContactId=${canonicalContactId}`));
    expect(response.status).toBe(412);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('requires live founder authority for canonical recovery and refuses anonymous or revoked sessions before OPS', async () => {
    const path = `/api/crm/privacy?view=privacyStatus&canonicalContactId=${canonicalContactId}`;
    const fetcher = upstream({ privacyStatus: pending });
    expect((await GET(new Request(`https://admin.example${path}`))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockImplementation(async () =>
      Response.json({ result: { data: { status: 'revoked', userId, version: '2', changedAt: now } } }),
    );
    expect((await GET(request(path))).status).toBe(403);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses only the interactive founder credential, strict preview binding and no-store output', async () => {
    const fetcher = upstream({
      privacyPreview: preview,
      privacyRetentionStatus: { status: 'disabled', reason: 'published_policy_unconfigured' },
    });
    const response = await GET(request(`/api/crm/privacy?view=privacyPreview&canonicalContactId=${canonicalContactId}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(preview);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await GET(request('/api/crm/privacy?view=privacyRetentionStatus'))).status).toBe(200);
    for (const [, options] of fetcher.mock.calls)
      expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
  });
  it('returns configured retention policy fields without downgrading them to unavailable', async () => {
    const configured = {
      status: 'configured',
      inactivityCalendarMonths: 6,
      clockTimeZone: 'UTC',
      activeReviewMaxDays: 30,
      automationEnabled: false,
      lastSweepAt: now,
    };
    const fetcher = upstream({ privacyRetentionStatus: configured });
    const response = await GET(request('/api/crm/privacy?view=privacyRetentionStatus'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(configured);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
  });
  it('binds the private review lookup to exactly one selected canonical contact', async () => {
    const fetcher = upstream({ privacyRetentionReviewStatus: review });
    const response = await GET(request(`/api/crm/privacy?view=privacyRetentionReviewStatus&canonicalContactId=${canonicalContactId}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(review);
    expect(JSON.parse(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('input')!)).toEqual({ canonicalContactId });
    expect(
      (await GET(request(`/api/crm/privacy?view=privacyRetentionReviewStatus&canonicalContactId=${randomUUID()}&email=x`))).status,
    ).toBe(400);
    fetcher.mockImplementation(async (url) => {
      if (String(url).includes('/operatorStatus'))
        return Response.json({ result: { data: { status: 'enabled', userId, version: '1', changedAt: now } } });
      return Response.json({ result: { data: { ...review, canonicalContactId: randomUUID() } } });
    });
    expect((await GET(request(`/api/crm/privacy?view=privacyRetentionReviewStatus&canonicalContactId=${canonicalContactId}`))).status).toBe(
      502,
    );
  });
  it('requires live founder, exact origin/CSRF, strict review input, and binds the receipt to actor and selected revision', async () => {
    const input = {
      requestId: randomUUID(),
      canonicalContactId,
      expectedCanonicalRevision: 2,
      expectedReviewRevision: 0,
      state: 'active',
      evidenceRef: 'call-2026-10-11',
      reason: 'Ongoing discussion confirmed.',
    };
    const fetcher = upstream({ privacyRetentionReview: review });
    expect(
      (
        await POST(
          new Request('https://admin.example/api/crm/privacy', {
            method: 'POST',
            headers: { origin: 'https://admin.example', 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
            body: JSON.stringify({ action: 'privacyRetentionReview', input }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await POST(request('/api/crm/privacy', { action: 'privacyRetentionReview', input }, { origin: 'https://foreign.example' }))).status,
    ).toBe(403);
    expect((await POST(request('/api/crm/privacy', { action: 'privacyRetentionReview', input }, { 'x-intafaced-csrf': '' }))).status).toBe(
      403,
    );
    expect(
      (await POST(request('/api/crm/privacy', { action: 'privacyRetentionReview', input: { ...input, reviewedBy: userId } }))).status,
    ).toBe(400);
    expect(fetcher.mock.calls.filter(([url]) => !String(url).includes('consoleMode.get'))).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('accountControls.operatorStatus');
    const success = await POST(request('/api/crm/privacy', { action: 'privacyRetentionReview', input }));
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual(review);
    const upstreamWrite = fetcher.mock.calls.find(([url]) => String(url).includes('/outreach.privacyRetentionReview'));
    expect(JSON.parse(String(upstreamWrite?.[1]?.body))).toEqual(input);
    expect(new Headers(upstreamWrite?.[1]?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
  });
  it.each(['canonical', 'actor', 'revision', 'state', 'evidence'] as const)('refuses mismatched review receipt: %s', async (mismatch) => {
    const input = {
      requestId: randomUUID(),
      canonicalContactId,
      expectedCanonicalRevision: 2,
      expectedReviewRevision: 0,
      state: 'active',
      evidenceRef: 'call-2026-10-11',
      reason: 'Ongoing discussion confirmed.',
    };
    const receipt = {
      ...review,
      ...(mismatch === 'canonical' ? { canonicalContactId: randomUUID() } : {}),
      ...(mismatch === 'actor' ? { reviewedBy: randomUUID() } : {}),
      ...(mismatch === 'revision' ? { revision: 2 } : {}),
      ...(mismatch === 'state' ? { state: 'inactive', expiresAt: null } : {}),
      ...(mismatch === 'evidence' ? { evidenceRef: 'other-ref' } : {}),
    };
    upstream({ privacyRetentionReview: receipt });
    expect((await POST(request('/api/crm/privacy', { action: 'privacyRetentionReview', input }))).status).toBe(502);
  });
  it('returns a typed OPS revision refusal without claiming a review was saved', async () => {
    const input = {
      requestId: randomUUID(),
      canonicalContactId,
      expectedCanonicalRevision: 2,
      expectedReviewRevision: 0,
      state: 'inactive',
      evidenceRef: 'meeting-note-19',
      reason: 'Discussion concluded.',
    };
    const fetcher = upstream({});
    fetcher.mockImplementation(async (url) =>
      String(url).includes('operatorStatus')
        ? Response.json({ result: { data: { status: 'enabled', userId, version: '1', changedAt: now } } })
        : Response.json({ error: { message: 'ops.crm.revision_conflict' } }, { status: 412 }),
    );
    const response = await POST(request('/api/crm/privacy', { action: 'privacyRetentionReview', input }));
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ code: 'admin.upstream_refused', upstream: 'ops.crm.revision_conflict' });
    expect(fetcher.mock.calls.filter(([url]) => !String(url).includes('consoleMode.get'))).toHaveLength(2);
  });
  it.each(['foreign', 'duplicate', 'count', 'revision', 'extra'] as const)('refuses an invalid canonical preview: %s', async (wrong) => {
    upstream({
      privacyPreview: {
        ...preview,
        ...(wrong === 'foreign'
          ? { canonicalContactId: randomUUID() }
          : wrong === 'duplicate'
            ? { contacts: [...preview.contacts, ...preview.contacts] }
            : wrong === 'count'
              ? { counts: { ...preview.counts, submissions: 2 } }
              : wrong === 'revision'
                ? { canonicalRevision: 3 }
                : { email: 'must-not-be-returned@example.invalid' }),
      },
    });
    expect((await GET(request(`/api/crm/privacy?view=privacyPreview&canonicalContactId=${canonicalContactId}`))).status).toBe(502);
  });
  it('anonymous, cross-origin and missing-CSRF commands refuse before identity or OPS, and no request body supplies authority', async () => {
    const fetcher = upstream({});
    expect(
      (await GET(new Request(`https://admin.example/api/crm/privacy?view=privacyPreview&canonicalContactId=${canonicalContactId}`))).status,
    ).toBe(401);
    expect(
      (await POST(request('/api/crm/privacy', { action: 'privacyBegin', input: begin }, { origin: 'https://foreign.example' }))).status,
    ).toBe(403);
    expect((await POST(request('/api/crm/privacy', { action: 'privacyBegin', input: begin }, { 'x-intafaced-csrf': '' }))).status).toBe(
      403,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await POST(request('/api/crm/privacy', { action: 'privacyBegin', input: { ...begin, actorUserId: randomUUID() } }))).status,
    ).toBe(400);
    expect(fetcher.mock.calls.filter(([url]) => !String(url).includes('consoleMode.get'))).toHaveLength(1);
  });
  it.each(['valid', 'actor', 'canonical'] as const)(
    'binds begin receipt to canonical selection and the current founder: %s',
    async (wrong) => {
      const fetcher = upstream({
        privacyBegin: {
          ...pending,
          ...(wrong === 'actor' ? { requestedBy: randomUUID() } : wrong === 'canonical' ? { canonicalContactId: randomUUID() } : {}),
        },
      });
      const response = await POST(request('/api/crm/privacy', { action: 'privacyBegin', input: begin }));
      expect(response.status).toBe(wrong === 'valid' ? 200 : 502);
      expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual(begin);
    },
  );
  it.each(['valid', 'intent', 'canonical', 'actor', 'revision', 'completion'] as const)(
    'binds advancement to existing intent lineage without requiring the original founder to act: %s',
    async (wrong) => {
      const otherFounder = randomUUID(),
        before = { ...pending, requestedBy: otherFounder };
      const after = {
        ...before,
        revision: 2,
        code: 'ops.crm.notification_unconfigured',
        ...(wrong === 'intent'
          ? { intentId: randomUUID() }
          : wrong === 'canonical'
            ? { canonicalContactId: randomUUID() }
            : wrong === 'actor'
              ? { requestedBy: userId }
              : wrong === 'revision'
                ? { revision: 1 }
                : wrong === 'completion'
                  ? { status: 'complete', completedAt: now }
                  : {}),
      };
      upstream({ privacyStatus: before, privacyAdvance: after });
      const response = await POST(
        request('/api/crm/privacy', {
          action: 'privacyAdvance',
          canonicalContactId,
          input: { requestId: randomUUID(), intentId, expectedRevision: 1 },
        }),
      );
      expect(response.status).toBe(wrong === 'valid' ? 200 : 502);
    },
  );
  it('rechecks live founder authority even for retry/status and rejects status for another canonical contact', async () => {
    const fetcher = upstream({ privacyStatus: { ...pending, canonicalContactId: randomUUID() } });
    expect(
      (await GET(request(`/api/crm/privacy?view=privacyStatus&intentId=${intentId}&canonicalContactId=${canonicalContactId}`))).status,
    ).toBe(502);
    fetcher.mockImplementation(async () =>
      Response.json({ result: { data: { status: 'revoked', userId, version: '2', changedAt: now } } }),
    );
    expect((await POST(request('/api/crm/privacy', { action: 'privacyBegin', input: begin }))).status).toBe(403);
  });
});
describe('explicit privacy command recovery', () => {
  it.each([true, false])('clears the stale command only after a typed precondition refusal: verified=%s', async (verified) => {
    const commands = new Map<string, PendingPrivacyWrite>();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: verified ? 'admin.upstream_refused' : 'unexpected' }, { status: 412 })),
    );
    const { requestId: unused, ...input } = begin;
    void unused;
    if (verified)
      await expect(privacyWrite(session.csrf, commands, 'privacyBegin', input, canonicalContactId)).rejects.toBeInstanceOf(
        PrivacyReviewedStateChanged,
      );
    else await expect(privacyWrite(session.csrf, commands, 'privacyBegin', input, canonicalContactId)).rejects.toThrow('unconfirmed');
    expect(commands.size).toBe(verified ? 0 : 1);
  });
  it('retains the exact UUID and reviewed snapshot after a lost or malformed receipt, and clears only after validated success', async () => {
    const commands = new Map<string, PendingPrivacyWrite>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('Lost response'))
      .mockResolvedValueOnce(Response.json({ ...pending, canonicalContactId: randomUUID() }))
      .mockResolvedValueOnce(Response.json(pending));
    vi.stubGlobal('fetch', fetcher);
    const { requestId: unused, ...input } = begin;
    void unused;
    await expect(privacyWrite(session.csrf, commands, 'privacyBegin', input, canonicalContactId)).rejects.toThrow();
    const firstBody = fetcher.mock.calls[0]?.[1]?.body;
    await expect(privacyWrite(session.csrf, commands, 'privacyBegin', input, canonicalContactId)).rejects.toThrow();
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(firstBody);
    expect(await privacyWrite(session.csrf, commands, 'privacyBegin', input, canonicalContactId)).toEqual(pending);
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(firstBody);
    expect(commands.size).toBe(0);
    for (const [path, options] of fetcher.mock.calls) {
      expect(path).toBe('/api/crm/privacy');
      expect(new Headers(options?.headers).get('x-intafaced-csrf')).toBe(session.csrf);
      expect(new Headers(options?.headers).has('authorization')).toBe(false);
    }
  });
  it('changed reviewed input creates a new intent UUID; a pending response never auto-advances or sends mail', async () => {
    const commands = new Map<string, PendingPrivacyWrite>();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Lost')).mockResolvedValueOnce(Response.json(pending));
    vi.stubGlobal('fetch', fetcher);
    const { requestId: unused, ...input } = begin;
    void unused;
    await expect(privacyWrite(session.csrf, commands, 'privacyBegin', input, canonicalContactId)).rejects.toThrow();
    await privacyWrite(session.csrf, commands, 'privacyBegin', { ...input, snapshot: 'b'.repeat(64) }, canonicalContactId);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).input.requestId).not.toBe(
      JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).input.requestId,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
