import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLimiter } from '@/lib/rate-limit';
import { POST } from './route';

const original = { ...process.env };
const good = { identifier: 'founder@example.invalid', totpCode: '123456', recoveryCode: 'ABCDE-12345', newPassword: 'a-new-password-1' };
const ok = (data: unknown) => Response.json({ result: { data } });
const refused = (status: number, intafacedCode: string) =>
  Response.json({ error: { message: 'x', code: 'BAD_REQUEST', data: { httpStatus: status, intafacedCode } } }, { status });
const post = (input: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('https://admin.example/api/reset', {
      method: 'POST',
      headers: { origin: 'https://admin.example', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(input),
    }),
  );

beforeEach(() => {
  resetLimiter.reset();
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
    // No upstream code is passed on: the page needs only to be told to wait.
    expect(await result.json()).toEqual({ code: 'admin.reset_rate_limited' });
  });
  it('sends the recovery code upper-cased, because identity matches it exactly', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    expect((await post({ ...good, recoveryCode: 'abcde-1f2e3' })).status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).recoveryCode).toBe('ABCDE-1F2E3');
  });
  it('limits each client to 10 attempts in 15 minutes, and answers 429 admin.rate_limited without calling identity', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => refused(400, 'auth.reset_refused'));
    vi.stubGlobal('fetch', fetcher);
    process.env.ADMIN_TRUST_PROXY = '1';
    const client = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 10; i += 1) expect((await post(good, client)).status).toBe(400);
    const blocked = await post(good, client);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ code: 'admin.rate_limited' });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it('counts bad input against the limit too', async () => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.ADMIN_TRUST_PROXY = '1';
    const client = { 'x-forwarded-for': '203.0.113.8' };
    for (let i = 0; i < 10; i += 1) expect((await post({ nope: 1 }, client)).status).toBe(400);
    expect((await post({ nope: 1 }, client)).status).toBe(429);
  });
  it('does not limit unless ADMIN_TRUST_PROXY=1 (no shared bucket to lock founders out), then counts by the first x-forwarded-for entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refused(400, 'auth.reset_refused')),
    );
    for (let i = 0; i < 15; i += 1) expect((await post(good, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(400);
    resetLimiter.reset();
    process.env.ADMIN_TRUST_PROXY = '1';
    for (let i = 0; i < 10; i += 1) await post(good, { 'x-forwarded-for': '203.0.113.1, 10.0.0.2' });
    expect((await post(good, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429);
    expect((await post(good, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(400);
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
