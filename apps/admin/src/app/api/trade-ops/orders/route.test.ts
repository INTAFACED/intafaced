import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { bustPayloadHash } from '@/lib/trade-ops/bust-hash';
import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const ORDER = '0b6c3d0e-9f1a-4c2b-8d3e-112233445566';
const REASON = 'TEST customer reported a wrong fill';
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const sentBody = (needle: string) => {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(needle));
  return call ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
};
const approval = (over: Record<string, unknown> = {}) => ({
  approvalId: 'ap-bust-1',
  actionType: 'trade.bust',
  targetService: 'svc-trade',
  targetId: ORDER,
  expectedVersion: '1',
  payloadHash: bustPayloadHash({ orderId: ORDER, expectedVersion: '1', reason: REASON }),
  requesterId: ME,
  approverId: OTHER,
  policyVersion: 'trade-bust-v1',
  createdAt: '2026-11-06T00:00:00.000Z',
  expiresAt: '2026-11-06T01:00:00.000Z',
  status: 'APPROVED',
  operationId: 'op-minted-by-identity',
  ...over,
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
  POST(new Request('https://admin.example/api/trade-ops/orders', { method: 'POST', body: JSON.stringify(body) }));

describe('orders route: the reconcile sweep (J-cex-spot-18 #3)', () => {
  it('sends one run under the page’s request id and the reason, and returns the service’s counts', async () => {
    const counts = { checked: 4, released: 1, releasedOrderIds: [ORDER], failedClosedOrderIds: [], unreadableOrderIds: [], ranAt: 'x' };
    fetchMock.mockImplementation(async () => json({ result: { data: { json: counts } } }));
    const res = await post({ action: 'sweep', clientRequestId: 'sweep:abc', reason: REASON });
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { checked: 4, released: 1, releasedOrderIds: [ORDER] } });
    expect(urls()).toEqual([expect.stringContaining('/api/trade/trpc/admin.orders.startReconcileSweep')]);
    expect(sentBody('startReconcileSweep')).toEqual({ clientRequestId: 'sweep:abc', reason: REASON });
  });

  it('passes the service refusal through as it came, and refuses a short reason or no request id before any call', async () => {
    fetchMock.mockImplementation(async () =>
      json(
        { error: { json: { message: 'not set', data: { code: 'BAD_REQUEST', cause: { code: 'reconcile_sweep_unconfigured' } } } } },
        400,
      ),
    );
    expect(await (await post({ action: 'sweep', clientRequestId: 'sweep:a', reason: REASON })).json()).toMatchObject({
      kind: 'refused',
      code: 'reconcile_sweep_unconfigured',
    });
    fetchMock.mockReset();
    expect(await (await post({ action: 'sweep', clientRequestId: 'sweep:a', reason: 'short' })).json()).toMatchObject({
      code: 'trade_ops.reason_too_short',
    });
    expect(await (await post({ action: 'sweep', reason: REASON })).json()).toMatchObject({ code: 'trade_ops.request_id_invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('orders route: the trade bust (J-cex-spot-18 #4)', () => {
  it('proposes trade.bust bound to the fill count and the reason', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: approval({ status: 'PENDING', approverId: null }) } } }));
    const res = await post({ action: 'bust_propose', orderId: ORDER, expectedVersion: '1', reason: REASON });
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { approvalId: 'ap-bust-1' } });
    expect(sentBody('actionApproval.propose')).toMatchObject({
      actionType: 'trade.bust',
      targetService: 'svc-trade',
      targetId: ORDER,
      expectedVersion: '1',
      payloadHash: bustPayloadHash({ orderId: ORDER, expectedVersion: '1', reason: REASON }),
    });
  });

  it('carries out an APPROVED bust under the approval’s own operation id, and shows the service’s typed blocker', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('actionApproval.get')
        ? json({ result: { data: { json: approval() } } })
        : json(
            {
              error: {
                json: { message: 'no recipe', data: { code: 'BAD_REQUEST', cause: { code: 'trade_bust_recipe_missing' } } },
              },
            },
            400,
          ),
    );
    const res = await post({ action: 'bust', orderId: ORDER, approvalId: 'ap-bust-1', reason: REASON });
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'trade_bust_recipe_missing' });
    expect(sentBody('admin.orders.bust')).toEqual({
      orderId: ORDER,
      approvalId: 'ap-bust-1',
      clientRequestId: 'op-minted-by-identity',
      reason: REASON,
    });
  });

  it('sends nothing to svc-trade while the request still waits for a second operator', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: approval({ status: 'PENDING', approverId: null }) } } }));
    expect(await (await post({ action: 'bust', orderId: ORDER, approvalId: 'ap-bust-1', reason: REASON })).json()).toMatchObject({
      code: 'action_approval.pending',
    });
    expect(urls().some((u) => u.includes('admin.orders.bust'))).toBe(false);
  });

  it('refuses a bad order id, a missing fill count and a short reason before any call', async () => {
    expect(
      await (await post({ action: 'bust_propose', orderId: 'not-a-uuid', expectedVersion: '1', reason: REASON })).json(),
    ).toMatchObject({
      code: 'trade_ops.orders_bad_id',
    });
    expect(await (await post({ action: 'bust_propose', orderId: ORDER, reason: REASON })).json()).toMatchObject({
      code: 'trade_ops.bust_version_invalid',
    });
    expect(await (await post({ action: 'bust', orderId: ORDER, approvalId: 'a', reason: 'short' })).json()).toMatchObject({
      code: 'trade_ops.reason_too_short',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
