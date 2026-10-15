import { afterEach, describe, expect, it, vi } from 'vitest';
import { payCall, type PayCallContext } from './pay-call';

const ctx: PayCallContext = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const identity = (x: unknown) => x as { n: number } | null;

afterEach(() => vi.unstubAllGlobals());
const stub = (res: Response | Error) => {
  const fn = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
};
const trpcError = (status: number, message: string, code: string, cause?: string) =>
  Response.json(
    { error: { message, code: -32603, data: { code, httpStatus: status, ...(cause ? { cause: { code: cause } } : {}) } } },
    { status, headers: { 'x-request-id': 'req-1' } },
  );

describe('payCall', () => {
  it('sends the founder Bearer token to the right path and never caches', async () => {
    const fn = stub(Response.json({ result: { data: { n: 1 } } }));
    const r = await payCall(ctx, 'founderAdmin.metrics.global', 'GET', { window: { kind: 'preset', preset: 'today' } }, identity);
    expect(r).toEqual({ kind: 'ok', data: { n: 1 } });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `http://edge:4000/api/pay/trpc/founderAdmin.metrics.global?input=${encodeURIComponent('{"window":{"kind":"preset","preset":"today"}}')}`,
    );
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
  });

  it('unwraps the superjson-style json envelope', async () => {
    stub(Response.json({ result: { data: { json: { n: 2 } } } }));
    expect(await payCall(ctx, 'p', 'GET', {}, identity)).toEqual({ kind: 'ok', data: { n: 2 } });
  });

  it('posts the body for a mutation and can target identity', async () => {
    const fn = stub(Response.json({ result: { data: { n: 3 } } }));
    await payCall(ctx, 'actionApproval.propose', 'POST', { a: 1 }, identity, 'identity');
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://edge:4000/api/identity/trpc/actionApproval.propose');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
  });

  it('names a stubbed procedure as not_built, never as an error or an empty list', async () => {
    stub(trpcError(501, 'pay.not_built: founderAdmin.treasury.exposure is not built yet', 'NOT_IMPLEMENTED', 'pay.not_built'));
    expect(await payCall(ctx, 'founderAdmin.treasury.exposure', 'GET', {}, identity)).toEqual({
      kind: 'not_built',
      procedure: 'founderAdmin.treasury.exposure',
      requestId: 'req-1',
    });
  });

  it('treats a procedure the edge does not know as not built', async () => {
    stub(trpcError(404, 'No procedure found on path "founderAdmin.registries.venues.list"', 'NOT_FOUND'));
    expect((await payCall(ctx, 'x', 'GET', {}, identity)).kind).toBe('not_built');
  });

  it('maps an unknown merchant to not_found, whatever its status', async () => {
    stub(trpcError(404, 'x', 'NOT_FOUND', 'pay.merchant_not_found'));
    expect((await payCall(ctx, 'x', 'GET', {}, identity)).kind).toBe('not_found');
  });

  it('a bare 401/403 is the founder gate; a typed refusal on a 403 is explained', async () => {
    stub(trpcError(403, 'operator.denied', 'FORBIDDEN', 'operator.denied'));
    expect((await payCall(ctx, 'x', 'GET', {}, identity)).kind).toBe('forbidden');
    stub(trpcError(401, 'nope', 'UNAUTHORIZED'));
    expect((await payCall(ctx, 'x', 'GET', {}, identity)).kind).toBe('forbidden');
    stub(trpcError(403, 'registries.live_mode_refused: live', 'FORBIDDEN', 'registries.live_mode_refused'));
    expect(await payCall(ctx, 'x', 'POST', {}, identity)).toMatchObject({
      kind: 'refused',
      refusal: { code: 'registries.live_mode_refused', status: 403 },
    });
  });

  it('a typed 409 is a refusal; an untyped 5xx and a network failure are unavailable', async () => {
    stub(trpcError(409, 'changed', 'CONFLICT', 'registries.version_conflict'));
    expect(await payCall(ctx, 'x', 'POST', {}, identity)).toMatchObject({
      kind: 'refused',
      refusal: { code: 'registries.version_conflict' },
    });
    stub(trpcError(500, 'boom', 'INTERNAL_SERVER_ERROR'));
    expect((await payCall(ctx, 'x', 'GET', {}, identity)).kind).toBe('unavailable');
    stub(new Error('connect ECONNREFUSED'));
    expect((await payCall(ctx, 'x', 'GET', {}, identity)).kind).toBe('unavailable');
  });

  it('an answer that does not match the contract is invalid, and nothing is shown', async () => {
    stub(Response.json({ result: { data: { wrong: true } } }));
    expect((await payCall(ctx, 'x', 'GET', {}, () => null)).kind).toBe('invalid');
    stub(Response.json({ hello: 'world' }));
    expect((await payCall(ctx, 'x', 'GET', {}, identity)).kind).toBe('invalid');
  });
});
