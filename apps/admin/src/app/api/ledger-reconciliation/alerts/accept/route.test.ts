import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proposeInputFor } from '@/lib/desk/approval-hash';
import { confirmPhrase, decodePacket, type DeskRequest } from '@/lib/desk/approval-packet';
import { ALERT, FOUNDER, alertDetail, founderCtx, treasuryToken } from '@/lib/recon-alerts/fixtures.test-util';
import { evidenceHash } from '@/lib/recon-alerts/treasury';
import { POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: vi.fn(async () => null), adminBffSession: gate.session }));

const APPROVER = '88888888-8888-4888-8888-888888888888';
const HASH = evidenceHash(alertDetail().alert);
const accept: DeskRequest = {
  kind: 'ops.reconciliation_alert.accept',
  alertId: ALERT,
  evidenceHash: HASH,
  reason: 'TEST known rounding on the outside statement',
};
const blank = { ...accept, reason: '   ' } as DeskRequest;
const PHRASE = confirmPhrase(accept);
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/ledger-reconciliation/alerts/accept', {
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
  createdAt: '2026-10-29T12:00:00.000Z',
  expiresAt: '2026-10-29T12:10:00.000Z',
  status: 'PENDING',
});
const accepted = alertDetail({
  state: 'accepted',
  accepted: { requestedBy: FOUNDER, approvedBy: APPROVER, at: '2026-10-29T12:06:00.000Z', note: accept.reason, evidenceHash: HASH },
  version: 3,
});

const original = { ...process.env };
beforeEach(() => {
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = treasuryToken(FOUNDER);
  gate.session.mockResolvedValue(founderCtx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...original };
  gate.session.mockReset();
});

describe('accept a discrepancy: the two-founder steps', () => {
  it('propose binds the approval to svc-ops and the alert, as the founder, and hands back a packet', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ result: { data: approvalRow(accept) } }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'propose', request: accept, confirm: PHRASE });
    expect(res.status).toBe(200);
    const read = decodePacket((await res.json()).packet);
    expect(read.ok && read.packet.request).toEqual(accept);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/identity/trpc/actionApproval.propose');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      actionType: 'ops.reconciliation_alert.accept',
      targetService: 'svc-ops',
      targetId: `reconciliation-alert:${ALERT}`,
    });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('a blank note is refused by name before identity is asked, so no approval exists for it', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'propose', request: blank, confirm: PHRASE });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'ops.resolve_note_required', changed: 'no' } });
    expect(fn).not.toHaveBeenCalled();
  });

  it('run sends the approved acceptance on the treasury transport and reports who asked, who approved and the hash', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ result: { data: accepted } }));
    vi.stubGlobal('fetch', fn);
    const res = await post({ step: 'execute', request: accept, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.detail).toContain(`approved by ${APPROVER}`);
    expect(body.detail).toContain(HASH);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://isolated-edge:4000/api/ops/trpc/alerts.accept');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${treasuryToken(FOUNDER)}`);
    expect(JSON.parse(init!.body as string)).toEqual({
      alertId: ALERT,
      note: accept.reason,
      evidenceHash: HASH,
      approvalId: 'appr_1',
      operationId: 'op_1',
    });
  });

  it('svc-ops refusing changed evidence keeps its code, and an answer that is not the accepted alert is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'action_approval.wrong_action',
              code: -32603,
              data: { code: 'FORBIDDEN', httpStatus: 403, cause: { code: 'action_approval.wrong_action' } },
            },
          },
          { status: 403 },
        ),
      ),
    );
    const refused = await post({ step: 'execute', request: accept, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
    expect(await refused.json()).toMatchObject({ ok: false, refusal: { code: 'action_approval.wrong_action', changed: 'no' } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: { data: alertDetail() } })),
    );
    const odd = await post({ step: 'execute', request: accept, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
    expect(await odd.json()).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });

  it('a founder who does not hold the treasury credential proposes and runs nothing, but can approve', async () => {
    process.env.ADMIN_TREASURY_TOKEN = treasuryToken(APPROVER);
    const fn = vi.fn(async () => Response.json({ result: { data: { ...approvalRow(accept), status: 'APPROVED', approverId: FOUNDER } } }));
    vi.stubGlobal('fetch', fn);
    for (const step of ['propose', 'execute']) {
      const res = await post({ step, request: accept, confirm: PHRASE, approvalId: 'appr_1', operationId: 'op_1' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ refusal: { code: 'admin.treasury_holder_mismatch', changed: 'no' } });
    }
    expect(fn).not.toHaveBeenCalled();
    expect((await post({ step: 'approve', request: accept, confirm: PHRASE, approvalId: 'appr_1' })).status).toBe(200);
  });

  it('another desk’s request is not accepted here', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const hold: DeskRequest = { kind: 'ops.hold.confirm', holdNo: '3', userId: FOUNDER, assetId: 'USDT', reason: 'TEST fraud confirmed' };
    expect((await post({ step: 'propose', request: hold, confirm: confirmPhrase(hold) })).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
});
