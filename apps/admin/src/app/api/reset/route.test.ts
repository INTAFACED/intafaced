import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const original = { ...process.env };
const good = { identifier: 'founder@example.invalid', totpCode: '123456', recoveryCode: 'ABCDE-12345', newPassword: 'a-new-password-1' };
const ok = (data: unknown) => Response.json({ result: { data } });
const refused = (status: number, intafacedCode: string) => Response.json({ error: { json: { data: { intafacedCode } } } }, { status });
const post = (input: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('https://admin.example/api/reset', {
      method: 'POST',
      headers: { origin: 'https://admin.example', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(input),
    }),
  );

beforeEach(() => {
  process.env.ADMIN_ORIGIN = 'https://admin.example';
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_SESSION_SECRET = randomBytes(32).toString('base64url');
});
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
});

describe('POST /api/reset (public)', () => {
  it('resets the password with no session, no token and no cookie', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const result = await post(good);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(await result.json()).toEqual({ reset: true });
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://edge:4000/api/identity/trpc/auth.resetPassword');
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBeNull();
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual(good);
  });
  it('gives one uniform refusal whatever identity says, so it is no account oracle', async () => {
    const seen = new Set<string>();
    for (const [status, code] of [
      [400, 'auth.reset_refused'],
      [401, 'auth.invalid_credentials'],
      [404, 'auth.user_not_found'],
      [403, 'auth.mfa_required'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(refused(status, code)));
      const result = await post(good);
      expect(result.status).toBe(400);
      seen.add(JSON.stringify(await result.json()));
    }
    expect([...seen]).toEqual(['{"code":"admin.reset_refused"}']);
  });
  it('says to wait when identity has counted the caller out', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(refused(429, 'auth.too_many_attempts')));
    const result = await post(good);
    expect(result.status).toBe(429);
    expect(await result.json()).toEqual({ code: 'admin.reset_rate_limited', upstreamCode: 'auth.too_many_attempts' });
  });
  it.each([
    ['no identifier', { ...good, identifier: ' ' }],
    ['a long identifier', { ...good, identifier: 'a'.repeat(255) }],
    ['a short code', { ...good, totpCode: '12345' }],
    ['a recovery code in the code field', { ...good, totpCode: 'ABCDE-12345' }],
    ['a bad recovery code', { ...good, recoveryCode: 'ABCDE12345' }],
    ['a code instead of a recovery code', { ...good, recoveryCode: '123456' }],
    ['a short password', { ...good, newPassword: 'short' }],
    ['a huge password', { ...good, newPassword: 'a'.repeat(201) }],
    ['an unknown key', { ...good, extra: 1 }],
    ['a missing field', { identifier: good.identifier }],
  ])('refuses %s without calling identity', async (_name, input) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await post(input);
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ code: 'admin.reset_refused' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks the origin', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await post(good, { origin: 'https://evil.example' })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('is uniform when the body is not JSON', async () => {
    const result = await POST(
      new Request('https://admin.example/api/reset', {
        method: 'POST',
        headers: { origin: 'https://admin.example', 'content-type': 'text/plain' },
        body: 'x',
      }),
    );
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ code: 'admin.reset_refused' });
  });
});
