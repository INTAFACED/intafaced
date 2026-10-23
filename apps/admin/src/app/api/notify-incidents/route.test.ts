import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const NOTICE_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/notify-incidents`;

function configure() {
  vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
  vi.stubEnv('EDGE_URL', EDGE);
  vi.stubEnv('ADMIN_SESSION_SECRET', KEY.toString('base64url'));
  vi.stubEnv('APP_ENV', 'test');
}
function session() {
  const s: FounderSession = {
    userId: USER_ID,
    accessToken: 'founder-access-token',
    refreshToken: 'refresh-token',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    csrf: Buffer.alloc(32, 5).toString('base64url'),
  };
  return {
    cookie: founderCookie(sealFounderSession(s, { origin: ORIGIN, edgeUrl: EDGE, key: KEY }, NOW), 3600).split(';')[0]!,
    csrf: s.csrf,
  };
}
const authed = () => {
  const { cookie, csrf } = session();
  return { cookie, origin: ORIGIN, 'x-intafaced-csrf': csrf };
};
const post = (body: unknown, headers: Record<string, string> = authed()) =>
  new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = () => new Request(URL_, { headers: { cookie: session().cookie } });
const entitlement = () =>
  Response.json({ result: { data: { json: { status: 'enabled', userId: USER_ID, version: '1', changedAt: NOW.toISOString() } } } });
const ok = (data: unknown) => Response.json({ result: { data } });
const refusal = (code: string, status: number) =>
  Response.json({ error: { message: code, data: { httpStatus: status, cause: { code } } } }, { status });

function upstream(handlers: Record<string, (init: RequestInit, url: string) => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('accountControls.operatorStatus')) return entitlement();
      const key = Object.keys(handlers).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected upstream call ${url}`);
      return handlers[key]!(init, url);
    }),
  );
  return calls;
}
const calls = <T extends { url: string }>(c: T[]) => c.filter((x) => !x.url.includes('operatorStatus'));
const sent = (c: { url: string; init: RequestInit }[], procedure: string) =>
  JSON.parse(String(calls(c).find((x) => x.url.includes(procedure))!.init.body));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const NOTICE = {
  id: NOTICE_ID,
  kind: 'incident',
  title: 'TEST payments slow',
  body: 'TEST we are looking',
  status: 'draft',
  publishedAt: null,
  version: 1,
  impact: 'minor',
  components: ['payments'],
  parentId: null,
  resolves: false,
  authorId: USER_ID,
  createdAt: '2026-10-23T10:00:00.000Z',
};
const approval = (over: Record<string, unknown>) => ({
  approvalId: 'appr-1',
  actionType: 'notify.notice.publish',
  targetService: 'svc-notify',
  targetId: NOTICE_ID,
  expectedVersion: '1',
  payloadHash: 'a'.repeat(64),
  requesterId: USER_ID,
  approverId: null,
  policyVersion: 'v1',
  createdAt: '2026-10-23T10:01:00.000Z',
  expiresAt: '2026-10-24T10:01:00.000Z',
  status: 'PENDING',
  operationId: 'op-1',
  ...over,
});
const PROPOSAL = {
  actionType: 'notify.notice.publish',
  targetService: 'svc-notify',
  targetId: NOTICE_ID,
  expectedVersion: '1',
  payloadHash: 'b'.repeat(64),
};
const DEFINITION = {
  components: [{ id: 'payments', name: 'Payments', group: 'Platform', source: null }],
  componentCap: 5,
  stalenessSeconds: 600,
  uptimeDays: null,
  challengeBits: null,
  subscribeRatePerHour: null,
  revision: 3,
  updatedAt: '2026-10-23T10:00:00.000Z',
  publicOrigin: null,
};

