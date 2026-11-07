import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as customer from './bank-ops/customer/route';

/**
 * The finance-treasury customer lookup through its BFF: which svc-bank procedures it calls and with what input, that it is read only on
 * request and only from this console's own page, and that a refusal or a drifting answer is a failed part, never a figure.
 */

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
const CUSTOMER = '5a3b9c10-1111-4222-8333-444455556666';
const ok = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string, code?: string) =>
  Response.json(
    { error: { message, code: -32603, data: { code: 'X', httpStatus: status, ...(code ? { cause: { code } } : {}) } } },
    { status },
  );
const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://admin.example${path}`, { headers });

const BALANCES = {
  userId: CUSTOMER,
  assets: [{ assetId: 'USDT', total: '100', available: '70', hold: '30', escrow: '0', stake: '0', collateral: '0' }],
};
const ENTRIES = {
  assetId: 'USDT',
  entries: [
    {
      entryId: '2',
      txId: 'tx-2',
      accountId: 'acc-1',
      reason: 'deposit',
      direction: 'debit',
      amount: '70',
      postedAt: '2026-10-02T00:00:00.000Z',
    },
  ],
  nextCursor: '1',
  sumCheck: { ok: true, entriesSum: '70', balance: '70', entryCount: 2 },
};

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  delete process.env.ADMIN_MODULES;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
  delete process.env.ADMIN_MODULES;
});

describe('GET /api/bank-ops/customer', () => {
  it('has no way to change anything', () => {
    expect(Object.keys(customer).filter((k) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
  });

  it('reads the balances through ops.customerBalances as the founder, with the customer id and nothing else', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(BALANCES));
    vi.stubGlobal('fetch', fn);
    const json = await (await customer.GET(get(`/api/bank-ops/customer?user=${CUSTOMER}`))).json();
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(url.startsWith('http://edge:4000/api/bank/trpc/ops.customerBalances?input=')).toBe(true);
    expect(JSON.parse(new URL(url).searchParams.get('input')!)).toEqual({ userId: CUSTOMER });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(json.part).toMatchObject({ kind: 'ok', data: { shape: 'list' } });
    expect(json.part.data.rows[0].cells.map((c: { value: unknown }) => c.value)).toEqual(['USDT', '100', '70', '30', '0', '0', '0']);
  });

  it('reads one page of entries and the sum check from ONE call to ops.customerBalanceEntries', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(ENTRIES));
    vi.stubGlobal('fetch', fn);
    const json = await (await customer.GET(get(`/api/bank-ops/customer?user=${CUSTOMER}&asset=USDT&cursor=1`))).json();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(new URL(fn.mock.calls[0]![0]).searchParams.get('input')!)).toEqual({
      userId: CUSTOMER,
      assetId: 'USDT',
      cursor: '1',
    });
    expect(json.entries.part).toMatchObject({ kind: 'ok', data: { shape: 'list', nextCursor: '1' } });
    expect(json.check.part).toMatchObject({ kind: 'ok', data: { shape: 'record' } });
    expect(json.check.part.data.cells.map((c: { value: unknown }) => c.value)).toEqual([true, '70', '70', 2]);
  });

  it('a sum check that is not true makes the whole read invalid, not a figure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ ...ENTRIES, sumCheck: { ...ENTRIES.sumCheck, ok: false } })),
    );
    const json = await (await customer.GET(get(`/api/bank-ops/customer?user=${CUSTOMER}&asset=USDT`))).json();
    expect(json.check.part.kind).toBe('failed');
  });

  it('a service refusal keeps its code and gets the sentence that says why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(412, 'x (portfolio.entries_do_not_sum)', 'portfolio.entries_do_not_sum')),
    );
    const json = await (await customer.GET(get(`/api/bank-ops/customer?user=${CUSTOMER}&asset=USDT`))).json();
    expect(json.entries.part).toMatchObject({ kind: 'failed', code: 'portfolio.entries_do_not_sum' });
    expect(json.entries.part.message).toContain('do not add up to the balance');
  });

  it('a session without the treasury permission is shown the refusal in words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'scope denied', 'scope.denied')),
    );
    const json = await (await customer.GET(get(`/api/bank-ops/customer?user=${CUSTOMER}`))).json();
    expect(json.part).toMatchObject({ kind: 'failed', forbidden: true });
    expect(json.part.message).toContain('admin:treasury');
  });

  it('an id svc-bank could never hold is refused here with 400 and nothing is sent', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const q of [
      '',
      '?user=',
      '?user=not-a-uuid',
      `?user=${CUSTOMER}&asset=`,
      `?user=${CUSTOMER}&asset=${'A'.repeat(17)}`,
      `?user=${CUSTOMER}&asset=US%2FDT`,
      `?user=${CUSTOMER}&cursor=1`,
      `?user=${CUSTOMER}&asset=USDT&cursor=${'1'.repeat(17)}`,
    ]) {
      const res = await customer.GET(get(`/api/bank-ops/customer${q}`));
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'customer_request_invalid' });
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('it writes an audit line at the service, so only this console’s own page may ask', async () => {
    const fn = vi.fn(async () => ok(BALANCES));
    vi.stubGlobal('fetch', fn);
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await customer.GET(get(`/api/bank-ops/customer?user=${CUSTOMER}`, { 'sec-fetch-site': site }));
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_same_origin' });
    }
    expect(fn).not.toHaveBeenCalled();
    expect((await customer.GET(get(`/api/bank-ops/customer?user=${CUSTOMER}`, { 'sec-fetch-site': 'same-origin' }))).status).toBe(200);
  });

  it('a refused founder session is returned unchanged and nothing is read', async () => {
    gate.session.mockResolvedValue(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await customer.GET(get(`/api/bank-ops/customer?user=${CUSTOMER}`))).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });

  it('the page does not read it by itself: the bank desk read never asks for a customer', async () => {
    const fn = vi.fn(async (_url: string) => ok({}));
    vi.stubGlobal('fetch', fn);
    const bank = await import('./bank-ops/route');
    await bank.GET(get('/api/bank-ops'));
    expect(fn.mock.calls.some(([url]) => url.includes('customerBalance'))).toBe(false);
  });
});
