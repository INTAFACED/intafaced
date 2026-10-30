import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const ctx = {
  session: {
    userId: FOUNDER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ok = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string) =>
  Response.json({ error: { message, code: -32603, data: { code: 'X', httpStatus: status } } }, { status });
const ticket = (over: Record<string, unknown> = {}) => ({
  id: T1,
  userId: U,
  category: 'account',
  subject: 'Cannot sign in',
  body: 'I forgot my authenticator',
  status: 'open',
  assigneeId: null,
  createdAt: '2026-10-17T02:00:00.000Z',
  updatedAt: '2026-10-17T02:00:00.000Z',
  ...over,
});
const entry = {
  ticketId: T1,
  userId: U,
  category: 'account',
  status: 'open',
  subject: 'Cannot sign in',
  score: 10,
  ageMs: 60_000,
  createdAt: '2026-10-17T02:00:00.000Z',
  timingKind: 'score_not_promise',
  sla: false,
};
const get = (query = '') => GET(new Request(`http://admin.example/api/support${query}`));
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/support', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('GET queue', () => {
  it('reads listQueue as the founder with an explicit page size and returns it with an as-of time', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok({ status: 'ok', entries: [entry] }));
    vi.stubGlobal('fetch', fn);
    const json = await (await get()).json();
    expect(json.queue).toMatchObject({ kind: 'ok', data: { limit: 100, entries: [{ ticketId: T1 }] } });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe(`http://edge:4000/api/support/trpc/listQueue?input=${encodeURIComponent('{"limit":100}')}`);
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('an empty queue is reported as empty only when svc-support says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ status: 'empty' })),
    );
    expect((await (await get()).json()).queue).toMatchObject({ kind: 'ok', data: { entries: [] } });
  });
  it('a founder without the support-staff permission sees why, not an empty queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'Missing scope support:ops')),
    );
    const json = await (await get()).json();
    expect(json.queue).toMatchObject({ kind: 'failed', forbidden: true });
    expect(json.queue.message).toContain('support:ops');
    expect(json.queue).not.toHaveProperty('data');
  });
  it('a malformed answer is a failure, not an empty queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ status: 'ok', entries: [{ ticketId: 'x' }] })),
    );
    expect((await (await get()).json()).queue).toMatchObject({ kind: 'failed' });
  });
  it('a refused session returns before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET ticket', () => {
  it('rejects a ticket id that is not a UUID before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await get('?view=ticket&id=../../etc')).status).toBe(400);
    expect((await get('?view=ticket')).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('reads the ticket, its comments and its history, each on its own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/get')) return ok(ticket());
        if (url.includes('listComments')) return trpcErr(503, 'down');
        return ok([]);
      }),
    );
    const json = await (await get(`?view=ticket&id=${T1}`)).json();
    expect(json.detail.kind).toBe('ok');
    expect(json.detail.data.ticket.subject).toBe('Cannot sign in');
    expect(json.detail.data.comments).toMatchObject({ kind: 'failed' });
    expect(json.detail.data.events).toMatchObject({ kind: 'ok', data: [] });
  });
});

describe('POST claim', () => {
  it('refuses anything but a claim of one ticket id before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const body of [{}, { action: 'claim' }, { action: 'claim', ticketId: 'x' }, { action: 'assign', ticketId: T1 }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('claims as the founder and reports the owner the service returned', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(ticket({ assigneeId: FOUNDER })));
    vi.stubGlobal('fetch', fn);
    const res = await post({ action: 'claim', ticketId: T1 });
    expect(await res.json()).toMatchObject({ ok: true, ticketId: T1, assigneeId: FOUNDER });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/support/trpc/claim');
    expect(JSON.parse(init!.body as string)).toEqual({ ticketId: T1 });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('a ticket someone else already claimed is a refusal that changed nothing, in the service’s words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(409, 'This ticket is already claimed')),
    );
    const res = await post({ action: 'claim', ticketId: T1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { body: 'This ticket is already claimed', changed: 'no' } });
  });
  it('a founder without the permission is told so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'Missing scope')),
    );
    const json = await (await post({ action: 'claim', ticketId: T1 })).json();
    expect(json.refusal.title).toBe('Your console session does not have support operations permission');
  });
  it('a dropped connection is "not known"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('hang up');
      }),
    );
    const res = await post({ action: 'claim', ticketId: T1 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ refusal: { changed: 'unknown' } });
  });
  it('logs the founder and the ticket', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(ticket({ assigneeId: FOUNDER }))),
    );
    await post({ action: 'claim', ticketId: T1 });
    expect(JSON.parse(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0]))).toMatchObject({
      audit: 'admin.support_claim',
      founder: FOUNDER,
      ticketId: T1,
      outcome: 'ok',
    });
  });
});

