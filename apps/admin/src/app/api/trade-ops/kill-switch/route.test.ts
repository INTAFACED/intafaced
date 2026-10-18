import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const fetchMock = vi.fn();

const approval = (status: string) => ({
  approvalId: 'approval-12345',
  actionType: 'matching.halt_all',
  targetService: 'svc-matching',
  targetId: 'halt_all',
  expectedVersion: '1',
  payloadHash: 'sha256:' + 'a'.repeat(64),
  requesterId: ME,
  approverId: status === 'PENDING' ? null : OTHER,
  policyVersion: 'matching-control-v1',
  createdAt: '2026-10-18T00:00:00.000Z',
  expiresAt: '2026-10-18T01:00:00.000Z',
  status,
  operationId: 'op-1',
});

beforeEach(() => {
  auth.authorize.mockResolvedValue({
    session: { userId: ME, accessToken: 'founder-session-token' },
    config: { origin: 'https://admin.example', edgeUrl: 'http://isolated-edge:4000' },
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  auth.authorize.mockReset();
});

const post = (body: unknown) =>
  POST(new Request('https://admin.example/api/trade-ops/kill-switch', { method: 'POST', body: JSON.stringify(body) }));

describe('trade desk kill switch route', () => {
  it('has no toggle: it answers trade_ops.bad_action and sends nothing to the edge', async () => {
    const res = await post({
      action: 'toggle',
      disabled: true,
      reason: 'incident 4471 runaway bot',
      confirmOperatorId: OTHER,
      approvalId: 'ap-1',
      operationId: 'op-1',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'trade_ops.bad_action' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps mass_cancel as a checked blocker that sends nothing', async () => {
    const cancel = await post({
      action: 'mass_cancel',
      scope: 'market',
      target: 'BTC/USDT',
      reason: 'cleanup after halt',
      confirmOperatorId: OTHER,
    });
    expect(cancel.status).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('halt_all without an approval id is refused here and sends nothing', async () => {
    const res = await post({ action: 'halt_all', step: 'run', confirmOperatorId: OTHER });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'trade_ops.approval_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('halt_all with an APPROVED approval calls the real svc-edge venue door with the approval and its operation id', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: { data: { json: approval('APPROVED') } } })).mockResolvedValueOnce(
      Response.json({
        outcome: 'accepted',
        audit: {
          at: '2026-10-18T01:00:00.000Z',
          action: 'matching.halt_all',
          marketId: null,
          requesterId: ME,
          approverId: OTHER,
          idempotencyKey: 'k',
        },
        upstream: { accepted: true },
      }),
    );
    const res = await post({ action: 'halt_all', step: 'run', approvalId: 'approval-12345' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { audit: { requesterId: ME, approverId: OTHER } } });
    const [url, init] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(url)).toBe('http://isolated-edge:4000/admin/trade-ops/matching/halt-all');
    expect(JSON.parse(String(init.body))).toMatchObject({ approvalId: 'approval-12345', operationId: 'op-1' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer founder-session-token');
  });

  it('a PENDING approval is shown as pending and nothing is sent to the venue door', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: { data: { json: approval('PENDING') } } }));
    const res = await post({ action: 'halt_all', step: 'run', approvalId: 'approval-12345' });
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'action_approval.pending' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows svc-edge's typed refusal as-is (matching_unconfigured naming the key)", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: { data: { json: approval('APPROVED') } } })).mockResolvedValueOnce(
      Response.json(
        {
          outcome: 'refused',
          error: 'MATCHING_URL is unpublished. This edge does not call matching and does not invent a book.',
          code: 'matching_unconfigured',
          key: 'MATCHING_URL',
        },
        { status: 503 },
      ),
    );
    const res = await post({ action: 'halt_all', step: 'run', approvalId: 'approval-12345' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      kind: 'refused',
      code: 'matching_unconfigured',
      message: expect.stringContaining('MATCHING_URL'),
    });
  });

  it('an upstream timeout is unknown, never accepted', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ result: { data: { json: approval('APPROVED') } } }))
      .mockResolvedValueOnce(
        Response.json(
          { outcome: 'unknown', code: 'matching_upstream_unknown', error: 'svc-matching did not answer before 5000ms' },
          { status: 504 },
        ),
      );
    const body = await (await post({ action: 'resume_all', step: 'run', approvalId: 'approval-12345' })).json();
    expect(body).toMatchObject({ kind: 'unknown' });
    expect(JSON.stringify(body)).not.toContain('"ok"');
  });

  it('propose files a matching.halt_all approval against svc-matching with the hash matching recomputes', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ result: { data: { json: approval('PENDING') } } }));
    const res = await post({ action: 'halt_all', step: 'propose' });
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { status: 'PENDING' } });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain('/api/identity/trpc/actionApproval.propose');
    expect(JSON.parse(String(init.body))).toMatchObject({
      actionType: 'matching.halt_all',
      targetService: 'svc-matching',
      targetId: 'halt_all',
      expectedVersion: '1',
    });
  });
});
