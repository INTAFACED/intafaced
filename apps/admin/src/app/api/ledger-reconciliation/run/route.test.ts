import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proposeInputFor } from '@/lib/desk/approval-hash';
import { decodePacket, type DeskRequest } from '@/lib/desk/approval-packet';
import { CONTROL_ID, runView } from '@/lib/ledger/reconciliation-fixtures.test-util';
import { POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: vi.fn(async () => null), adminBffSession: gate.session }));

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
const runNow: DeskRequest = {
  kind: 'ledger.reconciliation_control.run',
  controlId: CONTROL_ID,
  version: '3',
  asOf: 'now',
  margin: 'unset',
  reason: 'LOCAL TEST run the USDT floor control',
};
const runPast: DeskRequest = { ...runNow, asOf: '2026-10-23T06:30:00.000Z', margin: '0' } as DeskRequest;
const PHRASE = 'RUN CONTROL 0b4f6c2e';
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/ledger-reconciliation/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const approvalRow = (request: DeskRequest) => ({
  approvalId: 'appr_1',
  operationId: 'op_1',
  ...proposeInputFor(request),
  requesterId: FOUNDER,
  approverId: null,
  createdAt: '2026-10-24T06:00:00.000Z',
  expiresAt: '2026-10-24T06:10:00.000Z',
  status: 'PENDING',
});

beforeEach(() => {
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = 'isolated-treasury-token';
  gate.session.mockResolvedValue(founderCtx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...original };
  gate.session.mockReset();
});

describe('control run: the two-founder steps', () => {
  it('propose binds the approval to the control version, as the founder, and hands back a packet', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ result: { data: approvalRow(runNow) } }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'propose', request: runNow, confirm: PHRASE });
    expect(res.status).toBe(200);
    const read = decodePacket((await res.json()).packet);
    expect(read.ok && read.packet.request).toEqual(runNow);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/api/identity/trpc/actionApproval.propose');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      actionType: 'ledger.reconciliation_control.run',
      targetService: 'svc-ledger',
      targetId: 'posting_reconciliation_control.run',
      expectedVersion: '3',
    });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('run sends the approved run on the treasury transport and reports the stored run', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(runView({ outsideSide: 'unset' })));
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'execute', request: runNow, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(200);
    expect((await res.json()).detail).toContain('Outside side: unset');
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/admin/ledger/reconciliation/controls/run');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer isolated-treasury-token');
    expect(JSON.parse(init!.body as string)).toEqual({
      controlId: CONTROL_ID,
      reason: 'LOCAL TEST run the USDT floor control',
      approvalId: 'appr_1',
      operationId: 'op_1',
    });
  });
  it('a past run sends its instant and margin', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(runView()));
    vi.stubGlobal('fetch', fn);
    await post({ step: 'execute', request: runPast, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
    expect(JSON.parse(fn.mock.calls[0]![1]!.body as string)).toMatchObject({ asOf: '2026-10-23T06:30:00.000Z', margin: '0' });
  });
  it('svc-ledger’s refusal of a future instant keeps its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ message: 'ledger.reconcile_asof_invalid', code: 'ledger.reconcile_asof_invalid' }, { status: 400 }),
      ),
    );
    const res = await post({ step: 'execute', request: runPast, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'ledger.reconcile_asof_invalid', changed: 'no' } });
  });
  it('a code svc-ledger nests in its error body is still read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { json: { message: 'ops.control_state_illegal' } } }, { status: 412 })),
    );
    const res = await post({ step: 'execute', request: runNow, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'ops.control_state_illegal', changed: 'no' } });
  });
  it('a console with no treasury credential proposes, approves and runs nothing, but can still reject', async () => {
    delete process.env.ADMIN_TREASURY_TOKEN;
    const fn = vi.fn(async () => Response.json({ result: { data: { ...approvalRow(runNow), status: 'REJECTED', approverId: FOUNDER } } }));
    vi.stubGlobal('fetch', fn);
    for (const step of ['propose', 'approve', 'execute']) {
      const res = await post({ step, request: runNow, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ refusal: { code: 'admin.ledger_unconfigured', changed: 'no' } });
    }
    expect(fn).not.toHaveBeenCalled();
    expect((await post({ step: 'reject', request: runNow, approvalId: 'appr_1' })).status).toBe(200);
  });
  it('a wrong phrase, a freeze, or a run with a margin on a run now is refused before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await post({ step: 'propose', request: runNow, confirm: 'RUN CONTROL' })).status).toBe(400);
    expect(
      (
        await post({
          step: 'propose',
          request: { kind: 'ledger.freeze', reason: 'reconciliation mismatch', version: 'v' },
          confirm: 'FREEZE LEDGER',
        })
      ).status,
    ).toBe(400);
    expect((await post({ step: 'propose', request: { ...runNow, margin: '30' }, confirm: PHRASE })).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
});