describe('GET extras and articles', () => {
  const caseFile = {
    ticketId: T1,
    escalatedBy: FOUNDER,
    reason: 'other',
    citations: [{ kind: 'ticket_comment', ref: U, digest: 'a'.repeat(64), readAt: '2026-10-17T03:00:00.000Z' }],
    grounding: { status: 'unread', reason: 'plane_dark' },
    summary: 'Needs identity review',
    createdAt: '2026-10-17T03:00:00.000Z',
  };
  const rating = { ticketId: T1, userId: U, score: 4, note: 'ok', createdAt: '2026-10-17T04:00:00.000Z' };

  it('reads the case file and the rating as the founder, each on its own', async () => {
    const fn = vi.fn(async (url: string, _init?: RequestInit) => (url.includes('/caseFile') ? ok(caseFile) : ok(rating)));
    vi.stubGlobal('fetch', fn);
    const json = await (await get(`?view=extras&id=${T1}`)).json();
    expect(json.caseFile).toMatchObject({ kind: 'ok', data: { summary: 'Needs identity review' } });
    expect(json.rating).toMatchObject({ kind: 'ok', data: { score: 4 } });
    const urls = fn.mock.calls.map((c) => c[0]);
    expect(urls).toContain(`http://edge:4000/api/support/trpc/caseFile?input=${encodeURIComponent(JSON.stringify({ ticketId: T1 }))}`);
    expect(urls).toContain(`http://edge:4000/api/support/trpc/ratingOps?input=${encodeURIComponent(JSON.stringify({ ticketId: T1 }))}`);
  });
  it('null from the service means "never escalated" and "not rated", and nothing else does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(null)),
    );
    const json = await (await get(`?view=extras&id=${T1}`)).json();
    expect(json.caseFile).toEqual({ kind: 'ok', data: null });
    expect(json.rating).toEqual({ kind: 'ok', data: null });
  });
  it('a forbidden session is shown as forbidden on both parts, never as "none"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'scope.denied')),
    );
    const json = await (await get(`?view=extras&id=${T1}`)).json();
    for (const part of [json.caseFile, json.rating]) {
      expect(part).toMatchObject({ kind: 'failed', forbidden: true });
      expect(part.message).toContain('Your console session does not have support operations permission');
      expect(part).not.toHaveProperty('data');
    }
  });
  it('a malformed rating is a failure, not "no rating"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('/caseFile') ? ok(null) : ok({ ticketId: T1, score: 99 }))),
    );
    const json = await (await get(`?view=extras&id=${T1}`)).json();
    expect(json.rating).toMatchObject({ kind: 'failed' });
  });
  it('rejects a ticket id that is not a UUID before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await get('?view=extras&id=nope')).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('lists the published articles with their revisions', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      ok([
        { id: 'kb-account-access', titleKey: 'support.kb.account_access.title', bodyKey: 'support.kb.account_access.body', revision: 3 },
      ]),
    );
    vi.stubGlobal('fetch', fn);
    const json = await (await get('?view=kb')).json();
    expect(json.articles).toMatchObject({ kind: 'ok', data: [{ id: 'kb-account-access', revision: 3 }] });
    expect(fn.mock.calls[0]![0]).toBe(`http://edge:4000/api/support/trpc/listKb?input=${encodeURIComponent('{"limit":100}')}`);
  });
});

