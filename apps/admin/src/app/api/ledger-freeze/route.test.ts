import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { proposeInputFor } from '@/lib/desk/approval-hash';
import { decodePacket, type DeskRequest } from '@/lib/desk/approval-packet';

const gate = vi.hoisted(() => ({
  bff: vi.fn<() => Promise<Response | null>>(async () => null),
  session: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: gate.bff, adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const founderCtx = {
  session: {
    userId: FOUNDER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://isolated-edge:4000', key: Buffer.alloc(32, 1) },
};
const original = { ...process.env };
const VERSION = '2026-10-17 03:00:00.123456+00';
const freeze: DeskRequest = { kind: 'ledger.freeze', reason: 'reconciliation mismatch on USD', version: VERSION };
const unfreeze: DeskRequest = { kind: 'ledger.unfreeze', version: VERSION };
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/ledger-freeze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const get = () => GET(new Request('http://admin.example/api/ledger-freeze'));
const record = (frozen: boolean, extra: Record<string, unknown> = {}) => ({
  frozen,
  reason: frozen ? (freeze.kind === 'ledger.freeze' ? freeze.reason : null) : null,
  actor: 'operator',
  changedAt: '2026-10-17T03:00:00.000Z',
  ...extra,
});
const approvalRow = (request: DeskRequest) => {
  const p = proposeInputFor(request);
  return {
    approvalId: 'appr_1',
    operationId: 'op_1',
    ...p,
    requesterId: FOUNDER,
    approverId: null,
    createdAt: '2026-10-17T03:00:00.000Z',
    expiresAt: '2026-10-17T03:10:00.000Z',
    status: 'PENDING',
  };
};

beforeEach(() => {
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = 'isolated-treasury-token';
  gate.session.mockResolvedValue(founderCtx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...original };
  vi.unstubAllGlobals();
  gate.bff.mockReset();
  gate.bff.mockResolvedValue(null);
  gate.session.mockReset();
});

describe('ledger GET', () => {
  it('a refused founder gate returns before the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    gate.bff.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('malformed 2xx read becomes 502 rather than default not-frozen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );
    const res = await get();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ kind: 'invalid_response', state: null, upstreamStatus: 200 });
  });
  it('403/404 read keeps refusal/route-absence, never inventing a missing storage row', async () => {
    for (const status of [403, 404]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: 'Opaque refusal', code: 'edge.no_route' }, { status })),
      );
      const res = await get();
      expect(res.status).toBe(status);
      expect((await res.json()).state).toBeNull();
    }
  });
  it('passes the ledger’s version token through when it returns one, and omits it when it does not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(record(false, { version: VERSION }))),
    );
    expect((await (await get()).json()).state).toMatchObject({ version: VERSION });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(record(false))),
    );
    expect((await (await get()).json()).state).not.toHaveProperty('version');
  });
});

