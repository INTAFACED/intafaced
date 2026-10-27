import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSessionError } from '@/lib/founder-session';
import { GET } from './route';

const auth = vi.hoisted(() => ({ authorize: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/founder-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/founder-session')>()),
  authorizeAdminRequest: auth.authorize,
}));

const TX = '33333333-3333-4333-8333-333333333333';
const KEY = 'deposit:local-test:LOCAL-TEST-abcd';
const ctx = {
  session: { userId: '11111111-1111-4111-8111-111111111111', accessToken: 'founder-access-token' },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
// TEST amounts only.
const tx = {
  txId: TX,
  businessKey: KEY,
  module: 'deposit',
  reason: 'deposit',
  postedAt: '2026-10-23T04:00:00.000Z',
  hash: 'h1',
  previousHash: null,
  booking: { seq: '1', bookedAt: '2026-10-23T04:00:00.010Z', reference: TX, event: null },
  postings: [
    {
      entryId: 'e1',
      accountId: 'a1',
      assetId: 'USDT',
      direction: 'credit',
      side: 'source',
      amount: '25',
      balanceBefore: '50',
      balanceAfter: '25',
    },
  ],
};
const get = (query: string) => GET(new Request(`https://admin.example/api/ledger-lookup?${query}`));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  auth.authorize.mockResolvedValue(ctx);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  auth.authorize.mockReset();
});

describe('GET /api/ledger-lookup', () => {
  it("reads one transaction through edge's named route with the founder's own token", async () => {
    fetchMock.mockResolvedValue(Response.json(tx));
    const res = await get(`txId=${TX}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: true, transaction: tx });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://edge:4000/admin/ledger/transactions/${TX}`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(init.redirect).toBe('error');
  });

  it('traces a business key, encoded into the one trace route, and says when nothing was booked', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ found: true, ...tx }));
    expect(await (await get(`businessKey=${encodeURIComponent(KEY)}`)).json()).toEqual({ found: true, transaction: tx });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://edge:4000/admin/ledger/trace?businessKey=${encodeURIComponent(KEY)}`);
    fetchMock.mockResolvedValueOnce(Response.json({ found: false, businessKey: 'never' }));
    expect(await (await get('businessKey=never')).json()).toEqual({ found: false, businessKey: 'never' });
  });

  it("passes svc-ledger's and edge's refusals through with their own code", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ message: 'No transaction has that id.', code: 'ledger.tx_not_found' }, { status: 404 }),
    );
    const notFound = await get(`txId=${TX}`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ code: 'ledger.tx_not_found' });
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'two-factor', code: 'mfa.required' }, { status: 401 }));
    const mfa = await get(`txId=${TX}`);
    expect(mfa.status).toBe(401);
    expect(await mfa.json()).toEqual({ code: 'mfa.required' });
  });

  it('refuses a malformed or extra query without calling edge', async () => {
    for (const query of ['txId=nope', 'businessKey=', '', `txId=${TX}&businessKey=k`, 'other=1'])
      expect((await get(query)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an answer that is not the transaction asked for, and a dropped connection, showing nothing', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...tx, txId: '44444444-4444-4444-8444-444444444444' }));
    const other = await get(`txId=${TX}`);
    expect(other.status).toBe(502);
    expect(await other.json()).toEqual({ code: 'admin.upstream_invalid' });
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    const dropped = await get(`txId=${TX}`);
    expect(dropped.status).toBe(503);
    expect(await dropped.json()).toEqual({ code: 'admin.upstream_unavailable' });
  });

  it('says unavailable, not a bad shape, when the body stops arriving', async () => {
    const stalled = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
        },
      }),
      { status: 200 },
    );
    fetchMock.mockResolvedValueOnce(stalled);
    const res = await get(`txId=${TX}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'admin.upstream_unavailable' });
  });

  it('refuses before reading when the founder session is refused', async () => {
    auth.authorize.mockRejectedValue(new AdminSessionError('admin.session_required', 401));
    expect((await get(`txId=${TX}`)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