describe('POST desk writes', () => {
  const calls = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => ({ url: c[0] as string, body: JSON.parse((c[1] as RequestInit).body as string) }));
  const comment = {
    id: '44444444-4444-4444-8444-444444444444',
    ticketId: T1,
    authorId: FOUNDER,
    authorRole: 'operator',
    visibility: 'public',
    body: 'Hello',
    createdAt: '2026-10-17T03:00:00.000Z',
  };
  const kbArticle = (over: Record<string, unknown> = {}) => ({
    id: 'kb-a',
    titleKey: 'support.kb.a.title',
    bodyKey: 'support.kb.a.body',
    version: 2,
    revision: 2,
    published: true,
    ...over,
  });

  it('replies as the founder through support.comment', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(comment));
    vi.stubGlobal('fetch', fn);
    const res = await post({ action: 'reply', ticketId: T1, body: '  Hello  ' });
    expect(await res.json()).toMatchObject({ ok: true, action: 'reply' });
    expect(calls(fn)).toEqual([{ url: 'http://edge:4000/api/support/trpc/comment', body: { ticketId: T1, body: 'Hello' } }]);
    expect((fn.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('adds an internal note through support.addInternalNote under its own key, and says the customer does not see it', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok({ ...comment, visibility: 'internal', body: 'TEST note' }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ action: 'note', ticketId: T1, body: ' TEST note ', expectedSequence: 7, sent: 0 });
    expect(await res.json()).toMatchObject({
      ok: true,
      action: 'note',
      summary: 'svc-support recorded your internal note. The customer does not see it.',
    });
    const [call] = calls(fn);
    expect(call!.url).toBe('http://edge:4000/api/support/trpc/addInternalNote');
    expect(call!.body).toEqual({
      ticketId: T1,
      body: 'TEST note',
      clientRequestId: expect.stringMatching(new RegExp(`^admin-note:${T1}:${FOUNDER}:7:0:[0-9a-f]{32}$`)),
    });
  });

  it('sets a status through support.setStatus, with the reason only when given, and reports the service’s own status', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(ticket({ status: 'resolved' })));
    vi.stubGlobal('fetch', fn);
    const json = await (await post({ action: 'status', ticketId: T1, status: 'resolved', note: 'Fixed' })).json();
    expect(json.summary).toBe('svc-support says the ticket is now resolved.');
    await post({ action: 'status', ticketId: T1, status: 'resolved' });
    expect(calls(fn).map((c) => c.body)).toEqual([
      { ticketId: T1, status: 'resolved', note: 'Fixed' },
      { ticketId: T1, status: 'resolved' },
    ]);
    expect(calls(fn)[0]!.url).toBe('http://edge:4000/api/support/trpc/setStatus');
  });

  it('escalates through support.escalate with the reason, summary and cited articles', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      ok({
        ticketId: T1,
        escalatedBy: FOUNDER,
        reason: 'technical',
        citations: [{ kind: 'ticket_comment', ref: U, digest: 'b'.repeat(64), readAt: '2026-10-17T03:00:00.000Z' }],
        grounding: { status: 'unread', reason: 'plane_dark' },
        summary: 'Looks like a bug',
        createdAt: '2026-10-17T03:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fn);
    const json = await (
      await post({ action: 'escalate', ticketId: T1, reason: 'technical', summary: 'Looks like a bug', citedArticleIds: ['kb-a'] })
    ).json();
    expect(json).toMatchObject({ ok: true, action: 'escalate', summary: 'svc-support filed the case file with 1 citations.' });
    expect(calls(fn)).toEqual([
      {
        url: 'http://edge:4000/api/support/trpc/escalate',
        body: { ticketId: T1, reason: 'technical', summary: 'Looks like a bug', citedArticleIds: ['kb-a'] },
      },
    ]);
  });

  it('publishes and unpublishes an article, quoting the revision', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(kbArticle()));
    vi.stubGlobal('fetch', fn);
    const pub = await (
      await post({
        action: 'kb_publish',
        id: 'kb-a',
        titleKey: 'support.kb.a.title',
        bodyKey: 'support.kb.a.body',
        baseRevision: 1,
        tags: ['x'],
      })
    ).json();
    expect(pub.summary).toBe('svc-support says kb-a is published at revision 2.');
    const unpub = await (await post({ action: 'kb_unpublish', id: 'kb-a', baseRevision: 2 })).json();
    expect(unpub.summary).toContain('is hidden from customers');
    expect(calls(fn)).toEqual([
      {
        url: 'http://edge:4000/api/support/trpc/publishKb',
        body: { id: 'kb-a', titleKey: 'support.kb.a.title', bodyKey: 'support.kb.a.body', baseRevision: 1, tags: ['x'] },
      },
      { url: 'http://edge:4000/api/support/trpc/unpublishKb', body: { id: 'kb-a', baseRevision: 2 } },
    ]);
  });

  it('sets who can read an article, quoting the revision, and says what svc-support answered', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(kbArticle({ revision: 3, audience: 'signed_in' })));
    vi.stubGlobal('fetch', fn);
    const res = await (await post({ action: 'kb_audience', id: 'kb-a', baseRevision: 2, audience: 'signed_in' })).json();
    expect(res.summary).toBe('svc-support says kb-a is now readable by signed-in customers only. Its revision is now 3.');
    expect(calls(fn)).toEqual([
      { url: 'http://edge:4000/api/support/trpc/setKbAudience', body: { id: 'kb-a', baseRevision: 2, audience: 'signed_in' } },
    ]);
  });

  it('turns a stale audience change into plain words and says nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(409, 'support.kb.revision_stale')),
    );
    const res = await post({ action: 'kb_audience', id: 'kb-a', baseRevision: 1, audience: 'staff' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { title: 'Someone changed this article first', changed: 'no' } });
  });

  it('refuses a malformed write before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const body of [
      { action: 'reply', ticketId: 'x', body: 'hi' },
      { action: 'reply', ticketId: T1, body: '   ' },
      { action: 'status', ticketId: T1, status: 'deleted' },
      { action: 'escalate', ticketId: T1, reason: 'refund', summary: 's' },
      { action: 'escalate', ticketId: T1, reason: 'other', summary: '' },
      { action: 'kb_publish', id: 'a', titleKey: 't', bodyKey: 'b', baseRevision: -1 },
      { action: 'kb_unpublish', id: 'a', baseRevision: 0 },
      { action: 'kb_audience', id: 'a', baseRevision: 1, audience: 'everyone' },
      { action: 'kb_audience', id: 'a', baseRevision: 0, audience: 'staff' },
      { action: 'settle', ticketId: T1 },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'no' } });
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ['reply', { action: 'reply', ticketId: T1, body: 'Hello' }],
    ['status', { action: 'status', ticketId: T1, status: 'closed' }],
    ['escalate', { action: 'escalate', ticketId: T1, reason: 'other', summary: 's' }],
    ['kb_publish', { action: 'kb_publish', id: 'a', titleKey: 't', bodyKey: 'b', baseRevision: 0 }],
    ['kb_unpublish', { action: 'kb_unpublish', id: 'a', baseRevision: 1 }],
    ['kb_audience', { action: 'kb_audience', id: 'a', baseRevision: 1, audience: 'staff' }],
  ])('%s: a founder without the permission is told so and nothing is shown as done', async (_name, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'scope.denied')),
    );
    const res = await post(body);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: false,
      refusal: { title: 'Your console session does not have support operations permission', changed: 'no' },
    });
    expect(json).not.toHaveProperty('summary');
  });

  it('a signed-out session (401) is not reported as a missing permission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(401, 'Sign in')),
    );
    const res = await post({ action: 'reply', ticketId: T1, body: 'Hello' });
    expect(res.status).toBe(401);
    expect((await res.json()).refusal.title).toBe('You are signed out');
  });

  it('turns svc-support’s typed refusals into plain words and says nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(412, 'support.transition_illegal')),
    );
    const res = await post({ action: 'status', ticketId: T1, status: 'open' });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.refusal).toMatchObject({
      title: 'svc-support does not allow that status change',
      code: 'support.transition_illegal',
      changed: 'no',
    });
    expect(JSON.stringify(json)).not.toMatch(/\bsupport\.transition_illegal\b.*\bsupport\.transition_illegal\b/);
  });

  it('a stale article revision is a conflict that overwrote nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(409, 'support.kb.revision_stale')),
    );
    const json = await (await post({ action: 'kb_publish', id: 'a', titleKey: 't', bodyKey: 'b', baseRevision: 1 })).json();
    expect(json.refusal).toMatchObject({ title: 'Someone changed this article first', changed: 'no' });
  });

  it('a dropped connection on a write is "not known", never failed or done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('hang up');
      }),
    );
    const res = await post({ action: 'reply', ticketId: T1, body: 'Hello' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('a success the console cannot read is "not known", not done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ nonsense: true })),
    );
    const res = await post({ action: 'reply', ticketId: T1, body: 'Hello' });
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('logs the founder and the target, never the words that were written', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(comment)),
    );
    await post({ action: 'reply', ticketId: T1, body: 'a secret sentence' });
    const line = String(vi.mocked(console.warn).mock.calls.at(-1)?.[0]);
    expect(JSON.parse(line)).toMatchObject({ audit: 'admin.support_reply', founder: FOUNDER, target: T1, outcome: 'ok' });
    expect(line).not.toContain('secret');
  });
});

