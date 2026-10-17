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
const kill: DeskRequest = { kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident' };

const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const get = () => GET(new Request('http://admin.example/api/kill-switch'));
const approvalRow = (request: DeskRequest, over: Record<string, unknown> = {}) => {
  const p = proposeInputFor(request);
  return {
    approvalId: 'appr_1',
    operationId: 'op_1',
    actionType: p.actionType,
    targetService: p.targetService,
    targetId: p.targetId,
    expectedVersion: p.expectedVersion,
    payloadHash: p.payloadHash,
    requesterId: FOUNDER,
    approverId: null,
    policyVersion: 'v1',
    createdAt: '2026-10-17T03:00:00.000Z',
    expiresAt: '2026-10-17T03:10:00.000Z',
    status: 'PENDING',
    ...over,
  };
};
const snapshot = (killed: boolean) => ({
  disabledModules: killed ? ['trade'] : [],
  reasons: killed ? { trade: kill.reason } : {},
  audit: killed
    ? [
        {
          at: '2026-10-17T03:01:00.000Z',
          module: 'trade',
          actor: 'console',
          confirmOperatorId: 'checker',
          reason: kill.reason,
          previous: false,
          next: true,
          changed: true,
        },
      ]
    : [],
});

beforeEach(() => {
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_OPERATOR_TOKEN = 'isolated-operator-token';
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

describe('kill-switch GET keeps the BFF boundary and typed read refusal', () => {
  it('forwards authoritative read403 while never making a mutation', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ error: 'Isolated scope refusal', code: 'scope.insufficient' }, { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: 'refused', code: 'scope.insufficient', httpStatus: 403 });
    expect(fetchMock).toHaveBeenCalledWith('http://isolated-edge:4000/admin/kill-switches', expect.objectContaining({ cache: 'no-store' }));
  });
  it('malformed edge200 propagates a typed unusable read and never an observed zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'invalid_response', code: 'admin.kill_invalid_response' });
  });
});

