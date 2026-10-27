import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { ADMIN_COOKIE, founderCookie, sealFounderSession, type FounderSession } from '../../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/merchants/registries`;

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
  const sealed = sealFounderSession(s, { origin: ORIGIN, edgeUrl: EDGE, key: KEY }, NOW);
  return { cookie: founderCookie(sealed, 3600).split(';')[0]!, csrf: s.csrf };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (headers: Record<string, string> = {}) => new Request(URL_, { method: 'GET', headers });
const authed = () => {
  const { cookie, csrf } = session();
  return { cookie, origin: ORIGIN, 'x-intafaced-csrf': csrf };
};
const entitlement = (status: 'enabled' | 'revoked' | 'not_operator') =>
  Response.json({
    result: {
      data: {
        json:
          status === 'not_operator' ? { status, userId: USER_ID } : { status, userId: USER_ID, version: '1', changedAt: NOW.toISOString() },
      },
    },
  });

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const venueChange = {
  venueId: 'binance-testnet',
  displayName: 'Binance (testnet)',
  mode: 'testnet',
  priority: 10,
  enabled: false,
  minOrder: '10',
  maxOrder: '5000',
  supportedPairs: ['USDT/USD'],
  expectedVersion: null,
  reason: 'Adding a test venue',
};
const preview = { needsDualControl: true, reasons: ['enable'], actionType: 'pay.registry.change', payloadHash: 'sha256:abc' };
const approvalRow = (over: Record<string, unknown> = {}) => ({
  approvalId: 'ap-1',
  actionType: 'pay.registry.change',
  targetService: 'svc-pay',
  targetId: 'pay.registry.change',
  expectedVersion: '1',
  payloadHash: 'sha256:abc',
  requesterId: 'requester',
  approverId: null,
  policyVersion: 'v1',
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
  status: 'PENDING',
  operationId: 'op-1',
  ...over,
});
const ok = (data: unknown) => Response.json({ result: { data } });

