import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bank from './bank-ops/route';
import * as p2p from './p2p-ops/route';
import * as academy from './academy-ops/route';
import * as more from './more-ops/route';
import * as protocol from './protocol-ops/route';
import { DESKS, allReads } from '@/lib/ops-desk/catalog';

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
const ok = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string) =>
  Response.json({ error: { message, code: -32603, data: { code: 'X', httpStatus: status } } }, { status });
const get = (path: string) => new Request(`http://admin.example${path}`);
const post = (path: string, body: unknown) =>
  new Request(`http://admin.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const original = process.env.ADMIN_MODULES;
beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
  if (original === undefined) delete process.env.ADMIN_MODULES;
  else process.env.ADMIN_MODULES = original;
});

const POOLS = [
  { id: 'p1', assetId: 'USDC', kind: 'flexible', name: 'Flexible USDC', aprBps: 450, termDays: null, minDeposit: '10.00000000' },
];

describe('GET bank desk', () => {
  it('reads every declared procedure as the founder, once each, and stamps each with its own time', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url);
        expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
        if (url.includes('/earn.pools')) return ok(POOLS);
        return trpcErr(404, 'No procedure found');
      }),
    );
    const json = await (await bank.GET(get('/api/bank-ops'))).json();
    // One call per distinct procedure and input: the loan book answers two reads (facts and the unpriced list) from one call.
    const distinct = new Set(
      allReads(DESKS.bank).map((r) => JSON.stringify([r.module, r.procedure, r.input ?? null, r.windowDays ?? null])),
    );
    expect(urls).toHaveLength(distinct.size);
    expect(distinct.size).toBeLessThan(allReads(DESKS.bank).length);
    expect(urls.some((u) => u.startsWith('http://edge:4000/api/bank/trpc/earn.pools?input='))).toBe(true);
    expect(json.deskId).toBe('bank');
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    expect(json.reads['bank.pools']).toMatchObject({ part: { kind: 'ok', data: { shape: 'list', rows: [{ id: 'p1' }] } } });
    expect(Number.isFinite(Date.parse(json.reads['bank.pools'].asOf))).toBe(true);
  });
  it('a refused read fails alone: its neighbours still load, and the failure says forbidden, not empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('/earn.pools') ? ok(POOLS) : trpcErr(403, 'Missing scope bank:read'))),
    );
    const json = await (await bank.GET(get('/api/bank-ops'))).json();
    expect(json.reads['bank.pools'].part.kind).toBe('ok');
    expect(json.reads['bank.loan-products'].part).toMatchObject({ kind: 'failed', forbidden: true });
  });
  it('an answer in an unexpected shape is a failed read, never a table', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok([{ id: 'p1', aprBps: '4.5' }])),
    );
    const json = await (await bank.GET(get('/api/bank-ops'))).json();
    expect(json.reads['bank.pools'].part).toMatchObject({ kind: 'failed', message: expect.stringContaining('shape') });
  });
  it('a service that is down is a failed read, not zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const json = await (await bank.GET(get('/api/bank-ops'))).json();
    expect(json.reads['bank.pools'].part).toMatchObject({ kind: 'failed', forbidden: false });
  });
});

describe('read-only desks have no way to change anything', () => {
  it('bank and p2p export a GET and one POST each, and nothing else', () => {
    for (const route of [bank, p2p]) {
      expect(Object.keys(route).filter((k) => ['PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
      expect(Object.keys(route).filter((k) => k === 'POST')).toEqual(['POST']);
    }
  });
  it('p2p reads the dispute list with a status and page size and never asks for a single dispute', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return trpcErr(403, 'not a moderator');
      }),
    );
    await p2p.GET(get('/api/p2p-ops'));
    const list = urls.find((u) => u.includes('/disputes.list'))!;
    expect(decodeURIComponent(list)).toContain('{"status":"open","limit":50}');
    expect(urls.some((u) => u.includes('/disputes.get'))).toBe(false);
  });
});

describe('GET protocol desk and the token section', () => {
  it('protocol: reads the chain, audit, indexer and DEX procedures through the edge as the founder, and can only POST the listing steps', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url);
        expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
        return Promise.reject(new Error('ECONNREFUSED'));
      }),
    );
    const json = await (await protocol.GET(get('/api/protocol-ops'))).json();
    expect(urls.sort()).toEqual(
      [
        'http://edge:4000/api/protocol/trpc/chainStatus',
        'http://edge:4000/api/protocol/trpc/auditStatus',
        'http://edge:4000/api/protocol/trpc/health',
        'http://edge:4000/api/indexer/trpc/status',
        'http://edge:4000/api/dex/trpc/health',
      ].sort(),
    );
    // Every service down: every read is a failed part with the time it was tried, never a number.
    for (const id of ['protocol.chain', 'protocol.audit', 'protocol.indexer', 'protocol.dex', 'protocol.health']) {
      expect(json.reads[id].part, id).toMatchObject({ kind: 'failed', forbidden: false });
      expect(Number.isFinite(Date.parse(json.reads[id].asOf)), id).toBe(true);
    }
    // The one write is the two-founder listing step (hide, restore, delist, relist); nothing else can change.
    expect(Object.keys(protocol).filter((k) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual(['POST']);
  });
  it('protocol: an audit answer that claims an outside audit is an unreadable read, not a badge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auditStatus')
          ? ok({ id: 'x', kind: 'internal', packagePath: 'p', artifactHash: '0x1', signedBy: null, signedAt: null, audited: true })
          : trpcErr(404, 'No procedure found'),
      ),
    );
    const json = await (await protocol.GET(get('/api/protocol-ops'))).json();
    expect(json.reads['protocol.audit'].part).toMatchObject({ kind: 'failed', message: expect.stringContaining('shape') });
  });
  it('more: reads the token procedures with an explicit page size, and a refused token read is forbidden, not empty', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('/api/token/trpc/nextEmissionEpoch')) return ok({ epoch: 4 });
        if (url.includes('/api/token/')) return trpcErr(403, 'Missing scope token:read');
        return trpcErr(404, 'No procedure found');
      }),
    );
    const json = await (await more.GET(get('/api/more-ops'))).json();
    const proposals = urls.find((u) => u.includes('/api/token/trpc/listProposals'))!;
    expect(decodeURIComponent(proposals)).toContain('{"limit":50}');
    expect(urls.some((u) => u.includes('/api/token/trpc/burnedSupply'))).toBe(true);
    expect(json.reads['token.epoch'].part).toMatchObject({ kind: 'ok', data: { shape: 'record' } });
    expect(json.reads['token.proposals'].part).toMatchObject({ kind: 'failed', forbidden: true });
    expect(json.reads['token.proposals'].part.message).toMatch(/^Your console session does not have token read permission/);
  });
});

describe('POST on desks with actions', () => {
  const vendorId = '5a3b9c10-1111-4222-8333-444455556666';
  it('more: refuses a request kind that belongs to another desk, before sending anything', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await more.POST(
      post('/api/more-ops', {
        step: 'propose',
        request: { kind: 'academy.ambassador.unfreeze', userId: vendorId },
        confirm: `UNFREEZE AMBASSADOR ${vendorId.slice(0, 8)}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('more: a propose without the typed phrase is refused before it reaches identity', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await more.POST(
      post('/api/more-ops', {
        step: 'propose',
        request: { kind: 'market.vendor.vet', vendorId, decision: 'approved', reason: 'documents checked fully' },
        confirm: 'approve vendor',
      }),
    );
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('more: proposes at identity bound to svc-market market.vendor.vet, and returns a packet', async () => {
    const reason = 'documents checked fully';
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      return ok({
        approvalId: 'appr_1',
        operationId: 'op_1',
        ...body,
        requesterId: FOUNDER,
        approverId: null,
        status: 'PENDING',
        createdAt: '2026-10-17T03:00:00.000Z',
        expiresAt: '2026-10-17T03:10:00.000Z',
      });
    });
    vi.stubGlobal('fetch', fn);
    const res = await more.POST(
      post('/api/more-ops', {
        step: 'propose',
        request: { kind: 'market.vendor.vet', vendorId, decision: 'approved', reason },
        confirm: 'APPROVE VENDOR 5a3b9c10',
      }),
    );
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, step: 'propose' });
    expect(String(json.packet).startsWith('ifa1.')).toBe(true);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/identity/trpc/actionApproval.propose');
    expect(JSON.parse(String(init!.body))).toMatchObject({
      actionType: 'market.vendor.vet',
      targetService: 'svc-market',
      targetId: 'market.vendor.vet',
      expectedVersion: '1',
    });
  });
  it('academy: proposes an appointment at identity bound to svc-academy academy.ambassador.appoint, and returns a packet', async () => {
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    const fn = vi.fn(async (_url: string, init?: RequestInit) =>
      ok({
        approvalId: 'appr_1',
        operationId: 'op_1',
        ...JSON.parse(String(init!.body)),
        requesterId: FOUNDER,
        approverId: null,
        status: 'PENDING',
        createdAt: '2026-10-17T03:00:00.000Z',
        expiresAt: '2026-10-17T03:10:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fn);
    const res = await academy.POST(
      post('/api/academy-ops', {
        step: 'propose',
        request: { kind: 'academy.ambassador.appoint', userId },
        confirm: 'APPOINT AMBASSADOR 9f8e7d6c',
      }),
    );
    expect(await res.json()).toMatchObject({ ok: true, step: 'propose' });
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/actionApproval.propose');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toMatchObject({
      actionType: 'academy.ambassador.appoint',
      targetService: 'svc-academy',
      targetId: 'academy.ambassador.appoint',
    });
  });
  it('academy: an appointment without its typed phrase, or on the wrong desk, is refused before anything is sent', async () => {
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect(
      (
        await academy.POST(
          post('/api/academy-ops', { step: 'propose', request: { kind: 'academy.ambassador.appoint', userId }, confirm: 'appoint' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await more.POST(
          post('/api/more-ops', {
            step: 'propose',
            request: { kind: 'academy.residency.decide', id: userId, decision: 'accepted' },
            confirm: 'ACCEPT RESIDENCY 9f8e7d6c',
          }),
        )
      ).status,
    ).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('academy: runs a residency decision at svc-academy with the approval ids', async () => {
    const id = '5a3b9c10-1111-4222-8333-444455556666';
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ id, status: 'rejected' }));
    vi.stubGlobal('fetch', fn);
    const res = await academy.POST(
      post('/api/academy-ops', {
        step: 'execute',
        request: { kind: 'academy.residency.decide', id, decision: 'rejected' },
        confirm: 'REJECT RESIDENCY 5a3b9c10',
        approvalId: 'appr_1',
        operationId: 'op_1',
      }),
    );
    expect(await res.json()).toMatchObject({ ok: true, step: 'execute' });
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/academy/trpc/decideResidency');
  });
  it('academy: a 403 from svc-academy on an appointment is the plain permission sentence, never ok', async () => {
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'Missing scope admin:write')),
    );
    const res = await academy.POST(
      post('/api/academy-ops', {
        step: 'execute',
        request: { kind: 'academy.ambassador.appoint', userId },
        confirm: 'APPOINT AMBASSADOR 9f8e7d6c',
        approvalId: 'appr_1',
        operationId: 'op_1',
      }),
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json).toMatchObject({
      ok: false,
      refusal: { title: 'Your console session does not have Academy operator permission', changed: 'no' },
    });
  });
  it('academy: runs the freeze at svc-academy with the approval ids', async () => {
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ userId, status: 'frozen' }));
    vi.stubGlobal('fetch', fn);
    const res = await academy.POST(
      post('/api/academy-ops', {
        step: 'execute',
        request: { kind: 'academy.ambassador.freeze', userId, reason: 'conduct complaint under review' },
        confirm: 'FREEZE AMBASSADOR 9f8e7d6c',
        approvalId: 'appr_1',
        operationId: 'op_1',
      }),
    );
    expect(await res.json()).toMatchObject({ ok: true, step: 'execute' });
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/academy/trpc/freezeAmbassador');
  });
});