describe('ticket properties', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    ticketId: T1,
    priority: 'high',
    ticketType: null,
    labels: ['vip'],
    updatedAt: '2026-10-20T03:00:00.000Z',
    ...over,
  });
  const sent = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => ({ url: c[0] as string, body: JSON.parse((c[1] as RequestInit).body as string) }));

  it('reads ticketProperties as the founder, on its own', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(props()));
    vi.stubGlobal('fetch', fn);
    const json = await (await get(`?view=properties&id=${T1}`)).json();
    expect(json.properties).toMatchObject({ kind: 'ok', data: { priority: 'high', ticketType: null, labels: ['vip'] } });
    expect(fn.mock.calls[0]![0]).toBe(
      `http://edge:4000/api/support/trpc/ticketProperties?input=${encodeURIComponent(JSON.stringify({ ticketId: T1 }))}`,
    );
  });

  it('rejects a ticket id that is not a UUID before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await get('?view=properties&id=nope')).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a malformed answer is a failure, not "nothing set"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ ticketId: T1, priority: 'whenever' })),
    );
    const json = await (await get(`?view=properties&id=${T1}`)).json();
    expect(json.properties.kind).toBe('failed');
  });

  it('reads ratingSummary for the stated window as the founder', async () => {
    const summary = {
      from: '2026-09-20T00:00:00.000Z',
      to: '2026-10-20T00:00:00.000Z',
      solved: 0,
      responses: 0,
      perScore: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      ratedShareBasisPoints: null,
    };
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(summary));
    vi.stubGlobal('fetch', fn);
    const json = await (await get('?view=ratings&from=2026-09-20T00:00:00.000Z&to=2026-10-20T00:00:00.000Z')).json();
    expect(json.summary).toMatchObject({ kind: 'ok', data: { responses: 0, ratedShareBasisPoints: null } });
    expect(fn.mock.calls[0]![0]).toBe(
      `http://edge:4000/api/support/trpc/ratingSummary?input=${encodeURIComponent(
        JSON.stringify({ from: '2026-09-20T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' }),
      )}`,
    );
  });

  it('rejects a missing, unreadable or backwards window before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await get('?view=ratings')).status).toBe(400);
    expect((await get('?view=ratings&from=nope&to=2026-10-20T00:00:00.000Z')).status).toBe(400);
    expect((await get('?view=ratings&from=2026-10-20T00:00:00.000Z&to=2026-09-20T00:00:00.000Z')).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a summary that does not add up is a failure, not a figure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({
          from: '2026-09-20T00:00:00.000Z',
          to: '2026-10-20T00:00:00.000Z',
          solved: 1,
          responses: 5,
          perScore: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 5 },
          ratedShareBasisPoints: 10000,
        }),
      ),
    );
    const json = await (await get('?view=ratings&from=2026-09-20T00:00:00.000Z&to=2026-10-20T00:00:00.000Z')).json();
    expect(json.summary.kind).toBe('failed');
  });

  it('sets only the fields given, with the request id and reason, through support.setProperties', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(props({ priority: null })));
    vi.stubGlobal('fetch', fn);
    const res = await post({
      action: 'properties',
      ticketId: T1,
      clientRequestId: 'props:abc',
      priority: null,
      labels: ['vip', 'refund'],
      reason: ' asked twice ',
    });
    expect(await res.json()).toMatchObject({ ok: true, action: 'properties' });
    expect(sent(fn)).toEqual([
      {
        url: 'http://edge:4000/api/support/trpc/setProperties',
        body: { ticketId: T1, clientRequestId: 'props:abc', priority: null, labels: ['vip', 'refund'], reason: 'asked twice' },
      },
    ]);
  });

  it('refuses a malformed properties write before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const bad of [
      { action: 'properties', ticketId: T1, clientRequestId: 'k' },
      { action: 'properties', ticketId: T1, priority: 'high' },
      { action: 'properties', ticketId: T1, clientRequestId: 'k', priority: 'whenever' },
      { action: 'properties', ticketId: T1, clientRequestId: 'k', labels: ['has space'] },
      { action: 'properties', ticketId: 'x', clientRequestId: 'k', priority: 'low' },
    ]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('says a closed ticket was not changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(412, 'support.ticket_closed')),
    );
    const json = await (await post({ action: 'properties', ticketId: T1, clientRequestId: 'k', priority: 'low' })).json();
    expect(json).toMatchObject({ ok: false, refusal: { title: 'This ticket is closed', changed: 'no' } });
  });
});

