import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_COOKIE,
  ADMIN_DEVICE_COOKIE,
  adminDeviceKey,
  adminSessionConfig,
  adminSessionErrorResponse,
  assertAdminCsrf,
  assertAdminOrigin,
  assertCurrentFounder,
  authorizeAdminRequest,
  founderCookie,
  founderEdgeCall,
  openFounderSession,
  sealFounderSession,
  deviceAuthorisationOf,
  upstreamCodeOf,
  type AdminSessionConfig,
  type FounderSession,
} from './founder-session.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://admin.example.test';
const EDGE = 'https://edge.example.test';
const ACCESS = 'real-user-access-token';
const SHARED_TOKEN = 'operator-shared-token-must-not-be-used';

function config(overrides: Partial<AdminSessionConfig> = {}): AdminSessionConfig {
  return { origin: ORIGIN, edgeUrl: EDGE, key: Buffer.alloc(32, 7), ...overrides };
}

function session(overrides: Partial<FounderSession> = {}): FounderSession {
  return {
    userId: USER_ID,
    accessToken: ACCESS,
    refreshToken: 'refresh-token',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    csrf: Buffer.alloc(32, 8).toString('base64url'),
    ...overrides,
  };
}

function cookieRequest(options: { method?: string; cookie?: string; csrf?: string; origin?: string; url?: string } = {}): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) headers.set('cookie', options.cookie);
  if (options.csrf !== undefined) headers.set('x-intafaced-csrf', options.csrf);
  if (options.origin !== undefined) headers.set('origin', options.origin);
  return new Request(options.url ?? `${ORIGIN}/api/crm`, { method: options.method ?? 'GET', headers });
}

