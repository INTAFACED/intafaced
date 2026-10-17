import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as payOps from './pay-ops/route';
import * as transfer from './pay-ops/transfer/route';
import * as page from './pay-ops/page/route';

/**
 * The Personal Pay desk through its BFFs: which svc-bank procedures it calls and with what input, that a refused or drifting answer
 * is a failed part, and that the transfer record is read only on request, as the signed-in founder.
 */

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const ctx = {
  session: {
    userId: FOUNDER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const AT = '2026-10-18T03:00:00.000Z';
const EXEC = '5a3b9c10-1111-4222-8333-444455556666';
const ok = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string, code?: string) =>
  Response.json(
    { error: { message, code: -32603, data: { code: 'X', httpStatus: status, ...(code ? { cause: { code } } : {}) } } },
    { status },
  );
const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://admin.example${path}`, { headers });

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

const PARTY = { handle: null, reason: 'handle_unresolved' };
const ANSWERS: Record<string, unknown> = {
  'ops.transferHealth': {
    asOf: AT,
    standingOrders: { pending: 1, settled: 2, rejected: 1, skipped: 0, total: 4, failureRate: '0.25', oldestPendingAgeSeconds: 5 },
    oneOff: {
      available: true,
      reserved: 0,
      posted: 2,
      total: 2,
      failureRate: null,
      failureRateReason: 'failures_not_recorded',
      oldestPendingAgeSeconds: null,
    },
    p2p: { available: false, reason: 'served_by_p2p_ops' },
    bills: {
      available: true,
      submitted: 0,
      accepted: 0,
      paid: 1,
      failed: 0,
      returned: 0,
      total: 1,
      failureRate: '0',
      oldestPendingAgeSeconds: null,
    },
  },
  'ops.failedTransfers': {
    items: [
      {
        id: EXEC,
        kind: 'standing_order',
        amount: '10',
        assetId: 'USDC',
        status: 'rejected',
        rejectionCode: 'ledger.insufficient_funds',
        reason: 'ledger.insufficient_funds',
        attemptedAt: AT,
        sender: PARTY,
        receiver: PARTY,
      },
    ],
    nextCursor: null,
  },
  'bills.ops.summary': {
    asOf: AT,
    counts: { submitted: 0, accepted: 0, paid: 1, failed: 0, returned: 0 },
    volumes: [{ status: 'paid', assetId: 'USDC', count: 1, amount: '5' }],
    rails: { billerDirectory: 'unset', lookup: 'unset', payRail: 'unset', blocker: 'socket.psp-partners' },
  },
  'bills.ops.failed': { items: [], nextCursor: null },
  'global.ops.summary': {
    asOf: AT,
    counts: { submitted: 0, sent: 0, on_the_way: 0, arrived: 0, failed: 0 },
    volumes: [],
    rails: { corridors: 'unset', fx: 'unset', payout: 'unset', bic: 'unset', travelRule: 'undecided', blocker: 'socket.psp-partners' },
  },
  'global.ops.failed': [],
};
const procedureOf = (url: string) => /\/api\/bank\/trpc\/([^?]+)/.exec(url)![1]!;

describe('GET /api/pay-ops', () => {
  it('reads each svc-bank operator procedure once, as the founder, with the window and page size the service requires', async () => {
    const calls: { name: string; input: unknown; auth: string | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const name = procedureOf(url);
        const raw = new URL(url).searchParams.get('input');
        calls.push({ name, input: raw ? JSON.parse(raw) : undefined, auth: (init!.headers as Record<string, string>).authorization });
        return Object.hasOwn(ANSWERS, name) ? ok(ANSWERS[name]) : trpcErr(404, 'No procedure found');
      }),
    );
    const json = await (await payOps.GET(get('/api/pay-ops'))).json();
    expect(json.deskId).toBe('pay');
    expect(calls.every((c) => c.auth === 'Bearer founder-access-token')).toBe(true);
    const byName = (name: string) => calls.filter((c) => c.name === name).map((c) => c.input);
    // The seven health blocks share two calls: one per window.
    expect(byName('ops.transferHealth')).toEqual(expect.arrayContaining([{ windowHours: 24 }, { windowHours: 168 }]));
    expect(byName('ops.transferHealth')).toHaveLength(2);
    expect(byName('ops.failedTransfers')).toEqual([{ windowHours: 168, limit: 50 }]);
    expect(byName('bills.ops.failed')).toEqual([{ limit: 50 }]);
    expect(byName('global.ops.failed')).toEqual([{ limit: 50 }]);
    // The summaries are one call each, shared by the facts block and the volumes table.
    expect(byName('bills.ops.summary')).toHaveLength(1);
    expect(byName('global.ops.summary')).toHaveLength(1);
    // The transfer record is NOT read with the page: svc-bank logs every one it hands out.
    expect(calls.some((c) => c.name === 'ops.transferDetail')).toBe(false);
    expect(json.reads['pay.standing-24h'].part).toMatchObject({ kind: 'ok' });
    expect(json.reads['pay.failed-standing'].part).toMatchObject({ kind: 'ok', data: { shape: 'list', rows: [{ id: EXEC }] } });
    expect(Number.isFinite(Date.parse(json.reads['pay.failed-standing'].asOf))).toBe(true);
  });
  it('a refused read fails alone, as forbidden, and says which permission it needs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const name = procedureOf(url);
        return name === 'ops.failedTransfers' ? trpcErr(403, 'Missing scope admin:compliance') : ok(ANSWERS[name]);
      }),
    );
    const json = await (await payOps.GET(get('/api/pay-ops'))).json();
    expect(json.reads['pay.failed-standing'].part).toMatchObject({ kind: 'failed', forbidden: true });
    expect(json.reads['pay.failed-standing'].part.message).toContain('admin:compliance');
    expect(json.reads['pay.standing-24h'].part.kind).toBe('ok');
  });
  it('a typed refusal comes back in its own sentence with the service’s code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const name = procedureOf(url);
        return name === 'ops.failedTransfers'
          ? trpcErr(412, 'IDENTITY_URL is unset (bank.party_handles_unset)', 'bank.party_handles_unset')
          : ok(ANSWERS[name]);
      }),
    );
    const json = await (await payOps.GET(get('/api/pay-ops'))).json();
    expect(json.reads['pay.failed-standing'].part).toMatchObject({ kind: 'failed', code: 'bank.party_handles_unset', forbidden: false });
    expect(json.reads['pay.failed-standing'].part.message).toContain('IDENTITY_URL');
  });
  it('an answer that drifts from the service’s schema is a failed read, never a table', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const name = procedureOf(url);
        if (name !== 'ops.transferHealth') return ok(ANSWERS[name]);
        const health = ANSWERS[name] as { oneOff: object };
        return ok({ ...health, oneOff: { ...health.oneOff, failureRate: '0' } });
      }),
    );
    const json = await (await payOps.GET(get('/api/pay-ops'))).json();
    expect(json.reads['pay.oneoff-24h'].part).toMatchObject({ kind: 'failed', message: expect.stringContaining('shape') });
    expect(json.reads['pay.standing-24h'].part.kind).toBe('ok');
  });
  it('a service that is down is a failed read, not zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const json = await (await payOps.GET(get('/api/pay-ops'))).json();
    expect(json.reads['pay.standing-24h'].part).toMatchObject({ kind: 'failed', forbidden: false });
  });
  it('has no way to change anything: GET only', () => {
    expect(Object.keys(payOps).filter((k) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
    expect(Object.keys(transfer).filter((k) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
    expect(Object.keys(page).filter((k) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
  });
});

describe('GET /api/pay-ops/transfer', () => {
  const DETAIL = {
    id: EXEC,
    kind: 'standing_order',
    senderUserId: '9f8e7d6c-1111-4222-8333-444455556666',
    receiverUserId: '1a2b3c4d-1111-4222-8333-444455556666',
    amount: '10',
    assetId: 'USDC',
    status: 'rejected',
    rejectionCode: 'ledger.insufficient_funds',
    reason: 'ledger.insufficient_funds',
    ledgerTxId: null,
    scheduleId: '7c6b5a49-1111-4222-8333-444455556666',
    occurrence: 2,
    attemptedAt: AT,
    settledAt: null,
  };
  it('reads one record through svc-bank ops.transferDetail as the founder, with the id and nothing else', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(DETAIL));
    vi.stubGlobal('fetch', fn);
    const json = await (await transfer.GET(get(`/api/pay-ops/transfer?id=${EXEC}`))).json();
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(url.startsWith('http://edge:4000/api/bank/trpc/ops.transferDetail?input=')).toBe(true);
    expect(JSON.parse(new URL(url).searchParams.get('input')!)).toEqual({ id: EXEC });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(json.id).toBe('pay.transfer-detail');
    expect(json.part).toMatchObject({ kind: 'ok', data: { shape: 'record' } });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
  });
  it('an unknown id is svc-bank’s own refusal, in a sentence that says why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(404, 'No such transfer (bank.ops_transfer_not_found)', 'bank.ops_transfer_not_found')),
    );
    const json = await (await transfer.GET(get('/api/pay-ops/transfer?id=missing-1'))).json();
    expect(json.part).toMatchObject({ kind: 'failed', code: 'bank.ops_transfer_not_found' });
    expect(json.part.message).toContain('same answer for an id that is not in its format');
  });
  it('an id svc-bank could never have issued is refused here with 400 and nothing is sent: blank, under 8 or over 64 characters, or with a control character', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const q of ['', '?id=', '?id=%20', '?id=short-7', `?id=${'a'.repeat(65)}`, '?id=abcdefg%0Ah', '?id=abcdefg%00h']) {
      const res = await transfer.GET(get(`/api/pay-ops/transfer${q}`));
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'transfer_id_invalid' });
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('an id svc-bank accepts for a one-off send (8 to 64 characters, any printable ones, trimmed) is passed on as typed', async () => {
    const fn = vi.fn(async (_url: string) => ok(DETAIL));
    vi.stubGlobal('fetch', fn);
    for (const id of ['send 0001 ünï', 'a'.repeat(64), '  trimmed-id-1  ']) {
      expect((await transfer.GET(get(`/api/pay-ops/transfer?id=${encodeURIComponent(id)}`))).status).toBe(200);
    }
    const sent = fn.mock.calls.map(([url]) => JSON.parse(new URL(url).searchParams.get('input')!).id);
    expect(sent).toEqual(['send 0001 ünï', 'a'.repeat(64), 'trimmed-id-1']);
  });
  it('it writes an audit line at the service, so only this console’s own page may ask: another site or a sibling subdomain gets 403 and nothing is read', async () => {
    const fn = vi.fn(async () => ok(DETAIL));
    vi.stubGlobal('fetch', fn);
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await transfer.GET(get(`/api/pay-ops/transfer?id=${EXEC}`, { 'sec-fetch-site': site }));
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_same_origin' });
    }
    expect(fn).not.toHaveBeenCalled();
    expect((await transfer.GET(get(`/api/pay-ops/transfer?id=${EXEC}`, { 'sec-fetch-site': 'same-origin' }))).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('a refused founder session is returned unchanged and nothing is read', async () => {
    gate.session.mockResolvedValue(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await transfer.GET(get(`/api/pay-ops/transfer?id=${EXEC}`))).status).toBe(401);
    expect((await payOps.GET(get('/api/pay-ops'))).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
  it('ADMIN_MODULES that leaves the desk out makes both routes answer 404 before doing anything', async () => {
    process.env.ADMIN_MODULES = 'crm';
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await payOps.GET(get('/api/pay-ops'))).status).toBe(404);
    expect((await transfer.GET(get(`/api/pay-ops/transfer?id=${EXEC}`))).status).toBe(404);
    expect((await page.GET(get('/api/pay-ops/page?read=pay.failed-standing&cursor=abc'))).status).toBe(404);
    expect(gate.session).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET /api/pay-ops/page', () => {
  const ITEM = ANSWERS['ops.failedTransfers'] as { items: object[] };
  it('reads the next page of a list that has a marker, with the marker added to the same input, as the founder', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok({ items: ITEM.items, nextCursor: null }));
    vi.stubGlobal('fetch', fn);
    const json = await (await page.GET(get('/api/pay-ops/page?read=pay.failed-standing&cursor=abc_-123'))).json();
    const [url, init] = fn.mock.calls[0]!;
    expect(url.startsWith('http://edge:4000/api/bank/trpc/ops.failedTransfers?input=')).toBe(true);
    expect(JSON.parse(new URL(url).searchParams.get('input')!)).toEqual({ windowHours: 168, limit: 50, cursor: 'abc_-123' });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(json.part).toMatchObject({ kind: 'ok', data: { shape: 'list', nextCursor: null, pageFull: false } });
    fn.mockClear();
    await page.GET(get('/api/pay-ops/page?read=pay.bills-failed&cursor=zzz'));
    expect(JSON.parse(new URL(fn.mock.calls[0]![0]).searchParams.get('input')!)).toEqual({ limit: 50, cursor: 'zzz' });
  });
  it('a read without a marker (global sends, health), an unknown read or a marker that is not base64url is refused here with 400', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const q of [
      '?read=pay.global-failed&cursor=abc',
      '?read=pay.standing-24h&cursor=abc',
      '?read=nope&cursor=abc',
      '?read=pay.failed-standing',
      '?read=pay.failed-standing&cursor=',
      '?read=pay.failed-standing&cursor=a%20b',
      `?read=pay.failed-standing&cursor=${'a'.repeat(513)}`,
    ]) {
      const res = await page.GET(get(`/api/pay-ops/page${q}`));
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'page_invalid' });
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('a marker svc-bank did not issue is its own refusal, in a sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(400, 'bad cursor', 'bank.bills_cursor_invalid')),
    );
    const json = await (await page.GET(get('/api/pay-ops/page?read=pay.bills-failed&cursor=abc'))).json();
    expect(json.part).toMatchObject({ kind: 'failed', code: 'bank.bills_cursor_invalid' });
    expect(json.part.message).toContain('did not issue');
  });
});
