import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as warehouseGet, POST as warehousePost } from './analytics/warehouse/route.js';
import { GET as killSwitchGet, POST as killSwitchPost } from './kill-switch/route.js';
import { GET as ledgerFreezeGet, POST as ledgerFreezePost } from './ledger-freeze/route.js';
import { GET as operatorToolsGet, POST as operatorToolsPost } from './operator-tools/route.js';
import { ADMIN_COOKIE, founderCookie, sealFounderSession, type FounderSession } from '../../lib/founder-session.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const SECRET = KEY.toString('base64url');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();

const routes = [
  ['GET /api/analytics/warehouse', warehouseGet, 'GET'],
  ['POST /api/analytics/warehouse', warehousePost, 'POST'],
  ['GET /api/kill-switch', killSwitchGet, 'GET'],
  ['POST /api/kill-switch', killSwitchPost, 'POST'],
  ['GET /api/ledger-freeze', ledgerFreezeGet, 'GET'],
  ['POST /api/ledger-freeze', ledgerFreezePost, 'POST'],
  ['GET /api/operator-tools', operatorToolsGet, 'GET'],
  ['POST /api/operator-tools', operatorToolsPost, 'POST'],
] as const;

function configure() {
  vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
  vi.stubEnv('EDGE_URL', EDGE);
  vi.stubEnv('ADMIN_SESSION_SECRET', SECRET);
  vi.stubEnv('APP_ENV', 'test');
}

function sessionCookie() {
  const session: FounderSession = {
    userId: USER_ID,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    csrf: Buffer.alloc(32, 5).toString('base64url'),
  };
  const sealed = sealFounderSession(session, { origin: ORIGIN, edgeUrl: EDGE, key: KEY }, NOW);
  return { cookie: founderCookie(sealed, 3600).split(';')[0]!, csrf: session.csrf };
}

function request(method: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/proof`, {
    method,
    headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    body: method === 'POST' ? '{}' : undefined,
  });
}

function entitlement(status: 'enabled' | 'revoked' | 'not_operator') {
  const data =
    status === 'not_operator' ? { status, userId: USER_ID } : { status, userId: USER_ID, version: '1', changedAt: NOW.toISOString() };
  return Response.json({ result: { data: { json: data } } });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('real founder authorization on every legacy admin BFF route', () => {
  it.each(routes)('%s refuses missing session configuration', async (_name, handler, method) => {
    delete process.env.ADMIN_ORIGIN;
    const response = await handler(request(method));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'admin.session_unconfigured' });
  });

  it.each(routes)('%s never treats a shared proxy header alone as a login', async (_name, handler, method) => {
    configure();
    const response = await handler(
      request(method, {
        'x-intafaced-admin-bff': 'former-shared-secret',
        ...(method === 'POST' ? { origin: ORIGIN } : {}),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'admin.session_required' });
  });

  it.each(routes)('%s rejects an invalid founder cookie', async (_name, handler, method) => {
    configure();
    const response = await handler(
      request(method, {
        cookie: `${ADMIN_COOKIE}=forged`,
        ...(method === 'POST' ? { origin: ORIGIN } : {}),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'admin.session_required' });
  });

  it.each(routes.filter((row) => row[2] === 'POST'))('%s requires same-origin request and CSRF token', async (_name, handler) => {
    configure();
    const { cookie, csrf } = sessionCookie();
    const badOrigin = await handler(request('POST', { cookie, origin: 'https://evil.example', 'x-intafaced-csrf': csrf }));
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toMatchObject({ code: 'admin.session_origin' });
    const missingCsrf = await handler(request('POST', { cookie, origin: ORIGIN }));
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.json()).toMatchObject({ code: 'admin.session_csrf' });
  });

  it.each(['not_operator', 'revoked'] as const)('refuses current entitlement %s across every route', async (status) => {
    configure();
    const { cookie, csrf } = sessionCookie();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => entitlement(status)),
    );
    for (const [_name, handler, method] of routes) {
      const headers: Record<string, string> = { cookie };
      if (method === 'POST') {
        headers.origin = ORIGIN;
        headers['x-intafaced-csrf'] = csrf;
      }
      const response = await handler(request(method, headers));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'admin.founder_required' });
    }
  });
});
