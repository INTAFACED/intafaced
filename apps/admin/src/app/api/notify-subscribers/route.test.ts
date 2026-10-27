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
const URL_ = `${ORIGIN}/api/notify-subscribers`;

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
const get = (query = '') => new Request(`${URL_}${query}`, { headers: { cookie: session().cookie } });
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
const calls = <T extends { url: string }>(c: T[]) =>
  c.filter((x) => !x.url.includes('operatorStatus') && !x.url.includes('consoleMode.get'));
const sent = (c: { url: string; init: RequestInit }[], procedure: string) =>
  JSON.parse(String(calls(c).find((x) => x.url.includes(procedure))!.init.body));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const CHANNELS = { email: { sender: null, notConnected: 'vendor.email' }, sms: 'vendor.sms', push: 'vendor.push' };
const SUBSCRIBER = {
  id: OTHER_ID,
  email: 'one@example.com',
  state: 'unconfirmed',
  componentIds: null,
  source: 'test-list',
  webhook: false,
  createdAt: '2026-10-23T10:00:00.000Z',
  deliveries: { pending: 1, accepted: 0, failed: 0, refused: 0 },
};
const DELIVERY = {
  key: `${NOTICE_ID}:${OTHER_ID}:email`,
  subscriberId: OTHER_ID,
  event: NOTICE_ID,
  channel: 'email',
  status: 'pending',
  refusalCode: 'vendor.email',
  attempts: 1,
  email: 'one@example.com',
};
const DEFINITION = {
  components: [],
  componentCap: 5,
  stalenessSeconds: 600,
  uptimeDays: null,
  challengeBits: 8,
  subscribeRatePerHour: null,
  revision: 7,
  updatedAt: '2026-10-23T10:00:00.000Z',
  publicOrigin: null,
};
const PUBLISHED = { id: NOTICE_ID, kind: 'incident', title: 'TEST payments slow', publishedAt: '2026-10-23T10:00:00.000Z' };
const desk = () => ({
  'statusPage.subscriptions.channels': () => ok(CHANNELS),
  'statusPage.subscriptions.list': () => ok([SUBSCRIBER]),
  'notify.notices': () => ok([PUBLISHED, { ...PUBLISHED, id: 'c', kind: 'changelog' }]),
  'statusPage.definition': () => ok(DEFINITION),
  'statusPage.subscriptions.deliveries': () => ok({ rows: [DELIVERY], more: false }),
});

describe('subscriber desk BFF', () => {
  it('a change without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({ op: 'resend', noticeId: NOTICE_ID }, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });

  it('the module switch answers 404', async () => {
    configure();
    process.env.ADMIN_MODULES = 'crm';
    expect((await GET(get())).status).toBe(404);
  });

  it('reads channels, subscribers, safeguards and published notices; delivery rows only for a chosen notice', async () => {
    configure();
    const c = upstream(desk());
    const body = await (await GET(get())).json();
    expect(body.channels).toEqual({ kind: 'ok', data: CHANNELS });
    expect(body.subscribers.data[0]).toMatchObject({ email: 'one@example.com', source: 'test-list' });
    expect(body.safeguards).toEqual({ kind: 'ok', data: { challengeBits: 8, subscribeRatePerHour: null, revision: 7 } });
    expect(body.notices.data.map((n: { kind: string }) => n.kind)).toEqual(['incident']);
    expect(body.deliveries).toBeNull();
    expect(calls(c).some((x) => x.url.includes('subscriptions.deliveries'))).toBe(false);
    const chosen = await (await GET(get(`?state=unconfirmed&notice=${NOTICE_ID}`))).json();
    expect(chosen.deliveries).toEqual({
      kind: 'ok',
      data: { rows: [expect.objectContaining({ status: 'pending', refusalCode: 'vendor.email' })], more: false },
    });
    expect(chosen.state).toBe('unconfirmed');
    for (const call of calls(c)) expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('subscribers the console cannot read are a failed part, never an empty list', async () => {
    configure();
    upstream({ ...desk(), 'statusPage.subscriptions.list': () => ok([{ id: 1 }]) });
    expect((await (await GET(get())).json()).subscribers.kind).toBe('failed');
  });

  it('resends a notice by its id', async () => {
    configure();
    const c = upstream({ 'statusPage.subscriptions.resend': () => ok({ rows: [DELIVERY], more: false }) });
    expect(await (await POST(post({ op: 'resend', noticeId: NOTICE_ID }))).json()).toEqual({ ok: true, what: 'sent again' });
    expect(sent(c, 'subscriptions.resend')).toEqual({ noticeId: NOTICE_ID });
  });

  it('imports with its source and answers what it did; a blank rate limit comes back in words', async () => {
    configure();
    const result = { received: 3, distinct: 2, added: 2, alreadyKnown: 0, invalid: [], limited: 0 };
    const c = upstream({ 'statusPage.subscriptions.import': () => ok(result) });
    const res = await POST(post({ op: 'import', source: 'test-list', emails: ['a@example.com', 'A@example.com', 'b@example.com'] }));
    expect(await res.json()).toEqual({ ok: true, what: 'imported', imported: result });
    expect(sent(c, 'subscriptions.import')).toEqual({ source: 'test-list', emails: ['a@example.com', 'A@example.com', 'b@example.com'] });
    upstream({ 'statusPage.subscriptions.import': () => refusal('status.rate_limit_unset', 412) });
    const refused = await POST(post({ op: 'import', source: 'test-list', emails: ['a@example.com'] }));
    expect(refused.status).toBe(412);
    expect(await refused.json()).toMatchObject({ ok: false, title: 'The subscribe rate limit is blank', code: 'status.rate_limit_unset' });
  });

  it('refuses a malformed import or safeguard before any service call', async () => {
    configure();
    const c = upstream({});
    expect((await POST(post({ op: 'import', source: 'Bad Source', emails: ['a@example.com'] }))).status).toBe(400);
    expect((await POST(post({ op: 'import', source: 'ok', emails: [] }))).status).toBe(400);
    expect(
      (await POST(post({ op: 'safeguards', challengeBits: 99, subscribeRatePerHour: null, expectedRevision: 7, reason: 'TEST' }))).status,
    ).toBe(400);
    expect(
      (await POST(post({ op: 'safeguards', challengeBits: 8, subscribeRatePerHour: null, expectedRevision: 7, reason: ' ' }))).status,
    ).toBe(400);
    expect(calls(c)).toHaveLength(0);
  });

  it('saves the safeguards from the revision read, blank as blank', async () => {
    configure();
    const c = upstream({ 'statusPage.configure': () => ok({ ...DEFINITION, revision: 8 }) });
    const change = {
      op: 'safeguards',
      challengeBits: 8,
      subscribeRatePerHour: null,
      expectedRevision: 7,
      reason: 'TEST blank the rate limit',
    };
    expect(await (await POST(post(change))).json()).toEqual({ ok: true, what: 'safeguards saved' });
    expect(sent(c, 'statusPage.configure')).toEqual({
      challengeBits: 8,
      subscribeRatePerHour: null,
      expectedRevision: 7,
      reason: 'TEST blank the rate limit',
    });
  });
});