/** Route fetches by the tail of the URL so one stub covers the entitlement check and every service hop. */
function upstream(handlers: Record<string, (init: RequestInit, url: string) => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('accountControls.operatorStatus')) return entitlement('enabled');
      const key = Object.keys(handlers).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected upstream call ${url}`);
      return handlers[key]!(init, url);
    }),
  );
  return calls;
}

describe('G6: every Merchants BFF method refuses a request that is not a signed-in founder, and says no-store', () => {
  const methods = [
    ['GET', (h?: Record<string, string>) => get(h), GET],
    ['POST', (h?: Record<string, string>) => post({ action: 'preview' }, h), POST],
  ] as const;

  it.each(methods)('%s with no session configuration answers 503, no-store', async (_m, make, handler) => {
    delete process.env.ADMIN_ORIGIN;
    const res = await handler(make());
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each(methods)('%s with no cookie answers 401, no-store, and never calls a service', async (m, make, handler) => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await handler(make(m === 'POST' ? { origin: ORIGIN } : {}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'admin.session_required' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(methods)('%s with a forged cookie answers 401', async (m, make, handler) => {
    configure();
    const res = await handler(make({ cookie: `${ADMIN_COOKIE}=forged`, ...(m === 'POST' ? { origin: ORIGIN } : {}) }));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a shared proxy header is not a login', async () => {
    configure();
    const res = await POST(post({ action: 'preview' }, { origin: ORIGIN, 'x-intafaced-admin-bff': 'former-shared-secret' }));
    expect(res.status).toBe(401);
  });

  it('POST needs the exact origin and the CSRF nonce', async () => {
    configure();
    const { cookie, csrf } = session();
    const badOrigin = await POST(post({ action: 'preview' }, { cookie, origin: 'https://evil.example', 'x-intafaced-csrf': csrf }));
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toEqual({ code: 'admin.session_origin' });
    expect(badOrigin.headers.get('cache-control')).toBe('no-store');
    const noCsrf = await POST(post({ action: 'preview' }, { cookie, origin: ORIGIN }));
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toEqual({ code: 'admin.session_csrf' });
    const wrongCsrf = await POST(post({ action: 'preview' }, { cookie, origin: ORIGIN, 'x-intafaced-csrf': 'x'.repeat(43) }));
    expect(wrongCsrf.status).toBe(403);
  });

  it.each(['not_operator', 'revoked'] as const)('a signed-in user who is %s is refused on GET and POST', async (status) => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => entitlement(status)),
    );
    for (const res of [await GET(get({ cookie: session().cookie })), await POST(post({ action: 'preview' }, authed()))]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'admin.founder_required' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('ADMIN_MODULES without merchants answers 404 before anything else', async () => {
    configure();
    process.env.ADMIN_MODULES = 'crm';
    for (const res of [await GET(get()), await POST(post({}, authed()))]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('GET by a real founder is 405 and no-store (the route only writes)', async () => {
    configure();
    upstream({});
    const res = await GET(get({ cookie: session().cookie }));
    expect(res.status).toBe(405);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST as a signed-in founder', () => {
  it('rejects bodies it does not understand with 400, before any service call', async () => {
    configure();
    const calls = upstream({});
    for (const body of [
      { action: 'nope' },
      { action: 'preview', registry: 'venue' },
      { action: 'preview', registry: 'secrets', change: venueChange },
      { action: 'preview', registry: 'venue', change: { ...venueChange, apiKey: 'sk_live_abcdefghijklmnop' } },
      { action: 'reject', approvalId: '' },
    ]) {
      const res = await POST(post(body, authed()));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(calls.filter((c) => !c.url.includes('operatorStatus') && !c.url.includes('consoleMode.get'))).toHaveLength(0);
  });

  it('preview asks svc-pay as the founder and returns what the change needs', async () => {
    configure();
    const calls = upstream({ 'founderAdmin.registries.preview': () => ok(preview) });
    const res = await POST(post({ action: 'preview', registry: 'venue', change: venueChange }, authed()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, preview });
    const hop = calls.find((c) => c.url.includes('registries.preview'))!;
    expect(hop.url.startsWith(`${EDGE}/api/pay/trpc/`)).toBe(true);
    expect((hop.init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    // The browser never names an actor and the console adds none.
    expect(decodeURIComponent(hop.url)).not.toContain(USER_ID);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('propose binds the identity approval to the hash the service computed, not one the browser sent', async () => {
    configure();
    const calls = upstream({
      'founderAdmin.registries.preview': () => ok(preview),
      'actionApproval.propose': () => ok(approvalRow()),
    });
    const res = await POST(
      post({ action: 'propose', registry: 'venue', change: { ...venueChange, payloadHash: 'sha256:evil' } }, authed()),
    );
    // an extra key is refused outright
    expect(res.status).toBe(400);
    const res2 = await POST(post({ action: 'propose', registry: 'venue', change: venueChange }, authed()));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({
      ok: true,
      approval: { approvalId: 'ap-1', operationId: 'op-1', status: 'PENDING', payloadHash: 'sha256:abc' },
    });
    const propose = calls.find((c) => c.url.includes('actionApproval.propose'))!;
    expect(propose.url.startsWith(`${EDGE}/api/identity/trpc/`)).toBe(true);
    expect(JSON.parse(propose.init.body as string)).toEqual({
      actionType: 'pay.registry.change',
      targetService: 'svc-pay',
      targetId: 'pay.registry.change',
      expectedVersion: '1',
      payloadHash: 'sha256:abc',
      policyVersion: 'v1',
    });
  });

  it('propose on a change that needs no second founder says so and asks identity for nothing', async () => {
    configure();
    const calls = upstream({ 'founderAdmin.registries.preview': () => ok({ ...preview, needsDualControl: false, reasons: [] }) });
    const res = await POST(post({ action: 'propose', registry: 'venue', change: venueChange }, authed()));
    expect(res.status).toBe(409);
    expect((await res.json()).refusal.title).toMatch(/No second founder is needed/);
    expect(calls.some((c) => c.url.includes('actionApproval'))).toBe(false);
  });

  it('approve sends the reviewed payload hash with the approval id, so identity can bind the approval to it', async () => {
    configure();
    const calls = upstream({
      'founderAdmin.registries.preview': () => ok(preview),
      'actionApproval.approve': () => ok(approvalRow({ status: 'APPROVED' })),
    });
    const res = await POST(post({ action: 'approve', registry: 'venue', change: venueChange, approvalId: 'ap-1' }, authed()));
    expect((await res.json()).matchesReviewedChange).toBe(true);
    const approveCall = calls.find((c) => c.url.includes('actionApproval.approve'));
    expect(JSON.parse(String(approveCall?.init.body))).toEqual({ approvalId: 'ap-1', expectedPayloadHash: 'sha256:abc' });
  });

  it('approve shows a plain-English refusal when identity says the approval is for a different change', async () => {
    configure();
    upstream({
      'founderAdmin.registries.preview': () => ok(preview),
      'actionApproval.approve': () =>
        Response.json(
          {
            error: {
              message: 'different payload [action_approval.payload_mismatch]',
              code: -32603,
              data: { code: 'PRECONDITION_FAILED', httpStatus: 412, cause: { code: 'action_approval.payload_mismatch' } },
            },
          },
          { status: 412 },
        ),
    });
    const res = await POST(post({ action: 'approve', registry: 'venue', change: venueChange, approvalId: 'ap-1' }, authed()));
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.refusal.title).toBe('The approval is for a different change');
    expect(JSON.stringify([body.refusal.title, body.refusal.body, body.refusal.next])).not.toMatch(/action_approval|412/);
  });

  it('approve flags an approval that covers a different change', async () => {
    configure();
    upstream({
      'founderAdmin.registries.preview': () => ok(preview),
      'actionApproval.approve': () => ok(approvalRow({ status: 'APPROVED', payloadHash: 'sha256:other' })),
    });
    const res = await POST(post({ action: 'approve', registry: 'venue', change: venueChange, approvalId: 'ap-1' }, authed()));
    expect(await res.json()).toMatchObject({ ok: true, matchesReviewedChange: false, reviewedPayloadHash: 'sha256:abc' });
  });

  it('approve by the same founder is a plain-English refusal, not a code', async () => {
    configure();
    upstream({
      'founderAdmin.registries.preview': () => ok(preview),
      'actionApproval.approve': () =>
        Response.json(
          {
            error: {
              message: 'same person [action_approval.same_person]',
              code: -32603,
              data: { code: 'PRECONDITION_FAILED', httpStatus: 412, cause: { code: 'action_approval.same_person' } },
            },
          },
          { status: 412 },
        ),
    });
    const res = await POST(post({ action: 'approve', registry: 'venue', change: venueChange, approvalId: 'ap-1' }, authed()));
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.refusal.title).toBe('You cannot approve your own change');
    expect(JSON.stringify([body.refusal.title, body.refusal.body, body.refusal.next])).not.toMatch(/action_approval|412/);
  });

  it('save posts to the right procedure with the approval pair and returns the saved view', async () => {
    configure();
    const saved = {
      ...venueChange,
      health: null,
      version: 1,
      updatedAt: NOW.toISOString(),
      updatedBy: USER_ID,
      routable: false,
      missing: [],
      priority: 10,
    };
    const calls = upstream({ 'founderAdmin.registries.venues.save': () => ok(saved) });
    const res = await POST(
      post({ action: 'save', registry: 'venue', change: { ...venueChange, approvalId: 'ap-1', operationId: 'op-1' } }, authed()),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, listHref: '/merchants/registries/venues' });
    const hop = calls.find((c) => c.url.includes('venues.save'))!;
    expect(hop.init.method).toBe('POST');
    expect(JSON.parse(hop.init.body as string)).toMatchObject({ venueId: 'binance-testnet', approvalId: 'ap-1', operationId: 'op-1' });
  });

  it('save routes each registry to its own procedure', async () => {
    configure();
    const calls = upstream({
      'registries.networks.save': () => new Response('{}', { status: 500 }),
      'registries.walletRoutes.save': () => new Response('{}', { status: 500 }),
    });
    const network = {
      networkId: 'ethereum-sepolia',
      displayName: 'Sepolia',
      assetCodes: ['USDT'],
      confirmationsRequired: 12,
      enabled: false,
      feeEstimateSource: null,
      feeEstimateAmount: null,
      expectedVersion: null,
      reason: 'Adding a test network',
    };
    const route = {
      assetCode: 'USDT',
      networkId: 'ethereum-sepolia',
      payoutAllowed: false,
      merchantAllow: [],
      merchantDeny: [],
      maxSinglePayout: null,
      expectedVersion: null,
      reason: 'Adding a route',
    };
    await POST(post({ action: 'save', registry: 'network', change: network }, authed()));
    await POST(post({ action: 'save', registry: 'wallet_route', change: route }, authed()));
    expect(calls.some((c) => c.url.includes('registries.networks.save'))).toBe(true);
    expect(calls.some((c) => c.url.includes('registries.walletRoutes.save'))).toBe(true);
  });

  it('a live-venue refusal reaches the founder in plain words with the real status', async () => {
    configure();
    upstream({
      'venues.save': () =>
        Response.json(
          {
            error: {
              message: 'registries.live_mode_refused: no',
              code: -32603,
              data: { code: 'FORBIDDEN', httpStatus: 403, cause: { code: 'registries.live_mode_refused' } },
            },
          },
          { status: 403, headers: { 'x-request-id': 'req-9' } },
        ),
    });
    const res = await POST(post({ action: 'save', registry: 'venue', change: venueChange }, authed()));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.refusal).toMatchObject({ title: 'Live venues are not allowed', requestId: 'req-9' });
  });

  it('a registry that is not mounted on this deployment is a clear "not switched on", status 501', async () => {
    configure();
    upstream({
      'registries.preview': () =>
        Response.json(
          {
            error: {
              message: 'No procedure found on path "founderAdmin.registries.preview"',
              data: { code: 'NOT_FOUND', httpStatus: 404 },
            },
          },
          { status: 404 },
        ),
    });
    const res = await POST(post({ action: 'preview', registry: 'venue', change: venueChange }, authed()));
    expect(res.status).toBe(501);
    expect((await res.json()).refusal.title).toBe('This is not switched on');
  });

  it('reject closes the approval through identity', async () => {
    configure();
    const calls = upstream({ 'actionApproval.reject': () => ok(approvalRow({ status: 'REJECTED' })) });
    const res = await POST(post({ action: 'reject', approvalId: 'ap-1' }, authed()));
    expect(await res.json()).toEqual({ ok: true, approval: { approvalId: 'ap-1', status: 'REJECTED' } });
    expect(JSON.parse(calls.find((c) => c.url.includes('reject'))!.init.body as string)).toEqual({ approvalId: 'ap-1' });
  });
});
