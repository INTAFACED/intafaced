import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/notify-recipients`;
const QAT = '2026-10-20T10:00:01.000Z';

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
const get = (query: string) => new Request(`${URL_}${query}`, { headers: { cookie: session().cookie } });
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
const calls = <T extends { url: string }>(c: T[]) => c.filter((x) => !x.url.includes('operatorStatus'));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('recipient health BFF', () => {
  it('a release without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({}, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });

  it('the module switch answers 404', async () => {
    configure();
    process.env.ADMIN_MODULES = 'crm';
    expect((await GET(get('?state=active'))).status).toBe(404);
  });

  it('GET reads one state as the founder and rejects a state it does not know', async () => {
    configure();
    const c = upstream({
      'notify.operatorRecipients': () => ok({ threshold: null, thresholdCode: 'notify.quarantine_threshold_unset', items: [] }),
    });
    expect((await GET(get('?state=bogus'))).status).toBe(400);
    const res = await GET(get('?state=quarantined'));
    const body = await res.json();
    expect(body.kind).toBe('ok');
    expect(body.data.thresholdCode).toBe('notify.quarantine_threshold_unset');
    const call = calls(c).find((x) => x.url.includes('operatorRecipients'))!;
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(decodeURIComponent(call.url)).toContain('"state":"quarantined"');
  });

  it('a read in an unknown shape is a failed part, never an empty list', async () => {
    configure();
    upstream({ 'notify.operatorRecipients': () => ok({ nope: true }) });
    expect((await (await GET(get('?state=active'))).json()).kind).toBe('failed');
  });

  it('rejects an incomplete release with 400 and no service call', async () => {
    configure();
    const c = upstream({});
    for (const body of [
      {},
      { userId: USER_ID, channel: 'inapp', quarantinedAt: QAT, reason: 'mailbox fixed by the user' },
      { userId: USER_ID, channel: 'email', quarantinedAt: 'yesterday', reason: 'mailbox fixed by the user' },
      { userId: USER_ID, channel: 'email', quarantinedAt: QAT, reason: 'short' },
    ]) {
      expect((await POST(post(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls(c)).toHaveLength(0);
  });

  it('a release sends the reason, a stable business key and never an actor', async () => {
    configure();
    const c = upstream({ 'notify.operatorReleaseRecipient': () => ok({ released: true, replayed: false }) });
    const input = { userId: USER_ID, channel: 'email', quarantinedAt: QAT, reason: '  mailbox fixed by the user  ', actor: 'spoof' };
    const first = await POST(post(input));
    expect(await first.json()).toEqual({ ok: true, replayed: false });
    await POST(post(input));
    const sent = calls(c)
      .filter((x) => x.url.includes('operatorReleaseRecipient'))
      .map((x) => JSON.parse(String(x.init.body)));
    expect(sent[0]).toEqual({
      userId: USER_ID,
      channel: 'email',
      reason: 'mailbox fixed by the user',
      reasonId: `notify-release:${USER_ID}:email:${QAT}`,
    });
    expect(sent[1].reasonId).toBe(sent[0].reasonId);
  });

  it('a typed refusal is explained in plain English with nothing changed', async () => {
    configure();
    upstream({
      'notify.operatorReleaseRecipient': () =>
        Response.json({ error: { data: { cause: { code: 'notify.recipient_not_quarantined' } } } }, { status: 412 }),
    });
    const res = await POST(post({ userId: USER_ID, channel: 'sms', quarantinedAt: QAT, reason: 'mailbox fixed by the user' }));
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, title: 'This address is not quarantined', changed: 'no' });
  });

  it('a dropped connection or an unreadable 200 says the outcome is unknown', async () => {
    configure();
    upstream({
      'notify.operatorReleaseRecipient': () => {
        throw new Error('socket hang up');
      },
    });
    const input = { userId: USER_ID, channel: 'email', quarantinedAt: QAT, reason: 'mailbox fixed by the user' };
    const dropped = await POST(post(input));
    expect((await dropped.json()).changed).toBe('unknown');
    vi.unstubAllGlobals();
    upstream({ 'notify.operatorReleaseRecipient': () => ok({ weird: 1 }) });
    expect((await (await POST(post(input))).json()).changed).toBe('unknown');
  });
});
