import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as crmGet, POST as crmPost } from './crm/route';
import { GET as accountsGet, POST as accountsPost } from './accounts/route';
import { GET as sessionGet, POST as login, DELETE as logout } from './session/route';
import { adminSessionConfig, ADMIN_COOKIE, openFounderSession, sealFounderSession, type FounderSession } from '@/lib/founder-session';

const userId = randomUUID();
const targetId = randomUUID();
const original = { ...process.env };
const now = new Date();
const session: FounderSession = {
  userId,
  accessToken: 'individual-access-token',
  refreshToken: 'individual-refresh-token',
  expiresAt: new Date(now.getTime() + 600000).toISOString(),
  issuedAt: now.toISOString(),
  csrf: randomBytes(32).toString('base64url'),
};
const enabled = { status: 'enabled', userId, version: '1', changedAt: now.toISOString() };
const response = (data: unknown) => Response.json({ result: { data } });
function request(path: string, method = 'GET', input?: unknown) {
  return new Request(`https://admin.example${path}`, {
    method,
    headers: {
      cookie: `${ADMIN_COOKIE}=${sealFounderSession(session, adminSessionConfig())}`,
      ...(method !== 'GET'
        ? { origin: 'https://admin.example', 'x-intafaced-csrf': session.csrf, 'content-type': 'application/json' }
        : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
beforeEach(() => {
  process.env.ADMIN_ORIGIN = 'https://admin.example';
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_SESSION_SECRET = randomBytes(32).toString('base64url');
  process.env.ADMIN_OPERATOR_TOKEN = 'shared-token-must-not-be-used';
});
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('founder BFF transport', () => {
  it('every new private route refuses a proxy credential before upstream access', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const [path, method, handler] of [
      ['/api/crm?limit=50', 'GET', crmGet],
      ['/api/crm', 'POST', crmPost],
      ['/api/accounts?area=identity&id=' + targetId, 'GET', accountsGet],
      ['/api/accounts', 'POST', accountsPost],
      ['/api/session', 'GET', sessionGet],
    ] as const) {
      const result = await handler(
        new Request(`https://admin.example${path}`, {
          method,
          headers: { 'x-intafaced-admin-bff': 'old-shared-proxy-secret', origin: 'https://admin.example' },
        }),
      );
      expect(result.status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('login encrypts session credentials and returns only the founder identity and CSRF token', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ userId, accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt }),
      )
      .mockResolvedValueOnce(response(enabled));
    vi.stubGlobal('fetch', fetcher);
    const result = await login(
      new Request('https://admin.example/api/session', {
        method: 'POST',
        headers: { origin: 'https://admin.example', 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: 'founder', password: 'test-password', totpCode: '123456' }),
      }),
    );
    expect(result.status).toBe(200);
    const body = JSON.stringify(await result.json());
    expect(body).not.toContain(session.accessToken);
    expect(body).not.toContain(session.refreshToken);
    const cookie = result.headers.get('set-cookie')!;
    expect(openFounderSession(cookie.split(';')[0]!, adminSessionConfig()).accessToken).toBe(session.accessToken);
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
  });
  it('account commands bind real actor transport and refuse a well-formed receipt for a different target', async () => {
    const input = {
      requestId: randomUUID(),
      target: { area: 'identity', userId: targetId },
      action: 'restrict',
      reason: 'Incident reviewed',
      expectedVersion: '0',
    };
    const receipt = {
      requestId: input.requestId,
      target: input.target,
      action: input.action,
      reason: input.reason,
      auditId: randomUUID(),
      actorUserId: userId,
      outcome: 'changed',
      changed: true,
      occurredAt: now.toISOString(),
      before: { target: input.target, restricted: false, version: '0' },
      after: { target: input.target, restricted: true, version: '1' },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(enabled)).mockResolvedValueOnce(response(receipt));
    vi.stubGlobal('fetch', fetcher);
    expect((await accountsPost(request('/api/accounts', 'POST', input))).status).toBe(200);
    expect(fetcher.mock.calls[1]![1]?.body).toBe(JSON.stringify(input));
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization')).toBe(`Bearer ${session.accessToken}`);
    const wrong = { area: 'identity', userId: randomUUID() };
    fetcher
      .mockResolvedValueOnce(response(enabled))
      .mockResolvedValueOnce(
        response({ ...receipt, target: wrong, before: { ...receipt.before, target: wrong }, after: { ...receipt.after, target: wrong } }),
      );
    expect((await accountsPost(request('/api/accounts', 'POST', input))).status).toBe(502);
  });
  it('a revoked founder can still revoke their own session and clear the cookie', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const result = await logout(request('/api/session', 'DELETE'));
    expect(result.status).toBe(200);
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(fetcher.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/auth.logout');
  });
  it('mutation CSRF failure leaves both identity authority and the owning service untouched', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const incoming = request('/api/crm', 'POST', {
      action: 'addNote',
      input: { opportunityId: targetId, note: 'Private note', requestId: randomUUID() },
    });
    incoming.headers.delete('x-intafaced-csrf');
    expect((await crmPost(incoming)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