describe('incident desk BFF', () => {
  it('a change without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({ op: 'request', noticeId: NOTICE_ID }, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });

  it('the module switch answers 404', async () => {
    configure();
    process.env.ADMIN_MODULES = 'crm';
    expect((await GET(get())).status).toBe(404);
  });

  it('reads incidents, templates, components and only the publish approvals, once each, as the founder', async () => {
    configure();
    const c = upstream({
      'notify.operatorNotices': () => ok([NOTICE]),
      'statusPage.templates.list': () => ok([]),
      'statusPage.definition': () => ok(DEFINITION),
      'actionApproval.list': () =>
        ok({
          approvals: [
            approval({}),
            approval({ approvalId: 'other', actionType: 'treasury.payout.release', targetService: 'svc-treasury' }),
          ],
        }),
    });
    const body = await (await GET(get())).json();
    expect(body.notices).toEqual({ kind: 'ok', data: [NOTICE] });
    expect(body.templates).toEqual({ kind: 'ok', data: [] });
    expect(body.components).toEqual({ kind: 'ok', data: [{ id: 'payments', name: 'Payments' }] });
    expect(body.approvals.data.map((a: { approvalId: string }) => a.approvalId)).toEqual(['appr-1']);
    expect(body.me).toBe(USER_ID);
    for (const call of calls(c)) expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('approvals that cannot be read are a failed part, never an empty list', async () => {
    configure();
    upstream({
      'notify.operatorNotices': () => ok([NOTICE]),
      'statusPage.templates.list': () => ok([]),
      'statusPage.definition': () => ok(DEFINITION),
      'actionApproval.list': () => ok({ approvals: 'x' }),
    });
    expect((await (await GET(get())).json()).approvals.kind).toBe('failed');
  });

  it('a draft that is not complete is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const res = await POST(post({ op: 'draft', title: 'TEST', body: ' ', impact: null, components: [], parentId: null }));
    expect(res.status).toBe(400);
    expect(calls(c)).toHaveLength(0);
  });

  it('a draft keyed by its content: the same words sent twice carry the same key', async () => {
    configure();
    const c = upstream({ 'notify.draftNotice': () => ok(NOTICE) });
    const draft = {
      op: 'draft',
      title: 'TEST payments slow',
      body: 'TEST we are looking',
      impact: 'minor',
      components: ['payments'],
      parentId: null,
    };
    expect(await (await POST(post(draft))).json()).toEqual({ ok: true, what: 'drafted' });
    await POST(post(draft));
    const [a, b] = calls(c).map((x) => JSON.parse(String(x.init.body)));
    expect(a).toMatchObject({ kind: 'incident', title: 'TEST payments slow', impact: 'minor', components: ['payments'], resolves: false });
    expect(a.clientRequestId).toMatch(/^incident-draft:[0-9a-f]{48}$/);
    expect(b.clientRequestId).toBe(a.clientRequestId);
  });

  it('asks identity for the approval bound to the draft as svc-notify holds it', async () => {
    configure();
    const c = upstream({ 'notify.noticeProposal': () => ok(PROPOSAL), 'actionApproval.propose': () => ok(approval({})) });
    expect(await (await POST(post({ op: 'request', noticeId: NOTICE_ID }))).json()).toEqual({ ok: true, what: 'requested' });
    expect(sent(c, 'actionApproval.propose')).toEqual({ ...PROPOSAL, policyVersion: 'v1' });
  });

  it('approves against the hash svc-notify answers now, never one from the browser', async () => {
    configure();
    const c = upstream({
      'notify.noticeProposal': () => ok(PROPOSAL),
      'actionApproval.approve': () => ok(approval({ status: 'APPROVED', approverId: USER_ID, requesterId: OTHER_ID })),
    });
    await POST(post({ op: 'approve', noticeId: NOTICE_ID, approvalId: 'appr-1', expectedPayloadHash: 'c'.repeat(64) }));
    expect(sent(c, 'actionApproval.approve')).toEqual({ approvalId: 'appr-1', expectedPayloadHash: PROPOSAL.payloadHash });
  });

  it('a founder approving their own request comes back in words, from identity', async () => {
    configure();
    upstream({ 'notify.noticeProposal': () => ok(PROPOSAL), 'actionApproval.approve': () => refusal('action_approval.same_person', 409) });
    const res = await POST(post({ op: 'approve', noticeId: NOTICE_ID, approvalId: 'appr-1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'action_approval.same_person' });
  });

  it('publishes keyed by the approval, and the approver publishing is refused with its code', async () => {
    configure();
    const c = upstream({ 'notify.publishNotice': () => refusal('notify.notice_publish_same_operator', 409) });
    const res = await POST(post({ op: 'publish', noticeId: NOTICE_ID, approvalId: 'appr-1', operationId: 'op-1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      title: 'The approver cannot also publish',
      code: 'notify.notice_publish_same_operator',
    });
    expect(sent(c, 'notify.publishNotice')).toEqual({
      id: NOTICE_ID,
      approvalId: 'appr-1',
      operationId: 'op-1',
      clientRequestId: 'incident-publish:appr-1',
    });
  });

  it('defines a template with a blank group as none, and refuses a malformed template id to retire', async () => {
    configure();
    const c = upstream({ 'statusPage.templates.define': () => ok({}) });
    await POST(
      post({
        op: 'define-template',
        id: 'payments-slow',
        name: 'Payments slow',
        group: ' ',
        title: 'TEST',
        body: 'TEST',
        impact: 'minor',
        components: ['payments'],
      }),
    );
    expect(sent(c, 'statusPage.templates.define')).toMatchObject({
      id: 'payments-slow',
      group: null,
      impact: 'minor',
      components: ['payments'],
    });
    expect((await POST(post({ op: 'retire-template', id: '../x' }))).status).toBe(400);
  });
});