describe('staff roster and availability', () => {
  const member = (userId: string, over: Record<string, unknown> = {}) => ({
    userId,
    role: 'agent',
    appointedBy: U,
    appointedAt: '2026-10-20T01:00:00.000Z',
    availability: 'offline',
    availabilitySetAt: null,
    lastHeartbeatAt: null,
    ...over,
  });
  const policy = { automaticOffline: 'not_set', heartbeatWindowSeconds: null };
  const sent = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => ({ url: c[0] as string, body: JSON.parse(((c[1] as RequestInit).body as string) ?? 'null') }));

  it('reads the roster and the policy as the founder, each on its own, and names the signed-in person from the session', async () => {
    const fn = vi.fn(async (url: string, _init?: RequestInit) => (url.includes('/staffList') ? ok([member(FOUNDER)]) : ok(policy)));
    vi.stubGlobal('fetch', fn);
    const json = await (await get('?view=staff')).json();
    expect(json.meId).toBe(FOUNDER);
    expect(json.roster).toMatchObject({ kind: 'ok', data: [{ userId: FOUNDER }] });
    expect(json.policy).toMatchObject({ kind: 'ok', data: { automaticOffline: 'not_set' } });
  });

  it('a roster row it cannot read is a failure, not a shorter roster', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('/staffList') ? ok([member(FOUNDER), { userId: U }]) : ok(policy))),
    );
    const json = await (await get('?view=staff')).json();
    expect(json.roster.kind).toBe('failed');
    expect(json.policy.kind).toBe('ok');
  });

  it('sets the founder’s own availability with no userId, and another person’s with one', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(member(FOUNDER, { availability: 'busy' })));
    vi.stubGlobal('fetch', fn);
    expect(await (await post({ action: 'staff_availability', availability: 'busy' })).json()).toMatchObject({
      ok: true,
      action: 'staff_availability',
    });
    await post({ action: 'staff_availability', availability: 'online', userId: U, reason: ' cover ' });
    expect(sent(fn)).toEqual([
      { url: 'http://edge:4000/api/support/trpc/staffSetAvailability', body: { availability: 'busy' } },
      { url: 'http://edge:4000/api/support/trpc/staffSetAvailability', body: { availability: 'online', userId: U, reason: 'cover' } },
    ]);
  });

  it('refuses a bad availability before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await post({ action: 'staff_availability', availability: 'away' })).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a person who is not staff is told that, not that the permission is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'support.not_staff')),
    );
    const res = await post({ action: 'staff_availability', availability: 'busy' });
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.refusal).toMatchObject({ title: 'You are not on the support staff list', changed: 'no' });
  });
});