describe('kill-switch POST refuses before it sends anything', () => {
  const never = () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    return fn;
  };
  it('a refused founder session returns before the network', async () => {
    const fn = never();
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await post({ step: 'propose', request: kill, confirm: 'KILL trade' })).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
  it('the old single-call body is not accepted: there is no one-person flip', async () => {
    const fn = never();
    const res = await post({ module: 'trade', disabled: true, reason: 'market integrity incident' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'admin.request_invalid', changed: 'no' } });
    expect(fn).not.toHaveBeenCalled();
  });
  it('a wrong or missing typed phrase is refused server-side', async () => {
    const fn = never();
    for (const confirm of ['', 'kill trade', 'KILL pay', 'RE-ENABLE trade']) {
      expect((await post({ step: 'propose', request: kill, confirm })).status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('a ledger request is not accepted on the module route', async () => {
    const fn = never();
    const res = await post({ step: 'propose', request: { kind: 'ledger.unfreeze', version: 'v' }, confirm: 'UNFREEZE LEDGER' });
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('will not arm identity, because the console needs it to approve the way back', async () => {
    const fn = never();
    for (const step of ['propose', 'approve', 'execute']) {
      const res = await post({
        step,
        request: { kind: 'edge.kill', module: 'identity', disabled: true, reason: 'market integrity incident' },
        confirm: 'KILL identity',
        approvalId: 'appr_1',
        operationId: 'op_1',
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'admin.kill_self_lockout', changed: 'no' } });
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('will not arm a module the edge cannot enforce', async () => {
    const fn = never();
    const res = await post({
      step: 'propose',
      request: { kind: 'edge.kill', module: 'ws', disabled: true, reason: 'market integrity incident' },
      confirm: 'KILL ws',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ refusal: { code: 'admin.kill_not_enforceable' } });
    expect(fn).not.toHaveBeenCalled();
  });
  it('a console with no operator credential asks for nothing and sends nothing, but can still reject or withdraw', async () => {
    delete process.env.ADMIN_OPERATOR_TOKEN;
    const fn = vi.fn(async () =>
      Response.json({ result: { data: approvalRow(kill, { status: 'REJECTED', approverId: '22222222-2222-4222-8222-222222222222' }) } }),
    );
    vi.stubGlobal('fetch', fn);
    for (const step of ['propose', 'approve', 'execute']) {
      const res = await post({ step, request: kill, confirm: 'KILL trade', approvalId: 'appr_1', operationId: 'op_1' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ refusal: { code: 'admin.kill_unconfigured', changed: 'no' } });
    }
    expect(fn).not.toHaveBeenCalled();
    expect((await post({ step: 'reject', approvalId: 'appr_1' })).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('kill-switch POST runs the two-founder steps', () => {
  it('propose goes to identity as the founder, never to the edge, and returns a packet that decodes to the request', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ result: { data: approvalRow(kill) } }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'propose', request: kill, confirm: 'KILL trade' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, step: 'propose', approval: { approvalId: 'appr_1', status: 'PENDING' } });
    const read = decodePacket(json.packet);
    expect(read.ok && read.packet.request).toEqual(kill);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/api/identity/trpc/actionApproval.propose');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('execute sends the approval ids to the edge with the console’s operator credential, and never the founder’s token', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ...snapshot(true), changed: true, confirmOperatorId: 'checker' }),
    );
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'execute', request: kill, confirm: 'KILL trade', approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, step: 'execute' });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/admin/kill-switches');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer isolated-operator-token');
    expect(JSON.parse(init!.body as string)).toEqual({
      module: 'trade',
      disabled: true,
      reason: 'market integrity incident',
      approvalId: 'appr_1',
      operationId: 'op_1',
    });
    expect(JSON.stringify(init)).not.toContain('founder-access-token');
  });

  it('re-enable sends disabled:false', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ...snapshot(false), changed: true, confirmOperatorId: 'checker' }),
    );
    vi.stubGlobal('fetch', fn);
    const resume = { ...kill, disabled: false, reason: 'cause resolved, reconciled' };
    const res = await post({ step: 'execute', request: resume, confirm: 'RE-ENABLE trade', approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(200);
    expect(JSON.parse(fn.mock.calls[0]![1]!.body as string)).toMatchObject({ disabled: false });
  });

  it('the edge saying "not approved yet" is a definite refusal that changed nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: 'identity refused consumeForEdge (412) approval is PENDING [action_approval.not_approved]',
            code: 'action_approval.consume_failed',
          },
          { status: 400 },
        ),
      ),
    );
    const res = await post({ step: 'execute', request: kill, confirm: 'KILL trade', approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'action_approval.not_approved', changed: 'no' } });
  });

  it('an edge failure with no typed reason is "not known" and the page is told to read the state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'upstream exploded' }, { status: 502 })),
    );
    const res = await post({ step: 'execute', request: kill, confirm: 'KILL trade', approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('a 200 whose snapshot does not show the requested state is not reported as applied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...snapshot(false), changed: false, confirmOperatorId: 'checker' })),
    );
    const res = await post({ step: 'execute', request: kill, confirm: 'KILL trade', approvalId: 'appr_1', operationId: 'op_1' });
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('a dropped connection to the edge is "not known"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    const res = await post({ step: 'execute', request: kill, confirm: 'KILL trade', approvalId: 'appr_1', operationId: 'op_1' });
    expect(await res.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('writes one audit line per step naming the founder, with no reason text and no credential', async () => {
    const warn = vi.mocked(console.warn);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: approvalRow(kill) } })),
    );
    await post({ step: 'propose', request: kill, confirm: 'KILL trade' });
    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(line)).toMatchObject({ audit: 'admin.desk.step', founder: FOUNDER, step: 'propose', module: 'trade' });
    expect(line).not.toContain(kill.reason);
    expect(line).not.toContain('founder-access-token');
    expect(line).not.toContain('isolated-operator-token');
  });
});
