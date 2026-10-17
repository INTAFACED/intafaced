import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
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
const original = { ...process.env };
const queue = {
  items: [{ id: 'case-1', kind: 'manual', subjectId: 'user-9', openedAt: '2026-10-17T02:00:00.000Z' }],
  partnerConfigured: false,
  empty: false,
  summary: 'compliance queue: 1 pending; partner=absent.',
  recentAudit: [],
};
const status = {
  region: { code: 'XX', regionResolved: false, source: 'default', statusLine: 'region unresolved' },
  geoBlock: {
    allowed: false,
    code: 'refuse',
    reason: 'screening not configured',
    screeningDeclaration: 'unset',
    screeningConfigured: false,
    listHitCount: null,
    regionResolved: false,
  },
  networkSignal: {
    declaration: 'unset',
    partnerConfigured: false,
    statusLine: 'none',
    accessAllowed: false,
    accessCode: 'refuse',
    summary: 'unknown',
  },
  freezeAuthority: { soleKey: 'ledger.posting', note: 'one key' },
};
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/compliance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const get = () => GET(new Request('http://admin.example/api/compliance'));
const dispose = { action: 'dispose', itemId: 'case-1', status: 'cleared', reason: 'reviewed: false positive', confirm: 'CLEAR case-1' };

beforeEach(() => {
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_OPERATOR_TOKEN = 'isolated-operator-token';
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...original };
  gate.session.mockReset();
});

describe('GET', () => {
  it('reads status and queue from the edge with the console’s operator credential, with an as-of time', async () => {
    const fn = vi.fn(async (url: string) => Response.json(url.endsWith('/admin/status') ? status : queue));
    vi.stubGlobal('fetch', fn);
    const json = await (await get()).json();
    expect(json.status).toMatchObject({ kind: 'ok' });
    expect(json.queue).toMatchObject({ kind: 'ok', data: { items: [{ id: 'case-1' }] } });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    expect(fn.mock.calls.map((c) => c[0]).sort()).toEqual(['http://edge:4000/admin/compliance/queue', 'http://edge:4000/admin/status']);
    for (const call of fn.mock.calls as unknown as [string, RequestInit][])
      expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer isolated-operator-token');
  });
  it('an unconfigured console says which variable is missing and shows no data', async () => {
    delete process.env.ADMIN_OPERATOR_TOKEN;
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const json = await (await get()).json();
    expect(json.queue).toMatchObject({ kind: 'failed' });
    expect(json.queue.message).toContain('ADMIN_OPERATOR_TOKEN');
    expect(json.queue).not.toHaveProperty('data');
    expect(fn).not.toHaveBeenCalled();
  });
  it('a refused credential or a malformed answer is a failed section, never an empty queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/admin/status')
          ? Response.json({}, { status: 200 })
          : Response.json({ error: 'no', code: 'scope.denied' }, { status: 403 }),
      ),
    );
    const json = await (await get()).json();
    expect(json.status).toMatchObject({ kind: 'failed' });
    expect(json.queue).toMatchObject({ kind: 'failed', code: 'scope.denied' });
  });
  it('a refused founder session returns before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('POST disposition', () => {
  const never = () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    return fn;
  };
  it('refuses a wrong phrase, a short reason, an unknown status or a missing case before the network', async () => {
    const fn = never();
    for (const body of [
      { ...dispose, confirm: 'CLEAR case-2' },
      { ...dispose, confirm: 'REJECT case-1' },
      { ...dispose, reason: 'short' },
      { ...dispose, status: 'partner_cleared', confirm: 'CLEAR case-1' },
      { ...dispose, itemId: '' },
      { ...dispose, action: 'open' },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('a refused session returns before the network', async () => {
    const fn = never();
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_origin' }, { status: 403 }));
    expect((await post(dispose)).status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });
  it('is reported applied only when the edge’s body names the same case and status', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true, status: 'cleared', itemId: 'case-1', actor: 'console', queue }),
    );
    vi.stubGlobal('fetch', fn);
    const res = await post(dispose);
    expect(await res.json()).toMatchObject({ ok: true, itemId: 'case-1', status: 'cleared' });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/admin/compliance/queue/disposition');
    expect(JSON.parse(init!.body as string)).toEqual({ itemId: 'case-1', status: 'cleared', reason: 'reviewed: false positive' });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer isolated-operator-token');
    expect(JSON.stringify(init)).not.toContain('founder-access-token');
  });
  it('a 200 that does not confirm the case is "not known"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, status: 'rejected', itemId: 'case-2' })),
    );
    const res = await post(dispose);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
  it('the edge refusing a disposition passes its sentence through and changed nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { ok: false, error: 'compliance queue: item not found — cannot invent a case to clear.', code: 'refuse.unknown_item' },
          { status: 409 },
        ),
      ),
    );
    const res = await post(dispose);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'refuse.unknown_item', changed: 'no' } });
  });
  it('a dropped connection or a 5xx is "not known"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('hang up');
      }),
    );
    expect(await (await post(dispose)).json()).toMatchObject({ refusal: { changed: 'unknown' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 500 })),
    );
    expect(await (await post(dispose)).json()).toMatchObject({ refusal: { changed: 'unknown' } });
  });
  it('an unconfigured console sends nothing', async () => {
    delete process.env.ADMIN_OPERATOR_TOKEN;
    const fn = never();
    const res = await post(dispose);
    expect(res.status).toBe(503);
    expect(fn).not.toHaveBeenCalled();
  });
  it('logs the founder, the case and the outcome, never the reason text', async () => {
    const warn = vi.mocked(console.warn);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, status: 'cleared', itemId: 'case-1' })),
    );
    await post(dispose);
    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      audit: 'admin.compliance_disposition',
      founder: FOUNDER,
      itemId: 'case-1',
      status: 'cleared',
      outcome: 'applied',
    });
    expect(line).not.toContain(dispose.reason);
  });
});
