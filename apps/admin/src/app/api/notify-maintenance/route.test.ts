import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const WINDOW_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/notify-maintenance`;

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

const WINDOW = {
  notice: {
    id: WINDOW_ID,
    title: 'TEST database upgrade',
    body: 'TEST we upgrade the database',
    status: 'published',
    publishedAt: '2026-10-23T10:00:00.000Z',
    startsAt: '2026-10-23T12:00:00.000Z',
    endsAt: '2026-10-23T13:00:00.000Z',
    version: 1,
    components: ['payments'],
    reminderOffsets: [30, 10],
    authorId: USER_ID,
    createdAt: '2026-10-23T09:00:00.000Z',
  },
  state: 'scheduled',
  moves: [],
  reminders: [{ offsetMinutes: 30, dueAt: '2026-10-23T11:30:00.000Z', sentAt: null, skipped: null }],
};
const DEFINITION = {
  components: [{ id: 'payments', name: 'Payments', group: null, source: null }],
  componentCap: 5,
  stalenessSeconds: 600,
  uptimeDays: null,
  challengeBits: null,
  subscribeRatePerHour: null,
  revision: 3,
  updatedAt: '2026-10-23T10:00:00.000Z',
  publicOrigin: null,
};
const DRAFT = {
  op: 'draft',
  title: 'TEST database upgrade',
  body: 'TEST we upgrade the database',
  startsAt: '2026-10-23T12:00:00.000Z',
  endsAt: '2026-10-23T13:00:00.000Z',
  components: ['payments'],
  reminderOffsets: [10, 30, 10],
  basis: null,
};

describe('maintenance desk BFF', () => {
  it('reads windows, components and publish approvals as the founder; a window list it cannot read is a failed part', async () => {
    configure();
    upstream({
      'statusPage.maintenance.windows': () => ok([WINDOW]),
      'statusPage.definition': () => ok(DEFINITION),
      'actionApproval.list': () => ok({ approvals: [] }),
    });
    const body = await (await GET(get())).json();
    expect(body.windows).toEqual({ kind: 'ok', data: [WINDOW] });
    expect(body.components).toEqual({ kind: 'ok', data: [{ id: 'payments', name: 'Payments' }] });
    expect(body.approvals).toEqual({ kind: 'ok', data: [] });
    upstream({
      'statusPage.maintenance.windows': () => ok([{ ...WINDOW, state: 'paused' }]),
      'statusPage.definition': () => ok(DEFINITION),
      'actionApproval.list': () => ok({ approvals: [] }),
    });
    expect((await (await GET(get())).json()).windows.kind).toBe('failed');
  });

  it('drafts a maintenance notice with its offsets distinct and largest first, keyed by its content', async () => {
    configure();
    const c = upstream({ 'notify.draftNotice': () => ok(WINDOW.notice) });
    expect(await (await POST(post(DRAFT))).json()).toEqual({ ok: true, what: 'drafted' });
    await POST(post(DRAFT));
    const [a, b] = calls(c).map((x) => JSON.parse(String(x.init.body)));
    expect(a).toMatchObject({
      kind: 'maintenance',
      startsAt: DRAFT.startsAt,
      endsAt: DRAFT.endsAt,
      components: ['payments'],
      reminderOffsets: [30, 10],
    });
    expect(a.clientRequestId).toMatch(/^maintenance-draft:[0-9a-f]{48}$/);
    expect(b.clientRequestId).toBe(a.clientRequestId);
  });

  it('a draft with no offsets sends none; a malformed window or offset is refused before any service call', async () => {
    configure();
    const c = upstream({ 'notify.draftNotice': () => ok(WINDOW.notice) });
    await POST(post({ ...DRAFT, reminderOffsets: '' }));
    expect(sent(c, 'notify.draftNotice').reminderOffsets).toBeNull();
    for (const bad of [
      { reminderOffsets: [0] },
      { reminderOffsets: 'ten' },
      { reminderOffsets: [43_201] },
      { startsAt: 'soon' },
      { endsAt: DRAFT.startsAt },
      { components: ['Bad Name'] },
    ])
      expect((await POST(post({ ...DRAFT, ...bad }))).status).toBe(400);
    expect(calls(c)).toHaveLength(1);
  });

  it('a move carries its reason; a reopen comes back refused in words with its code', async () => {
    configure();
    const c = upstream({ 'statusPage.maintenance.move': () => refusal('status.maintenance_reopen_refused', 409) });
    const res = await POST(post({ op: 'move', id: WINDOW_ID, to: 'in_progress', reason: ' TEST reopen ' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      title: 'A finished window does not reopen',
      code: 'status.maintenance_reopen_refused',
    });
    expect(sent(c, 'statusPage.maintenance.move')).toEqual({ id: WINDOW_ID, to: 'in_progress', reason: 'TEST reopen' });
    expect((await POST(post({ op: 'move', id: WINDOW_ID, to: 'verifying', reason: ' ' }))).status).toBe(400);
    expect((await POST(post({ op: 'move', id: WINDOW_ID, to: 'paused', reason: 'TEST' }))).status).toBe(400);
    expect(calls(c)).toHaveLength(1);
  });

  it('the four-eyes publish of a window goes through the notice proposal, keyed by the approval', async () => {
    configure();
    const c = upstream({ 'notify.publishNotice': () => ok(WINDOW.notice) });
    await POST(post({ op: 'publish', noticeId: WINDOW_ID, approvalId: 'appr-1', operationId: 'op-1' }));
    expect(sent(c, 'notify.publishNotice')).toEqual({
      id: WINDOW_ID,
      approvalId: 'appr-1',
      operationId: 'op-1',
      clientRequestId: 'incident-publish:appr-1',
    });
  });
});
