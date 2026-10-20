import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const ctx = {
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
const post = (body: unknown) =>
  new Request('http://admin.example/api/protocol-ops/reason-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const trpcErr = (status: number, code: string) =>
  Response.json({ error: { message: code, code: -32603, data: { code: 'X', httpStatus: status, cause: { code } } } }, { status });

beforeEach(() => gate.session.mockResolvedValue(ctx));
afterEach(() => {
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('POST /api/protocol-ops/reason-codes', () => {
  it('sends the whole new list to svc-ops as the signed-in admin', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ result: { data: { source: 'admin' } } }));
    vi.stubGlobal('fetch', fn);
    const res = await POST(post({ codes: ['scam_or_fraud', 'owner_request'] }));
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/ops/trpc/protocolListing.reasonCodes.set');
    expect(JSON.parse(String(init!.body))).toEqual({ codes: ['scam_or_fraud', 'owner_request'] });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('sends nothing for a list svc-ops would refuse anyway', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const body of [{}, { codes: [] }, { codes: ['a_code', 'a_code'] }, { codes: ['Bad Code'] }, { codes: [1] }]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, code: 'admin.request_invalid' });
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('says in words that an edit with no storage changed nothing, and that a lost reply is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(412, 'ops.protocol_listing_storage_unconfigured')),
    );
    const refused = await POST(post({ codes: ['a_code'] }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, message: expect.stringContaining('Nothing was changed') });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket hang up'))),
    );
    const lost = await POST(post({ codes: ['a_code'] }));
    expect(await lost.json()).toMatchObject({ ok: false, unknown: true });
  });
});