describe('desk groups', () => {
  const GID = '55555555-5555-4555-8555-555555555555';
  const group = (over: Record<string, unknown> = {}) => ({
    id: GID,
    name: 'Payments',
    createdBy: FOUNDER,
    createdAt: '2026-10-20T01:00:00.000Z',
    memberIds: [FOUNDER],
    ...over,
  });
  const scope = { restricted: true, groups: [{ id: GID, name: 'Payments' }], seesAllGroups: false };
  const roster = [
    {
      userId: FOUNDER,
      role: 'lead',
      appointedBy: U,
      appointedAt: '2026-10-20T01:00:00.000Z',
      availability: 'online',
      availabilitySetAt: null,
      lastHeartbeatAt: null,
    },
  ];
  const sent = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => ({ url: c[0] as string, body: JSON.parse(((c[1] as RequestInit).body as string) ?? 'null') }));

  it('reads groups, the scope and the roster as the founder, each on its own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('/groupsList') ? ok([group()]) : url.includes('/deskScope') ? ok(scope) : ok(roster))),
    );
    const json = await (await get('?view=groups')).json();
    expect(json.meId).toBe(FOUNDER);
    expect(json.groups).toMatchObject({ kind: 'ok', data: [{ name: 'Payments' }] });
    expect(json.scope).toMatchObject({ kind: 'ok', data: { restricted: true } });
    expect(json.roster.kind).toBe('ok');
  });

  it('a group it cannot read is a failure, not a shorter list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/groupsList') ? ok([group(), { id: GID }]) : url.includes('/deskScope') ? ok(scope) : ok(roster),
      ),
    );
    const json = await (await get('?view=groups')).json();
    expect(json.groups.kind).toBe('failed');
    expect(json.scope.kind).toBe('ok');
  });

  it('makes a group with the key, and renames with the group id', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(group()));
    vi.stubGlobal('fetch', fn);
    expect(await (await post({ action: 'group_save', name: ' Payments ', idempotencyKey: 'group:abcdef12' })).json()).toMatchObject({
      ok: true,
    });
    await post({ action: 'group_save', name: 'Billing', idempotencyKey: 'group:abcdef13', groupId: GID });
    expect(sent(fn)).toEqual([
      { url: 'http://edge:4000/api/support/trpc/groupsSave', body: { name: 'Payments', idempotencyKey: 'group:abcdef12' } },
      { url: 'http://edge:4000/api/support/trpc/groupsSave', body: { name: 'Billing', idempotencyKey: 'group:abcdef13', groupId: GID } },
    ]);
  });

  it('adds and removes a member through the matching procedure', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(group()));
    vi.stubGlobal('fetch', fn);
    await post({ action: 'group_member', op: 'add', groupId: GID, userId: U });
    await post({ action: 'group_member', op: 'remove', groupId: GID, userId: U });
    expect(sent(fn).map((c) => c.url)).toEqual([
      'http://edge:4000/api/support/trpc/groupsAddMember',
      'http://edge:4000/api/support/trpc/groupsRemoveMember',
    ]);
    expect(sent(fn)[0]!.body).toEqual({ groupId: GID, userId: U });
  });

  it('refuses a malformed group write before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const bad of [
      { action: 'group_save', name: '', idempotencyKey: 'group:abcdef12' },
      { action: 'group_save', name: 'x', idempotencyKey: 'k' },
      { action: 'group_member', op: 'add', groupId: 'x', userId: U },
    ])
      expect((await post(bad)).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('says plainly when the name is taken, and that a non-lead cannot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(409, 'support.group_name_taken')),
    );
    expect((await (await post({ action: 'group_save', name: 'Payments', idempotencyKey: 'group:abcdef12' })).json()).refusal).toMatchObject(
      {
        title: 'A group with that name exists',
        changed: 'no',
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'support.not_lead')),
    );
    const res = await post({ action: 'group_member', op: 'add', groupId: GID, userId: U });
    expect(res.status).toBe(403);
    expect((await res.json()).refusal.title).toBe('Only a lead can do that');
  });
});

