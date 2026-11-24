import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsLedgerReversal } from '@intafaced/contracts/ops-ledger-reversals';
import { FOUNDER, founderCtx, treasuryToken } from '@/testing/recon-alert-fixtures.test-util';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: vi.fn(async () => null), adminBffSession: gate.session }));

const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVERSING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const T = '2026-11-24T08:00:00.000Z';
const row = (over: Partial<OpsLedgerReversal> = {}): OpsLedgerReversal => ({
  requestNo: '1',
  originalTxId: ORIGINAL,
  ordinal: '1',
  reason: 'LOCAL TEST posted to the wrong account',
  caseRef: 'CASE-7',
  state: 'intent',
  requestedBy: FOUNDER,
  requestedAt: T,
  approverId: null,
  approvedAt: null,
  ledgerKey: `ops:reversal:${ORIGINAL}:1`,
  reversingTxId: null,
  code: null,
  reversedBy: null,
  attempts: 0,
  lastAttemptAt: null,
  settledAt: null,
  ...over,
});
const posted = row({
  state: 'posted',
  approverId: APPROVER,
  approvedAt: T,
  reversingTxId: REVERSING,
  attempts: 1,
  lastAttemptAt: T,
  settledAt: T,
});
const trpc = (data: unknown) => Response.json({ result: { data } });
const refused = (code: string, status: number) =>
  Response.json(
    { error: { message: `${code} — refused`, code: -32603, data: { code: 'CONFLICT', httpStatus: status, cause: { code } } } },
    { status },
  );

const ask = { txId: ORIGINAL.toUpperCase(), reason: 'LOCAL TEST posted to the wrong account', caseRef: 'CASE-7' };
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/ledger-reversals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const get = (query: string) => GET(new Request(`http://admin.example/api/ledger-reversals?${query}`));

const original = { ...process.env };
beforeEach(() => {
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = treasuryToken(FOUNDER);
  gate.session.mockResolvedValue(founderCtx);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...original };
  gate.session.mockReset();
});

describe('POST /api/ledger-reversals: ask for a reversal', () => {
  it('asks svc-ops on the treasury transport; the intent row comes back and nothing posts', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => trpc(row()));
    vi.stubGlobal('fetch', fn);
    const res = await post(ask);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reversal: { requestNo: '1', state: 'intent' } });
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/api/ops/trpc/ledgerReversals.request');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${treasuryToken(FOUNDER)}`);
    expect(JSON.parse(init!.body as string)).toEqual({ originalTxId: ORIGINAL, reason: ask.reason, caseRef: ask.caseRef });
  });

  it('a second reversal is refused ops.reversal_already_reversed, with the first reversal read from svc-ops', async () => {
    const fn = vi.fn(async (url: string) =>
      url.includes('ledgerReversals.request') ? refused('ops.reversal_already_reversed', 409) : trpc({ reversals: [posted], asOf: T }),
    );
    vi.stubGlobal('fetch', fn);
    const res = await post({ ...ask, caseRef: 'CASE-8' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      refusal: { code: 'ops.reversal_already_reversed', changed: 'no' },
      firstReversal: { requestNo: '1', reversingTxId: REVERSING },
    });
    // The list is read as the founder, not on the treasury credential.
    const listCall = fn.mock.calls.find(([u]) => String(u).includes('ledgerReversals.list'))!;
    expect(String(listCall[0])).toContain('http://edge:4000/api/ops/trpc/ledgerReversals.list');
  });

  it('a short reason or a blank case reference is refused here and nothing is sent', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await post({ ...ask, reason: 'too short' })).status).toBe(400);
    expect((await post({ ...ask, caseRef: '  ' })).status).toBe(400);
    expect((await post({ ...ask, txId: 'not-a-tx' })).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a founder who does not hold the treasury credential asks nothing', async () => {
    process.env.ADMIN_TREASURY_TOKEN = treasuryToken(APPROVER);
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await post(ask);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'admin.treasury_holder_mismatch' } });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET /api/ledger-reversals: the requests on one transaction', () => {
  it('reads them as the founder with whether this founder can ask here', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => trpc({ reversals: [row()], asOf: T }));
    vi.stubGlobal('fetch', fn);
    const res = await get(`txId=${ORIGINAL}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, list: { reversals: [{ requestNo: '1', state: 'intent' }] }, writes: null });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toContain('/api/ops/trpc/ledgerReversals.list?input=');
    expect(decodeURIComponent(url)).toContain(`"originalTxId":"${ORIGINAL}"`);
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('refuses a list that names another transaction, and a malformed query', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpc({ reversals: [row({ originalTxId: REVERSING })], asOf: T })),
    );
    expect((await get(`txId=${ORIGINAL}`)).status).toBe(502);
    expect((await get('txId=nope')).status).toBe(400);
  });
});
