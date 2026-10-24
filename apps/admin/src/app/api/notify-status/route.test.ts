import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/notify-status`;

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

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const DEFINITION = {
  components: [{ id: 'card-network', name: 'Card network', group: null, source: 'TEST card scheme' }],
  componentCap: 5,
  stalenessSeconds: 600,
  uptimeDays: null,
  challengeBits: null,
  subscribeRatePerHour: null,
  revision: 3,
  updatedAt: '2026-10-23T10:00:00.000Z',
  publicOrigin: 'https://site.example',
};
const PAGE = {
  asOf: '2026-10-23T12:00:00.000Z',
  revision: 3,
  settings: { componentCap: 5, stalenessSeconds: 600, uptimeDays: null, challengeBits: null, subscribeRatePerHour: null },
  overall: 'no_data',
  components: [
    {
      id: 'card-network',
      name: 'Card network',
      group: null,
      source: 'TEST card scheme',
      state: 'no_data',
      basis: 'stale',
      reading: { state: 'operational', observedAt: '2026-10-23T11:00:00.000Z', source: 'TEST card scheme' },
      incidentId: null,
      uptime: [],
    },
  ],
  incidents: [],
};
const refusal = (code: string, status: number) =>
  Response.json({ error: { message: code, data: { httpStatus: status, cause: { code } } } }, { status });

describe('status page desk BFF', () => {
  it('a change without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({ op: 'configure' }, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });

  it('the module switch answers 404', async () => {
    configure();
    process.env.ADMIN_MODULES = 'crm';
    expect((await GET(get())).status).toBe(404);
  });

  it('reads the definition and the visitor page as the founder, with the founder token', async () => {
    configure();
    const c = upstream({ 'statusPage.definition': () => ok(DEFINITION), 'statusPage.read': () => ok(PAGE) });
    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.definition).toEqual({ kind: 'ok', data: DEFINITION });
    expect(body.page.kind).toBe('ok');
    expect(body.page.data.components[0].basis).toBe('stale');
    for (const call of calls(c)) expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('a definition the console cannot read is a failed part, never an empty page', async () => {
    configure();
    upstream({ 'statusPage.definition': () => ok({ components: 'x' }), 'statusPage.read': () => ok(PAGE) });
    const body = await (await GET(get())).json();
    expect(body.definition.kind).toBe('failed');
  });

  it('sends a definition change from the revision read, with its reason', async () => {
    configure();
    const c = upstream({ 'statusPage.configure': () => ok({ ...DEFINITION, revision: 4 }) });
    const change = {
      op: 'configure',
      components: DEFINITION.components,
      componentCap: 5,
      expectedRevision: 3,
      reason: 'TEST add card network',
    };
    const res = await POST(post(change));
    expect(await res.json()).toEqual({ ok: true, what: 'configured' });
    const sent = JSON.parse(String(calls(c)[0]!.init.body));
    expect(sent).toEqual({ components: DEFINITION.components, componentCap: 5, expectedRevision: 3, reason: 'TEST add card network' });
  });

  it('a stale revision comes back in words and says nothing changed', async () => {
    configure();
    upstream({ 'statusPage.configure': () => refusal('status.page_revision_stale', 409) });
    const res = await POST(post({ op: 'configure', componentCap: 5, expectedRevision: 2, reason: 'TEST' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, title: 'Someone changed the page first', changed: 'no' });
  });

  it('a reading that is not complete is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const res = await POST(post({ op: 'record', componentId: 'card-network', state: 'operational', source: '' }));
    expect(res.status).toBe(400);
    expect(calls(c)).toHaveLength(0);
  });

  it('stores a reading entered by hand, stamped by the console server and not by the browser', async () => {
    configure();
    const c = upstream({ 'statusPage.record': (init) => ok(JSON.parse(String(init.body))) });
    const before = Date.now();
    const res = await POST(
      post({
        op: 'record',
        componentId: 'card-network',
        state: 'degraded',
        source: 'TEST card scheme',
        observedAt: '2001-01-01T00:00:00.000Z',
      }),
    );
    expect(await res.json()).toEqual({ ok: true, what: 'recorded' });
    const sent = JSON.parse(String(calls(c)[0]!.init.body));
    expect(sent).toMatchObject({ componentId: 'card-network', state: 'degraded', source: 'TEST card scheme' });
    expect(Date.parse(sent.observedAt)).toBeGreaterThanOrEqual(before);
  });

  it('a dropped connection on a change is an unknown outcome, not a failure', async () => {
    configure();
    upstream({
      'statusPage.record': () => {
        throw new TypeError('fetch failed');
      },
    });
    const reading = { componentId: 'card-network', state: 'degraded', source: 'TEST card scheme' };
    expect(await (await POST(post({ op: 'record', ...reading }))).json()).toMatchObject({ ok: false, changed: 'unknown' });
  });
});
