import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOTICE_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/notify-notices`;

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
  kind: 'announcement',
  title: 'TEST new listing',
  body: 'TEST the market opens on Monday',
  status: 'draft',
  publishedAt: null,
  startsAt: null,
  endsAt: null,
  version: 1,
  asset: null,
  network: null,
  phase: null,
  changelog: null,
  category: { id: 'listings', name: 'New listings' },
  impact: null,
  components: [],
  parentId: null,
  resolves: false,
  authorId: USER_ID,
  createdAt: '2026-10-23T10:00:00.000Z',
};
const DEFINITION = {
  components: [],
  componentCap: null,
  stalenessSeconds: null,
  uptimeDays: null,
  challengeBits: null,
  subscribeRatePerHour: null,
  noticeCategories: [{ id: 'listings', name: 'New listings' }],
  revision: 4,
  updatedAt: '2026-10-23T10:00:00.000Z',
  publicOrigin: null,
};
const DRAFT = { op: 'draft', title: 'TEST new listing', body: 'TEST the market opens on Monday', category: 'listings', basis: null };

describe('announcement desk BFF', () => {
  it('reads announcements with their category, the category list and approvals; a list it cannot read is a failed part', async () => {
    configure();
    const c = upstream({
      'notify.operatorNotices': () => ok([NOTICE]),
      'statusPage.definition': () => ok(DEFINITION),
      'actionApproval.list': () => ok({ approvals: [] }),
    });
    const body = await (await GET(get())).json();
    expect(body.announcements.kind).toBe('ok');
    expect(body.announcements.data[0]).toMatchObject({ id: NOTICE_ID, kind: 'announcement', category: NOTICE.category });
    expect(body.categories).toEqual({ kind: 'ok', data: { list: DEFINITION.noticeCategories, revision: 4 } });
    expect(calls(c).find((x) => x.url.includes('notify.operatorNotices'))!.url).toContain('announcement');
    upstream({
      'notify.operatorNotices': () => ok([{ ...NOTICE, category: 'listings' }]),
      'statusPage.definition': () => ok({ ...DEFINITION, noticeCategories: null }),
      'actionApproval.list': () => ok({ approvals: [] }),
    });
    const next = await (await GET(get())).json();
    expect(next.announcements.kind).toBe('failed');
    expect(next.categories).toEqual({ kind: 'ok', data: { list: null, revision: 4 } });
  });

  it('drafts an announcement under a category, keyed by its content; none is sent as null', async () => {
    configure();
    const c = upstream({ 'notify.draftNotice': () => ok(NOTICE) });
    expect(await (await POST(post(DRAFT))).json()).toEqual({ ok: true, what: 'drafted' });
    await POST(post(DRAFT));
    await POST(post({ ...DRAFT, category: '' }));
    const [a, b, none] = calls(c).map((x) => JSON.parse(String(x.init.body)));
    expect(a).toMatchObject({ kind: 'announcement', title: DRAFT.title, category: 'listings' });
    expect(a.clientRequestId).toMatch(/^announcement-draft:[0-9a-f]{48}$/);
    expect(b.clientRequestId).toBe(a.clientRequestId);
    expect(none.category).toBeNull();
    expect(none.clientRequestId).not.toBe(a.clientRequestId);
  });

  it('a category off the list comes back refused in words with its code; a malformed one never leaves the console', async () => {
    configure();
    const c = upstream({ 'notify.draftNotice': () => refusal('status.category_unknown', 412) });
    const res = await POST(post({ ...DRAFT, category: 'delistings' }));
    const body = await res.json();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(body).toMatchObject({ ok: false, code: 'status.category_unknown', title: 'That category is not on the list' });
    for (const bad of [{ category: 'Bad Id' }, { category: 7 }, { title: '' }, { basis: 'not-a-uuid' }])
      expect((await POST(post({ ...DRAFT, ...bad }))).status).toBe(400);
    expect(calls(c)).toHaveLength(1);
  });

  it('saves the whole category list from the revision read, with why; blank clears it; a bad line is refused here', async () => {
    configure();
    const c = upstream({ 'statusPage.configure': () => ok({ ...DEFINITION, revision: 5 }) });
    const save = (categories: string, reason = 'TEST set the list') =>
      POST(post({ op: 'categories', categories, expectedRevision: 4, reason }));
    expect(await (await save('listings: New listings\nrisk: Risk notices')).json()).toEqual({ ok: true, what: 'categories saved' });
    expect(sent(c, 'statusPage.configure')).toEqual({
      noticeCategories: [
        { id: 'listings', name: 'New listings' },
        { id: 'risk', name: 'Risk notices' },
      ],
      expectedRevision: 4,
      reason: 'TEST set the list',
    });
    expect(await (await save('  ')).json()).toEqual({ ok: true, what: 'categories cleared' });
    expect(JSON.parse(String(calls(c)[1]!.init.body)).noticeCategories).toBeNull();
    for (const bad of ['listings', 'Listings: New', 'listings: A\nlistings: B']) expect((await save(bad)).status).toBe(400);
    expect((await save('listings: A', ' ')).status).toBe(400);
    expect(calls(c)).toHaveLength(2);
  });
});