describe('bulk change', () => {
  const T2 = '44444444-4444-4444-8444-444444444444';
  const sent = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => ({ url: c[0] as string, body: JSON.parse(((c[1] as RequestInit).body as string) ?? 'null') }));
  const rows = [
    { ticketId: T1, outcome: 'changed', code: null },
    { ticketId: T2, outcome: 'refused', code: 'support.transition_illegal' },
  ];

  it('reads the owner batch size, and a blank one stays blank', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ cap: null, missing: 'support.bulk_cap' })),
    );
    expect((await (await get('?view=bulk')).json()).policy).toMatchObject({ kind: 'ok', data: { cap: null } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ cap: 25, missing: null })),
    );
    expect((await (await get('?view=bulk')).json()).policy).toMatchObject({ kind: 'ok', data: { cap: 25 } });
  });

  it('a batch size it cannot read is a failure, never a number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ cap: 0, missing: null })),
    );
    expect((await (await get('?view=bulk')).json()).policy.kind).toBe('failed');
  });

  it('sends one batch under its key and returns every request as svc-support answered it', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok({ batchKey: 'batch-1', results: rows }));
    vi.stubGlobal('fetch', fn);
    const res = await post({
      action: 'bulk',
      batchKey: 'batch-1',
      ticketIds: [T1, T2],
      change: { kind: 'status', status: 'resolved' },
      reason: ' noise ',
    });
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, action: 'bulk', results: rows });
    expect(json.summary).toBe('svc-support changed 1, found 0 already there and refused 1 of 2 requests.');
    expect(sent(fn)[0]!.url).toContain('/bulkUpdate');
    expect(sent(fn)[0]!.body).toEqual({
      batchKey: 'batch-1',
      ticketIds: [T1, T2],
      change: { kind: 'status', status: 'resolved' },
      reason: 'noise',
    });
  });

  it.each([
    ['no requests', { ticketIds: [], change: { kind: 'status', status: 'resolved' } }],
    ['a repeated request', { ticketIds: [T1, T1], change: { kind: 'status', status: 'resolved' } }],
    ['a request that is not an id', { ticketIds: ['x'], change: { kind: 'status', status: 'resolved' } }],
    ['an unknown status', { ticketIds: [T1], change: { kind: 'status', status: 'gone' } }],
    ['an unknown priority', { ticketIds: [T1], change: { kind: 'priority', priority: 'asap' } }],
    ['an assignee that is not an id', { ticketIds: [T1], change: { kind: 'assign', assigneeId: 'me' } }],
    ['two changes at once', { ticketIds: [T1], change: { kind: 'status', status: 'open', priority: 'low' } }],
  ])('refuses %s before the network', async (_name, body) => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await post({ action: 'bulk', batchKey: 'batch-1', ...body });
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('clears a priority with null', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok({ batchKey: 'b', results: [rows[0]] }));
    vi.stubGlobal('fetch', fn);
    await post({ action: 'bulk', batchKey: 'b', ticketIds: [T1], change: { kind: 'priority', priority: null } });
    expect(sent(fn)[0]!.body.change).toEqual({ kind: 'priority', priority: null });
  });

  it('says the batch size is not set when svc-support refuses a blank cap, and that nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(412, 'support.bulk_cap_unset: the bulk batch size is not set')),
    );
    const res = await post({ action: 'bulk', batchKey: 'b', ticketIds: [T1], change: { kind: 'status', status: 'resolved' } });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.refusal).toMatchObject({ title: 'The batch size is not set', changed: 'no' });
  });

  it('an answer that leaves out a request, or names another, is an unknown outcome, not a success', async () => {
    for (const results of [
      [],
      [rows[0]],
      [rows[0], { ticketId: '55555555-5555-4555-8555-555555555555', outcome: 'changed', code: null }],
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok({ batchKey: 'batch-1', results })),
      );
      const res = await post({ action: 'bulk', batchKey: 'batch-1', ticketIds: [T1, T2], change: { kind: 'status', status: 'resolved' } });
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.refusal.changed).toBe('unknown');
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ batchKey: 'someone-else', results: rows })),
    );
    const res = await post({ action: 'bulk', batchKey: 'batch-1', ticketIds: [T1, T2], change: { kind: 'status', status: 'resolved' } });
    expect((await res.json()).ok).toBe(false);
  });

  it('an answer that is not a list of requests is an unknown outcome, not a success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ batchKey: 'b', results: [{ ticketId: T1 }] })),
    );
    const res = await post({ action: 'bulk', batchKey: 'b', ticketIds: [T1], change: { kind: 'status', status: 'resolved' } });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.refusal.changed).toBe('unknown');
  });
});

