import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { POST } from './route';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const post = (body: unknown) =>
  POST(new Request('https://admin.example/api/trade-ops/exports', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  auth.authorize.mockResolvedValue({
    session: { userId: 'op-a', accessToken: 'founder-session-token' },
    config: { origin: 'https://admin.example', edgeUrl: 'http://isolated-edge:4000' },
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('exports: chart controls audit (J-charts-desk-19 #4)', () => {
  it('asks svc-trade for one UTC day and writes each change with who and when', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        result: {
          data: {
            asOf: '2026-11-19T05:00:00.000Z',
            from: '2026-11-19T00:00:00.000Z',
            to: '2026-11-20T00:00:00.000Z',
            rowLimit: 1000,
            rows: [
              {
                id: '1',
                symbol: 'BTC/USDT',
                action: 'disable',
                fromSource: 'primary',
                toSource: 'primary',
                fromState: 'on',
                toState: 'disabled',
                version: '1',
                reason: 'TEST reason here',
                proposerId: 'op-a',
                approverId: 'op-b',
                executorId: 'op-a',
                approvalId: 'ap-1',
                at: '2026-11-19T02:00:00.000Z',
              },
            ],
          },
        },
      }),
    );
    const out = await (await post({ action: 'prepare', dataset: 'chart_controls_audit', day: '2026-11-19' })).json();
    expect(out.kind).toBe('ok');
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      from: '2026-11-19T00:00:00.000Z',
      to: '2026-11-20T00:00:00.000Z',
    });
    expect(out.data.rows[0]).toEqual([
      '2026-11-19T02:00:00.000Z',
      'BTC/USDT',
      'disable',
      'primary',
      'primary',
      'on',
      'disabled',
      'TEST reason here',
      'op-a',
      'op-b',
      'op-a',
      'ap-1',
      '1',
    ]);
  });

  it("shows svc-trade's refusal over the owner's row limit, with the limit", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            json: {
              message: "3 chart control changes match, over the owner's export row limit of 2",
              data: { cause: { code: 'trade.chart_feed.export_over_limit' } },
            },
          },
        },
        400,
      ),
    );
    const out = await (await post({ action: 'prepare', dataset: 'chart_controls_audit' })).json();
    expect(out).toMatchObject({ kind: 'refused', code: 'trade.chart_feed.export_over_limit' });
    expect(out.message).toContain('row limit of 2');
  });

  it('refuses a malformed day before any call', async () => {
    expect(await (await post({ action: 'prepare', dataset: 'chart_controls_audit', day: '19/11/2026' })).json()).toMatchObject({
      code: 'trade_ops.date_invalid',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
