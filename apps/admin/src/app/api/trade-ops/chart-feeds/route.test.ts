import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const APPROVER = '00000000-0000-4000-8000-000000000002';
const REASON = 'TEST: primary tape gap, switch to the backup';
const HASH = `sha256:${'b'.repeat(64)}`;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

const prepared = {
  actionType: 'trade.chart_feed_control',
  targetService: 'svc-trade',
  targetId: 'BTC/USDT',
  symbol: 'BTC/USDT',
  action: { kind: 'switch_source', to: 'test-backup' },
  expectedVersion: '0',
  reason: REASON,
  from: { source: 'primary', state: 'on' },
  to: { source: 'test-backup', state: 'on' },
  payloadHash: HASH,
};
const approval = (over: Record<string, unknown> = {}) => ({
  approvalId: 'ap-1',
  actionType: 'trade.chart_feed_control',
  targetService: 'svc-trade',
  targetId: 'BTC/USDT',
  expectedVersion: '0',
  payloadHash: HASH,
  requesterId: ME,
  approverId: APPROVER,
  policyVersion: 'trade-chart-feed-control-v1',
  createdAt: '2026-11-19T00:00:00.000Z',
  expiresAt: '2026-11-19T01:00:00.000Z',
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
  POST(new Request('https://admin.example/api/trade-ops/chart-feeds', { method: 'POST', body: JSON.stringify(body) }));
const change = { symbol: 'BTC/USDT', kind: 'switch_source', to: 'test-backup', expectedVersion: '0', reason: REASON };

describe('chart feeds route', () => {
  it('propose: svc-trade checks the change and answers the hash, then identity files it bound to that hash', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ result: { data: prepared } }))
      .mockResolvedValueOnce(json({ result: { data: approval({ status: 'PENDING', approverId: null }) } }));
    const res = await post({ action: 'propose', ...change });
    const out = await res.json();
    expect(out.kind).toBe('ok');
    expect(urls()[0]).toContain('/api/trade/trpc/admin.chartFeedControls.prepare');
    const filed = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(filed).toMatchObject({ actionType: 'trade.chart_feed_control', targetId: 'BTC/USDT', payloadHash: HASH, expectedVersion: '0' });
  });

  it('propose: a blank fallback list refused by svc-trade files nothing', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            json: { message: 'not set', data: { code: 'BAD_REQUEST', cause: { code: 'trade.chart_feed.fallback_sources_unset' } } },
          },
        },
        400,
      ),
    );
    const out = await (await post({ action: 'propose', ...change })).json();
    expect(out).toMatchObject({ kind: 'refused', code: 'trade.chart_feed.fallback_sources_unset' });
    expect(urls()).toHaveLength(1);
  });

  it('apply: a pending request is refused before svc-trade is called', async () => {
    fetchMock.mockResolvedValueOnce(json({ result: { data: approval({ status: 'PENDING', approverId: null }) } }));
    const out = await (await post({ action: 'apply', ...change, approvalId: 'ap-1' })).json();
    expect(out).toMatchObject({ kind: 'refused', code: 'action_approval.pending' });
    expect(urls().some((u) => u.includes('admin.chartFeedControls.run'))).toBe(false);
  });

  it('apply: an approval for another market is refused; an approved one runs under its operation id', async () => {
    fetchMock.mockResolvedValueOnce(json({ result: { data: approval({ targetId: 'ETH/USDT' }) } }));
    expect(await (await post({ action: 'apply', ...change, approvalId: 'ap-1' })).json()).toMatchObject({
      code: 'chart_feed.approval_mismatch',
    });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ result: { data: approval() } })).mockResolvedValueOnce(
      json({
        result: {
          data: {
            market: {
              symbol: 'BTC/USDT',
              test: false,
              source: 'test-backup',
              state: 'on',
              version: '1',
              delistedAt: null,
              updatedAt: '2026-11-19T00:00:00.000Z',
            },
            control: {
              id: '1',
              symbol: 'BTC/USDT',
              action: 'switch_source',
              fromSource: 'primary',
              toSource: 'test-backup',
              fromState: 'on',
              toState: 'on',
              version: '1',
              reason: REASON,
              proposerId: ME,
              approverId: APPROVER,
              executorId: ME,
              approvalId: 'ap-1',
              at: '2026-11-19T00:00:00.000Z',
            },
          },
        },
      }),
    );
    const out = await (await post({ action: 'apply', ...change, approvalId: 'ap-1' })).json();
    expect(out.kind).toBe('ok');
    const sent = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(sent).toMatchObject({
      approvalId: 'ap-1',
      operationId: 'op-minted-by-identity',
      action: { kind: 'switch_source', to: 'test-backup' },
    });
  });

  it('refuses a short reason or an unknown change before any call', async () => {
    expect(await (await post({ action: 'propose', ...change, reason: 'short' })).json()).toMatchObject({
      code: 'chart_feed.reason_required',
    });
    expect(await (await post({ action: 'propose', ...change, kind: 'halt' })).json()).toMatchObject({ code: 'chart_feed.bad_action' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