function entitlement(status: 'enabled' | 'revoked' | 'not_operator', userId = USER_ID): Response {
  const row = status === 'not_operator' ? { status, userId } : { status, userId, version: '1', changedAt: NOW.toISOString() };
  return Response.json({ result: { data: { json: row } } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('founder admin session security boundaries', () => {
  it('accepts the configured public HTTPS authority when Next constructs an internal request URL', () => {
    const origin = 'https://admin.intafaced.test';
    const request = new Request('https://localhost:3100/api/crm', {
      method: 'POST',
      headers: {
        host: 'admin.intafaced.test',
        'x-forwarded-proto': 'https',
        origin,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(() => assertAdminOrigin(request, config({ origin }), true)).not.toThrow();
  });

  it.each([
    ['wrong Host with forged forwarded host', { host: 'evil.example.test', 'x-forwarded-host': 'admin.example.test' }],
    ['empty Host', { host: '' }],
    ['wrong Host port', { host: 'admin.example.test:3100' }],
    ['unexpected default Host port', { host: 'admin.example.test:443' }],
    ['invalid Host port', { host: 'admin.example.test:invalid' }],
    ['Host user information', { host: 'user@admin.example.test' }],
    ['multiple Host values', { host: 'admin.example.test,evil.example.test' }],
    ['wrong forwarded scheme', { 'x-forwarded-proto': 'http' }],
    ['empty forwarded scheme', { 'x-forwarded-proto': '' }],
    ['mixed forwarded protocols', { 'x-forwarded-proto': 'https,http' }],
    ['reverse mixed forwarded protocols', { 'x-forwarded-proto': 'http,https' }],
    ['multiple matching forwarded protocols', { 'x-forwarded-proto': 'https, https' }],
    ['uppercase forwarded protocol', { 'x-forwarded-proto': 'HTTPS' }],
    ['malformed forwarded protocol', { 'x-forwarded-proto': 'https://' }],
    ['wrong browser Origin', { origin: 'https://evil.example.test' }],
    ['cross-site browser request', { 'sec-fetch-site': 'cross-site' }],
  ] as const)('refuses %s despite an otherwise configured public authority', (_label, overrides) => {
    const request = new Request('https://localhost:3100/api/crm', {
      method: 'POST',
      headers: { host: 'admin.example.test', 'x-forwarded-proto': 'https', origin: ORIGIN, ...overrides },
    });
    expect(() => assertAdminOrigin(request, config(), true)).toThrowError(
      expect.objectContaining({ code: 'admin.session_origin', status: 403 }),
    );
  });

  it('requires the configured scheme when the forwarded protocol is absent, and matches Host case and configured port', () => {
    const cfg = config({ origin: 'https://admin.example.test:8443' });
    const secure = new Request('https://localhost:3100/api/session', { headers: { host: 'ADMIN.EXAMPLE.TEST:8443' } });
    expect(() => assertAdminOrigin(secure, cfg, false)).not.toThrow();
    const insecure = new Request('http://localhost:3100/api/session', { headers: { host: 'admin.example.test:8443' } });
    expect(() => assertAdminOrigin(insecure, cfg, false)).toThrowError(
      expect.objectContaining({ code: 'admin.session_origin', status: 403 }),
    );
  });

  it('keeps Host-absent constructed requests bound to the full URL origin and validates any protocol header', () => {
    expect(() => assertAdminOrigin(new Request(`${ORIGIN}/api/session`), config(), false)).not.toThrow();
    for (const request of [
      new Request('https://localhost:3100/api/session', { headers: { 'x-forwarded-proto': 'https' } }),
      new Request(`${ORIGIN}/api/session`, { headers: { 'x-forwarded-proto': 'https,http' } }),
      new Request(`${ORIGIN}/api/session`, { headers: { 'x-forwarded-proto': 'http' } }),
    ]) {
      expect(() => assertAdminOrigin(request, config(), false)).toThrowError(
        expect.objectContaining({ code: 'admin.session_origin', status: 403 }),
      );
    }
  });

  it('retains session CSRF and live founder validation on a mutation forwarded to an internal listener', async () => {
    vi.stubEnv('ADMIN_SESSION_SECRET', config().key.toString('base64url'));
    vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
    vi.stubEnv('EDGE_URL', EDGE);
    const authNow = new Date();
    const current = session({ issuedAt: authNow.toISOString(), expiresAt: new Date(authNow.getTime() + 60_000).toISOString() });
    const sealed = sealFounderSession(current, config(), authNow);
    const headers = {
      host: 'admin.example.test',
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      cookie: `${ADMIN_COOKIE}=${sealed}`,
      'x-intafaced-csrf': current.csrf,
    };
    const fetchMock = vi.fn(async () => entitlement('enabled'));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('http://localhost:3100/api/crm', { method: 'POST', headers });
    await expect(authorizeAdminRequest(request)).resolves.toMatchObject({ session: { userId: USER_ID } });
    // The founder check, then the maintenance-mode read every write makes (here unreadable, so the write is not held).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockClear();
    await expect(
      authorizeAdminRequest(new Request(request.url, { method: 'POST', headers: { ...headers, 'x-intafaced-csrf': 'wrong' } })),
    ).rejects.toMatchObject({ code: 'admin.session_csrf', status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => entitlement('revoked'));
    await expect(authorizeAdminRequest(request)).rejects.toMatchObject({ code: 'admin.founder_required', status: 403 });
  });

  it.each(['fetch', 'body'] as const)(
    'refuses a stalled %s within the request deadline even when transport ignores abort',
    async (phase) => {
      vi.useFakeTimers();
      const stalled = new Promise<Response>(() => undefined);
      const bodyResponse = entitlement('enabled');
      vi.spyOn(bodyResponse, 'json').mockImplementation(() => new Promise(() => undefined));
      vi.stubGlobal(
        'fetch',
        vi.fn(() => (phase === 'fetch' ? stalled : Promise.resolve(bodyResponse))),
      );
      let completed = false;
      const outcome = founderEdgeCall(config(), 'identity', 'accountControls.operatorStatus', 'GET', {}, ACCESS).then(
        () => {
          completed = true;
          return null;
        },
        (failure: unknown) => {
          completed = true;
          return failure;
        },
      );
      await vi.advanceTimersByTimeAsync(5001);
      expect(completed).toBe(true);
      expect(await outcome).toMatchObject({ code: 'admin.upstream_unavailable', status: 503 });
    },
  );
  it('seals and opens an authenticated encrypted cookie, and rejects tampering, another key, or another host', () => {
    const cfg = config();
    const token = sealFounderSession(session(), cfg, NOW);
    expect(openFounderSession(`${ADMIN_COOKIE}=${token}`, cfg, NOW)).toEqual(session());
    expect(() => openFounderSession(`${ADMIN_COOKIE}=${token.slice(0, -1)}x`, cfg, NOW)).toThrowError(
      expect.objectContaining({ code: 'admin.session_required', status: 401 }),
    );
    expect(() => openFounderSession(`${ADMIN_COOKIE}=${token}`, config({ key: Buffer.alloc(32, 9) }), NOW)).toThrowError(
      expect.objectContaining({ code: 'admin.session_required', status: 401 }),
    );
    expect(() => openFounderSession(`${ADMIN_COOKIE}=${token}`, config({ origin: 'https://other.example.test' }), NOW)).toThrowError(
      expect.objectContaining({ code: 'admin.session_required', status: 401 }),
    );
  });

  it('rejects duplicate, absent, and expired session cookies', () => {
    const cfg = config();
    const token = sealFounderSession(session(), cfg, NOW);
    expect(() => openFounderSession(`${ADMIN_COOKIE}=${token}; ${ADMIN_COOKIE}=${token}`, cfg, NOW)).toThrowError(
      expect.objectContaining({ code: 'admin.session_required' }),
    );
    expect(() => openFounderSession(null, cfg, NOW)).toThrowError(expect.objectContaining({ code: 'admin.session_required' }));
    const expired = sealFounderSession(
      session({ issuedAt: new Date(NOW.getTime() - 60_000).toISOString(), expiresAt: new Date(NOW.getTime() - 1).toISOString() }),
      cfg,
      new Date(NOW.getTime() - 60_000),
    );
    expect(() => openFounderSession(`${ADMIN_COOKIE}=${expired}`, cfg, NOW)).toThrowError(
      expect.objectContaining({ code: 'admin.session_required' }),
    );
  });

  it('requires a canonical 256-bit key, explicit HTTPS origin, and rejects ambiguous host configuration', () => {
    const secret = Buffer.alloc(32, 3).toString('base64url');
    expect(adminSessionConfig({ ADMIN_SESSION_SECRET: secret, ADMIN_ORIGIN: ORIGIN, EDGE_URL: EDGE }).key).toHaveLength(32);
    for (const badSecret of [undefined, 'short', `${secret}=`]) {
      expect(() => adminSessionConfig({ ADMIN_SESSION_SECRET: badSecret, ADMIN_ORIGIN: ORIGIN, EDGE_URL: EDGE })).toThrowError(
        expect.objectContaining({ code: 'admin.session_unconfigured', status: 503 }),
      );
    }
    for (const badOrigin of [
      undefined,
      'http://admin.example.test',
      `${ORIGIN}/nested`,
      `${ORIGIN}?x=1`,
      'https://u:p@admin.example.test',
    ]) {
      expect(() =>
        adminSessionConfig({ ADMIN_SESSION_SECRET: secret, ADMIN_ORIGIN: badOrigin, EDGE_URL: EDGE, APP_ENV: 'prod' }),
      ).toThrowError(expect.objectContaining({ code: 'admin.session_unconfigured' }));
    }
  });

  it('sets a secure host-only strict cookie and refuses origin or CSRF violations', () => {
    const header = founderCookie('sealed', 90.9);
    expect(header).toBe(`${ADMIN_COOKIE}=sealed; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=90`);
    expect(header.toLowerCase()).not.toContain('domain=');
    const cfg = config();
    expect(() => assertAdminOrigin(cookieRequest({ url: 'https://attacker.example/api', origin: ORIGIN }), cfg, false)).toThrowError(
      expect.objectContaining({ code: 'admin.session_origin', status: 403 }),
    );
    expect(() => assertAdminOrigin(cookieRequest({ origin: 'https://attacker.example' }), cfg, true)).toThrowError(
      expect.objectContaining({ code: 'admin.session_origin', status: 403 }),
    );
    expect(() => assertAdminOrigin(cookieRequest({ method: 'POST' }), cfg, true)).toThrowError(
      expect.objectContaining({ code: 'admin.session_origin', status: 403 }),
    );
    expect(() => assertAdminCsrf(cookieRequest(), session())).toThrowError(
      expect.objectContaining({ code: 'admin.session_csrf', status: 403 }),
    );
    expect(() => assertAdminCsrf(cookieRequest({ csrf: `${session().csrf}x` }), session())).toThrowError(
      expect.objectContaining({ code: 'admin.session_csrf', status: 403 }),
    );
    expect(() => assertAdminCsrf(cookieRequest({ csrf: session().csrf }), session())).not.toThrow();
  });

  it.each([
    ['ordinary signed-in user', 'not_operator', USER_ID],
    ['revoked founder', 'revoked', USER_ID],
    ['forged session identity', 'enabled', OTHER_USER_ID],
  ] as const)('refuses %s based on current identity authority', async (_label, status, returnedUserId) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => entitlement(status, returnedUserId)),
    );
    await expect(assertCurrentFounder(session(), config())).rejects.toMatchObject({ code: 'admin.founder_required', status: 403 });
  });

  it('refuses unavailable, redirected, and malformed identity responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network or redirect refusal');
      }),
    );
    await expect(assertCurrentFounder(session(), config())).rejects.toMatchObject({ code: 'admin.upstream_unavailable', status: 503 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not-json', { status: 200 })),
    );
    await expect(assertCurrentFounder(session(), config())).rejects.toMatchObject({ code: 'admin.upstream_invalid', status: 502 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: { json: { status: 'enabled', userId: USER_ID } } } })),
    );
    await expect(assertCurrentFounder(session(), config())).rejects.toMatchObject({ code: 'admin.upstream_invalid', status: 502 });
  });

  it('authorizes only with current entitlement and forwards the session bearer, never a configured shared token', async () => {
    vi.stubEnv('ADMIN_SESSION_SECRET', Buffer.alloc(32, 7).toString('base64url'));
    vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
    vi.stubEnv('EDGE_URL', EDGE);
    vi.stubEnv('APP_ENV', 'prod');
    vi.stubEnv('ADMIN_OPERATOR_TOKEN', SHARED_TOKEN);
    const authNow = new Date();
    const current = session({ issuedAt: authNow.toISOString(), expiresAt: new Date(authNow.getTime() + 60 * 60_000).toISOString() });
    const token = sealFounderSession(current, config(), authNow);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${ACCESS}`);
      expect(headers.get('authorization')).not.toContain(SHARED_TOKEN);
      return entitlement('enabled');
    });
    vi.stubGlobal('fetch', fetchMock);
    const request = cookieRequest({ cookie: `${ADMIN_COOKIE}=${token}` });
    const authorized = await authorizeAdminRequest(request);
    expect(authorized.session.userId).toBe(USER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps upstream authorization failures to a refusal and rejects non-success status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    await expect(founderEdgeCall(config(), 'identity', 'accountControls.operatorStatus', 'GET', {}, ACCESS)).rejects.toMatchObject({
      code: 'admin.authority_refused',
      status: 403,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    await expect(founderEdgeCall(config(), 'identity', 'accountControls.operatorStatus', 'GET', {}, ACCESS)).rejects.toMatchObject({
      code: 'admin.upstream_refused',
      status: 503,
    });
  });

  it('keeps the service typed code on a refusal and sends it to the browser', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { json: { message: 'ops.crm.storage_unconfigured', code: -32603, data: { httpStatus: 412 } } } }),
            {
              status: 412,
            },
          ),
      ),
    );
    const refused = await founderEdgeCall(config(), 'ops', 'outreach.metrics', 'GET', {}, ACCESS).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'admin.upstream_refused', status: 412, upstream: 'ops.crm.storage_unconfigured' });
    expect(await adminSessionErrorResponse(refused).json()).toEqual({
      code: 'admin.upstream_refused',
      upstream: 'ops.crm.storage_unconfigured',
    });
  });

  it('keeps one device key per browser in a host-only cookie, and makes a new one when the cookie is missing or bent', () => {
    const fresh = adminDeviceKey(null);
    expect(fresh.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh.cookie).toBe(`${ADMIN_DEVICE_COOKIE}=${fresh.key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000`);
    const held = 'A'.repeat(40);
    expect(adminDeviceKey(`other=1; ${ADMIN_DEVICE_COOKIE}=${held}`).key).toBe(held);
    expect(adminDeviceKey(`${ADMIN_DEVICE_COOKIE}=short`).key).not.toBe('short');
    expect(adminDeviceKey(`${ADMIN_DEVICE_COOKIE}=${held}; ${ADMIN_DEVICE_COOKIE}=${'B'.repeat(40)}`).key).not.toMatch(/^(A+|B+)$/);
  });

  it('passes a waiting new-device sign-in to the browser only on its own refusal, field by field', async () => {
    const waiting = { flowId: USER_ID, secret: 's'.repeat(43), expiresAt: '2026-10-10T12:10:00.000Z', mailed: true };
    const body = {
      error: { json: { message: 'auth.device_authorisation_required', data: { deviceAuthorisation: { ...waiting, extra: 'x' } } } },
    };
    expect(deviceAuthorisationOf(body)).toEqual(waiting);
    expect(
      deviceAuthorisationOf({ error: { json: { message: 'auth.invalid_credentials', data: { deviceAuthorisation: waiting } } } }),
    ).toBeUndefined();
    expect(
      deviceAuthorisationOf({
        error: { json: { message: 'auth.device_authorisation_required', data: { deviceAuthorisation: { ...waiting, flowId: 'x' } } } },
      }),
    ).toBeUndefined();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const refused = await founderEdgeCall(config(), 'identity', 'auth.login', 'POST', {}, undefined, {
      userAgent: 'Founder Browser/1',
    }).catch((error: unknown) => error);
    expect(await adminSessionErrorResponse(refused).json()).toEqual({
      code: 'admin.authority_refused',
      upstream: 'auth.device_authorisation_required',
      deviceAuthorisation: waiting,
    });
    // The founder's own browser names the device identity trusts, not this server.
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'user-agent': 'Founder Browser/1' });
    // Any other call never carries a waiting sign-in to the page.
    const other = await founderEdgeCall(config(), 'ops', 'outreach.metrics', 'GET', {}, ACCESS).catch((error: unknown) => error);
    expect(await adminSessionErrorResponse(other).json()).toEqual({
      code: 'admin.authority_refused',
      upstream: 'auth.device_authorisation_required',
    });
  });

  it("reads identity's new-device refusal as the shared tRPC formatter sends it: prose message, code in data.cause", async () => {
    const waiting = { flowId: USER_ID, secret: 's'.repeat(43), expiresAt: '2026-10-10T12:10:00.000Z', mailed: true };
    const body = {
      error: {
        message: 'This device has not been used to sign in to this account before. Approve it to continue.',
        code: -32003,
        data: {
          code: 'FORBIDDEN',
          httpStatus: 403,
          path: 'auth.login',
          cause: { code: 'auth.device_authorisation_required' },
          deviceAuthorisation: waiting,
        },
      },
    };
    expect(upstreamCodeOf(body)).toBe('auth.device_authorisation_required');
    expect(deviceAuthorisationOf(body)).toEqual(waiting);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 403 })),
    );
    const refused = await founderEdgeCall(config(), 'identity', 'auth.login', 'POST', {}, undefined, { userAgent: null }).catch(
      (error: unknown) => error,
    );
    expect(await adminSessionErrorResponse(refused).json()).toEqual({
      code: 'admin.authority_refused',
      upstream: 'auth.device_authorisation_required',
      deviceAuthorisation: waiting,
    });
    // A wrong emailed code arrives the same way and is named, so the page can say so.
    expect(upstreamCodeOf({ error: { message: 'That code is not valid.', data: { cause: { code: 'auth.code_invalid' } } } })).toBe(
      'auth.code_invalid',
    );
    expect(upstreamCodeOf({ error: { message: 'x', data: { cause: { code: 'Free text here' } } } })).toBeNull();
  });

  it('never forwards free text from a service as a code', () => {
    expect(upstreamCodeOf({ error: { json: { message: 'Something went wrong for user 3faadae7' } } })).toBeNull();
    expect(upstreamCodeOf({ message: 'refused [ops.crm.revision_conflict] later' })).toBe('ops.crm.revision_conflict');
    expect(upstreamCodeOf(null)).toBeNull();
  });
});

describe('maintenance mode holds console writes', () => {
  const mode = (readOnly: boolean) =>
    Response.json({
      result: {
        data: {
          json: {
            readOnly,
            reason: readOnly ? 'Database maintenance window' : null,
            revision: readOnly ? 1 : 0,
            changedAt: readOnly ? NOW.toISOString() : null,
            requesterId: readOnly ? USER_ID : null,
            approverId: readOnly ? OTHER_USER_ID : null,
            asOf: NOW.toISOString(),
          },
        },
      },
    });

  function signedIn(path: string, method = 'POST'): Request {
    vi.stubEnv('ADMIN_SESSION_SECRET', config().key.toString('base64url'));
    vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
    vi.stubEnv('EDGE_URL', EDGE);
    const current = session({ issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    return cookieRequest({
      method,
      url: `${ORIGIN}${path}`,
      cookie: `${ADMIN_COOKIE}=${sealFounderSession(current, config())}`,
      origin: ORIGIN,
      csrf: current.csrf,
    });
  }

  function upstream(answer: () => Response | Promise<Response>) {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('consoleMode.get') ? answer() : entitlement('enabled'),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('refuses a write with ops.console_read_only while the mode is on, reading it as the founder', async () => {
    const fetchMock = upstream(() => mode(true));
    await expect(authorizeAdminRequest(signedIn('/api/crm'))).rejects.toMatchObject({ code: 'ops.console_read_only', status: 423 });
    const read = fetchMock.mock.calls.find(([url]) => String(url).includes('consoleMode.get'));
    expect(String(read?.[0])).toBe(`${EDGE}/api/ops/trpc/consoleMode.get`);
    expect(new Headers((read as unknown as [string, RequestInit])[1].headers).get('authorization')).toBe(`Bearer ${ACCESS}`);
  });

  it('lets a write through while the mode is off, and never reads the mode for a read', async () => {
    const fetchMock = upstream(() => mode(false));
    await expect(authorizeAdminRequest(signedIn('/api/crm'))).resolves.toMatchObject({ session: { userId: USER_ID } });
    fetchMock.mockClear();
    await expect(authorizeAdminRequest(signedIn('/api/crm', 'GET'))).resolves.toMatchObject({ session: { userId: USER_ID } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('consoleMode.get'))).toBe(false);
  });

  it.each(['/api/console-mode', '/api/ledger-freeze', '/api/kill-switch', '/api/pay-halts', '/api/trade-ops/kill-switch', '/api/accounts'])(
    'keeps %s open while the mode is on, without reading it',
    async (path) => {
      const fetchMock = upstream(() => mode(true));
      await expect(authorizeAdminRequest(signedIn(path))).resolves.toMatchObject({ session: { userId: USER_ID } });
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('consoleMode.get'))).toBe(false);
    },
  );

  it('does not treat a look-alike path, or an account closure, as an exempt door', async () => {
    upstream(() => mode(true));
    for (const path of ['/api/console-mode-other', '/api/accounts/closure', '/api/accounts/tier'])
      await expect(authorizeAdminRequest(signedIn(path))).rejects.toMatchObject({ code: 'ops.console_read_only' });
  });

  it('a refused founder never reaches svc-ops', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('consoleMode.get') ? mode(true) : entitlement('revoked'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(authorizeAdminRequest(signedIn('/api/crm'))).rejects.toMatchObject({ code: 'admin.founder_required' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('consoleMode.get'))).toBe(false);
  });

  it.each([
    ['svc-ops does not answer', () => Promise.reject(new Error('connect ECONNREFUSED'))],
    ['svc-ops has no storage', () => Response.json({ error: { message: 'ops.console_mode_storage_unconfigured' } }, { status: 412 })],
    ['svc-ops answers a shape this console does not understand', () => Response.json({ result: { data: { json: { readOnly: 'yes' } } } })],
  ] as const)('fails open when %s: the write is not held', async (_why, answer) => {
    upstream(answer);
    await expect(authorizeAdminRequest(signedIn('/api/crm'))).resolves.toMatchObject({ session: { userId: USER_ID } });
  });
});