describe("reject and withdraw cannot reach another desk's approval", () => {
  const ledger = { kind: 'ledger.freeze', reason: 'reconciliation mismatch on USD', version: 'v1' };
  it('refuse a ledger request on the academy and more desks, and a body with no request, before sending anything', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const step of ['reject', 'revoke']) {
      for (const [route, path] of [
        [academy, '/api/academy-ops'],
        [more, '/api/more-ops'],
      ] as const) {
        expect((await route.POST(post(path, { step, request: ledger, approvalId: 'appr_1' }))).status, `${step} ${path} ledger`).toBe(400);
        expect((await route.POST(post(path, { step, approvalId: 'appr_1' }))).status, `${step} ${path} bare`).toBe(400);
      }
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('still reject an approval for their own kind', async () => {
    const userId = '9f8e7d6c-1111-4222-8333-444455556666';
    const fn = vi.fn(async () =>
      ok({
        approvalId: 'appr_1',
        operationId: 'op_1',
        status: 'REJECTED',
        expiresAt: '2026-10-17T03:10:00.000Z',
        requesterId: '22222222-2222-4222-8222-222222222222',
        approverId: FOUNDER,
        actionType: 'academy.ambassador.unfreeze',
        targetService: 'svc-academy',
        targetId: 'academy.ambassador.unfreeze',
        expectedVersion: '1',
        payloadHash: 'sha256:x',
        policyVersion: 'v1',
        createdAt: '2026-10-17T03:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fn);
    const res = await academy.POST(
      post('/api/academy-ops', { step: 'reject', request: { kind: 'academy.ambassador.unfreeze', userId }, approvalId: 'appr_1' }),
    );
    expect((await res.json()).ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('module gate', () => {
  it('ADMIN_MODULES that leaves a desk out makes its API answer 404 before doing anything', async () => {
    process.env.ADMIN_MODULES = 'crm';
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const [route, path] of [
      [bank, '/api/bank-ops'],
      [p2p, '/api/p2p-ops'],
      [academy, '/api/academy-ops'],
      [more, '/api/more-ops'],
      [protocol, '/api/protocol-ops'],
    ] as const) {
      expect((await route.GET(get(path))).status, path).toBe(404);
    }
    expect((await academy.POST(post('/api/academy-ops', {}))).status).toBe(404);
    expect((await more.POST(post('/api/more-ops', {}))).status).toBe(404);
    expect(gate.session).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
  it('a refused founder session is returned unchanged and nothing is read', async () => {
    gate.session.mockResolvedValue(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await bank.GET(get('/api/bank-ops'))).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});