describe('ledger POST refuses before it sends anything', () => {
  const never = () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    return fn;
  };
  it('a refused founder session returns before the network', async () => {
    const fn = never();
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_origin' }, { status: 403 }));
    expect((await post({ step: 'propose', request: freeze, confirm: 'FREEZE LEDGER' })).status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });
  it('the old single-call body is not accepted: there is no one-person freeze', async () => {
    const fn = never();
    for (const body of [null, [], {}, { frozen: true, reason: 'reconciliation mismatch on USD' }, { frozen: false }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('a wrong phrase is refused: freeze needs FREEZE LEDGER and unfreeze needs UNFREEZE LEDGER', async () => {
    const fn = never();
    expect((await post({ step: 'propose', request: freeze, confirm: 'UNFREEZE LEDGER' })).status).toBe(400);
    expect((await post({ step: 'propose', request: unfreeze, confirm: 'FREEZE LEDGER' })).status).toBe(400);
    expect((await post({ step: 'propose', request: freeze, confirm: 'freeze ledger' })).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('a freeze needs a real reason, and a version: neither is invented', async () => {
    const fn = never();
    expect((await post({ step: 'propose', request: { ...freeze, reason: 'short' }, confirm: 'FREEZE LEDGER' })).status).toBe(400);
    expect(
      (
        await post({
          step: 'propose',
          request: { kind: 'ledger.freeze', reason: freeze.kind === 'ledger.freeze' ? freeze.reason : '' },
          confirm: 'FREEZE LEDGER',
        })
      ).status,
    ).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('a module kill is not accepted on the ledger route', async () => {
    const fn = never();
    const res = await post({
      step: 'propose',
      request: { kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident' },
      confirm: 'KILL trade',
    });
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('a console with no treasury credential asks for nothing and sends nothing, but can still reject or withdraw', async () => {
    delete process.env.ADMIN_TREASURY_TOKEN;
    const fn = vi.fn(async () =>
      Response.json({
        result: { data: { ...approvalRow(freeze), status: 'REJECTED', approverId: '22222222-2222-4222-8222-222222222222' } },
      }),
    );
    vi.stubGlobal('fetch', fn);
    for (const step of ['propose', 'approve', 'execute']) {
      const res = await post({ step, request: freeze, confirm: 'FREEZE LEDGER', approvalId: 'appr_1', operationId: 'op_1' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ refusal: { code: 'admin.ledger_unconfigured', changed: 'no' } });
    }
    expect(fn).not.toHaveBeenCalled();
    expect((await post({ step: 'reject', approvalId: 'appr_1' })).status).toBe(200);
  });
});

describe('ledger POST runs the two-founder steps', () => {
  it('propose binds the approval to the ledger’s own version, as the founder', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ result: { data: approvalRow(freeze) } }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'propose', request: freeze, confirm: 'FREEZE LEDGER' });
    expect(res.status).toBe(200);
    const read = decodePacket((await res.json()).packet);
    expect(read.ok && read.packet.request).toEqual(freeze);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/api/identity/trpc/actionApproval.propose');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      actionType: 'ledger.freeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: VERSION,
    });
  });

  it('executing a freeze sends the trimmed reason and the approval ids to the edge with the treasury credential', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ...record(true), confirmOperatorId: 'checker' }));
    vi.stubGlobal('fetch', fn);
    const res = await post({
      step: 'execute',
      request: { ...freeze, reason: '  reconciliation mismatch on USD  ' },
      confirm: 'FREEZE LEDGER',
      approvalId: 'appr_1',
      operationId: 'op_1',
    });
    expect(await res.json()).toMatchObject({ ok: true, step: 'execute' });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/admin/ledger/freeze');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer isolated-treasury-token');
    expect(JSON.parse(init!.body as string)).toEqual({
      reason: 'reconciliation mismatch on USD',
      approvalId: 'appr_1',
      operationId: 'op_1',
    });
    expect(JSON.stringify(init)).not.toContain('founder-access-token');
  });

  it('executing an unfreeze sends no reason and posts to unfreeze', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ...record(false), confirmOperatorId: 'checker' }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'execute', request: unfreeze, confirm: 'UNFREEZE LEDGER', approvalId: 'appr_1', operationId: 'op_1' });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(fn.mock.calls[0]![0]).toBe('http://isolated-edge:4000/admin/ledger/unfreeze');
    expect(JSON.parse(fn.mock.calls[0]![1]!.body as string)).toEqual({ approvalId: 'appr_1', operationId: 'op_1' });
  });

  it('a 200 that shows the wrong state is not reported as applied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(record(false))),
    );
    const res = await post({ step: 'execute', request: freeze, confirm: 'FREEZE LEDGER', approvalId: 'appr_1', operationId: 'op_1' });
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('"first reason stands" (already frozen) is a definite refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'already frozen by reconciliation', code: 'ledger.freeze_attributed' }, { status: 409 })),
    );
    const res = await post({ step: 'execute', request: freeze, confirm: 'FREEZE LEDGER', approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'no' } });
  });

  it('"not approved yet" relayed by the edge changed nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'identity refused consume (412) [action_approval.not_approved]', code: 'action_approval.consume_failed' },
          { status: 400 },
        ),
      ),
    );
    const res = await post({ step: 'execute', request: freeze, confirm: 'FREEZE LEDGER', approvalId: 'appr_1', operationId: 'op_1' });
    expect(await res.json()).toMatchObject({ refusal: { code: 'action_approval.not_approved', changed: 'no' } });
  });

  it('an unreachable ledger behind the edge is a definite "nothing was sent to it"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'This edge is not configured to reach svc-ledger', code: 'edge.ledger_unreachable' }, { status: 503 }),
      ),
    );
    const res = await post({ step: 'execute', request: freeze, confirm: 'FREEZE LEDGER', approvalId: 'appr_1', operationId: 'op_1' });
    expect(await res.json()).toMatchObject({ refusal: { code: 'edge.ledger_unreachable', changed: 'no' } });
  });

  it('a dropped connection is "not known"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    const res = await post({ step: 'execute', request: unfreeze, confirm: 'UNFREEZE LEDGER', approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ refusal: { changed: 'unknown' } });
  });
});
