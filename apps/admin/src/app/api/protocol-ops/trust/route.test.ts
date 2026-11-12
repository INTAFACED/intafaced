import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

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
const REPORT = '00000000-0000-4000-8000-000000000001';
const REVIEW = '00000000-0000-4000-9000-000000000001';
const review = {
  id: REVIEW,
  kind: 'phishing',
  reason: 'TEST',
  status: 'pending',
  requesterId: ctx.session.userId,
  approverId: null,
  askedAt: '2026-11-12T00:00:00.000Z',
  decidedAt: null,
};
const post = (body: unknown) =>
  new Request('http://admin.example/api/protocol-ops/trust', {
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

describe('POST /api/protocol-ops/trust', () => {
  it('asks svc-protocol for a label as the signed-in founder', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ result: { data: review } }));
    vi.stubGlobal('fetch', fn);
    const res = await POST(post({ op: 'ask', reportId: REPORT, kind: 'phishing', reason: ' TEST ' }));
    expect(await res.json()).toEqual({ ok: true, review });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/protocol/trpc/compliance.labels.ask');
    expect(JSON.parse(String(init!.body))).toEqual({ reportId: REPORT, kind: 'phishing', reason: 'TEST' });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('sends nothing for a request svc-protocol would refuse anyway', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const body of [
      {},
      { op: 'ask', reportId: 'x', kind: 'phishing', reason: 'TEST' },
      { op: 'ask', reportId: REPORT, kind: 'verdict', reason: 'TEST' },
      { op: 'ask', reportId: REPORT, kind: 'phishing', reason: '  ' },
      { op: 'approve', reviewId: 1 },
      { op: 'delete', reviewId: REVIEW },
    ]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('says in words that the person who asked cannot approve, and that a lost reply is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(409, 'protocol.compliance.same_reviewer')),
    );
    const refused = await POST(post({ op: 'approve', reviewId: REVIEW }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, message: expect.stringMatching(/different person/) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    );
    const lost = await POST(post({ op: 'approve', reviewId: REVIEW }));
    expect(await lost.json()).toMatchObject({ ok: false, unknown: true });
  });
});

describe('GET /api/protocol-ops/trust', () => {
  it('names each read that failed and shows no rows for it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('compliance.reports.list')
          ? Response.json({ result: { data: { asOf: '2026-11-12T00:00:00.000Z', chainId: 84532, reports: [] } } })
          : new Response('', { status: 503 }),
      ),
    );
    const body = await (await GET(new Request('http://admin.example/api/protocol-ops/trust'))).json();
    expect(body.reports).toEqual({ ok: true, data: { asOf: '2026-11-12T00:00:00.000Z', chainId: 84532, reports: [] } });
    expect(body.tokens).toMatchObject({ ok: false, message: expect.stringMatching(/token list/) });
    expect(body.audit).toMatchObject({ ok: false, message: expect.stringMatching(/audit rows/) });
  });
});