describe('merge duplicate requests', () => {
  const B = '44444444-4444-4444-8444-444444444444';
  const result = { sourceId: T1, survivorId: B, commentsMoved: 2, attachmentsMoved: 1, mergedAt: '2026-10-21T01:00:00.000Z' };
  const previewData = {
    sourceId: T1,
    survivorId: B,
    refusal: null,
    commentsToMove: 2,
    attachmentsToMove: 1,
    staysOnSource: { rating: false, caseFile: true },
    alreadyMerged: false,
  };
  const sent = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => ({ url: c[0] as string, body: JSON.parse(((c[1] as RequestInit).body as string) ?? 'null') }));

  it('reads the preview as the founder and returns it as svc-support answered', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(previewData));
    vi.stubGlobal('fetch', fn);
    const json = await (await get(`?view=merge&id=${T1}&survivor=${B}`)).json();
    expect(json.preview).toEqual(previewData);
    expect(fn.mock.calls[0]![0]).toContain('previewMerge');
  });

  it('refuses a preview request without two ids before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await get(`?view=merge&id=${T1}&survivor=nope`)).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sends the merge with the source, the survivor and the reason, and says what svc-support did', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(result));
    vi.stubGlobal('fetch', fn);
    const json = await (await post({ action: 'merge', ticketId: T1, survivorId: B, reason: ' same problem ' })).json();
    expect(json).toMatchObject({ ok: true, action: 'merge' });
    expect(json.summary).toContain('2 messages and 1 files');
    expect(sent(fn)[0]!.body).toEqual({ sourceId: T1, survivorId: B, reason: 'same problem' });
  });

  it('refuses the same request, a missing reason and a bad id before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const body of [
      { ticketId: T1, survivorId: T1, reason: 'r' },
      { ticketId: T1, survivorId: B },
      { ticketId: T1, survivorId: 'x', reason: 'r' },
    ]) {
      expect((await post({ action: 'merge', ...body })).status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('says why svc-support refused a merge, and that nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(412, 'support.merge_not_allowed')),
    );
    const json = await (await post({ action: 'merge', ticketId: T1, survivorId: B, reason: 'dup' })).json();
    expect(json.ok).toBe(false);
    expect(json.refusal).toMatchObject({ title: 'Those requests cannot be merged', changed: 'no' });
  });
});
