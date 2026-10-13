import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminBffGate } from './admin-bff-gate.js';
import { ADMIN_COOKIE, founderCookie, sealFounderSession, type FounderSession } from './founder-session.js';

const ORIGIN = 'https://admin.example';
const SECRET = Buffer.alloc(32, 6).toString('base64url');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();

function setup(status: 'enabled' | 'revoked' | 'not_operator' = 'enabled', statusUserId = USER_ID) {
  vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
  vi.stubEnv('EDGE_URL', 'http://edge:4000');
  vi.stubEnv('ADMIN_SESSION_SECRET', SECRET);
  vi.stubEnv('APP_ENV', 'test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const data =
        status === 'not_operator'
          ? { status, userId: statusUserId }
          : { status, userId: statusUserId, version: '1', changedAt: NOW.toISOString() };
      return Response.json({ result: { data: { json: data } } });
    }),
  );
}

function signedInCookie(userId = USER_ID): string {
  const session: FounderSession = {
    userId,
    accessToken: 'user-access-token',
    refreshToken: 'refresh-token',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    csrf: Buffer.alloc(32, 9).toString('base64url'),
  };
  const token = sealFounderSession(session, { origin: ORIGIN, edgeUrl: 'http://edge:4000', key: Buffer.from(SECRET, 'base64url') }, NOW);
  return founderCookie(token, 3600).split(';')[0]!;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('adminBffGate', () => {
  it('fails closed when founder-session configuration is absent or blank', async () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.ADMIN_ORIGIN;
      else vi.stubEnv('ADMIN_ORIGIN', value);
      const response = await adminBffGate(new Request(`${ORIGIN}/api/ops`));
      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ code: 'admin.session_unconfigured' });
    }
  });

  it('does not treat the old shared proxy header as authentication and rejects missing or invalid cookies', async () => {
    setup();
    for (const cookie of [undefined, `${ADMIN_COOKIE}=not-a-sealed-session`]) {
      const response = await adminBffGate(
        new Request(`${ORIGIN}/api/ops`, {
          headers: { 'x-intafaced-admin-bff': 'former-shared-secret', ...(cookie ? { cookie } : {}) },
        }),
      );
      expect(response?.status).toBe(401);
      expect(await response?.json()).toMatchObject({ code: 'admin.session_required' });
    }
  });

  it('allows only a same-origin current founder session', async () => {
    setup();
    const response = await adminBffGate(new Request(`${ORIGIN}/api/ops`, { headers: { cookie: signedInCookie() } }));
    expect(response).toBeNull();
  });

  it.each([
    ['evil origin', { origin: 'https://evil.example' }],
    ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }],
  ])('refuses a browser cross-origin mutation (%s)', async (_label, extraHeaders) => {
    setup();
    const csrf = Buffer.alloc(32, 9).toString('base64url');
    const response = await adminBffGate(
      new Request(`${ORIGIN}/api/ops`, {
        method: 'POST',
        headers: { cookie: signedInCookie(), 'x-intafaced-csrf': csrf, ...extraHeaders },
      }),
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ code: 'admin.session_origin' });
  });

  it('requires same-origin Origin and a matching CSRF token for mutation requests', async () => {
    setup();
    const cookie = signedInCookie();
    const cases: [Headers, string][] = [
      [new Headers({ cookie, 'x-intafaced-csrf': Buffer.alloc(32, 9).toString('base64url') }), 'admin.session_origin'],
      [new Headers({ cookie, origin: ORIGIN, 'x-intafaced-csrf': 'wrong' }), 'admin.session_csrf'],
    ];
    for (const [headers, expectedCode] of cases) {
      const response = await adminBffGate(new Request(`${ORIGIN}/api/ops`, { method: 'POST', headers }));
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ code: expectedCode });
    }
  });

  it.each([
    ['ordinary user', 'not_operator', USER_ID],
    ['revoked founder', 'revoked', USER_ID],
  ] as const)('refuses %s even with a valid signed cookie', async (_label, status, userId) => {
    setup(status, userId);
    const response = await adminBffGate(new Request(`${ORIGIN}/api/ops`, { headers: { cookie: signedInCookie() } }));
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ code: 'admin.founder_required' });
  });
});
