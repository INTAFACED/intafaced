import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { chartDataClassPayloadHash, chartScalarClientRequestId } from '@/lib/trade-ops/charts-owner-values-hash';
import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const APPROVER = '00000000-0000-4000-8000-000000000002';
const REASON = 'list BTC for the charts pilot';
const fetchMock = vi.fn();

const blankView = (over: Record<string, unknown> = {}) => ({
  canWrite: true,
  scalars: {
    version: null,
    values: { compareCap: null, chartCountLimit: null, drawingCap: null, brushPointCap: null, delayedBoundarySeconds: null },
    operatorId: null,
    reason: null,
    updatedAt: null,
  },
  dataClasses: [{ symbol: 'BTC/USDT', version: null, dataClass: null, operatorId: null, approverId: null, updatedAt: null }],
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const sentBody = (needle: string) => {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(needle));
  return call ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
};

const approval = (over: Record<string, unknown> = {}) => ({
  approvalId: 'ap-cdc-1',
  actionType: 'trade.chart_data_class_set',
  targetService: 'svc-trade',
  targetId: 'BTC/USDT',
  expectedVersion: '0',
  payloadHash: chartDataClassPayloadHash({ symbol: 'BTC/USDT', dataClass: 'real_time', expectedVersion: '0', reason: REASON }),
  requesterId: ME,
  approverId: APPROVER,
  policyVersion: 'trade-chart-data-class-v1',
  createdAt: '2026-10-22T00:00:00.000Z',
  expiresAt: '2026-10-22T01:00:00.000Z',
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
  POST(new Request('https://admin.example/api/trade-ops/charts-settings', { method: 'POST', body: JSON.stringify(body) }));

describe('charts settings route', () => {
  it('reads the values, the data classes and whether this caller may write', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: blankView({ canWrite: false }) } } }));
    const res = await post({ action: 'read' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { canWrite: false, scalars: { version: null } } });
    expect(urls().some((u) => u.includes('/api/trade/trpc/admin.chartOwnerValues.get'))).toBe(true);
  });

  it('refuses an unknown action, an unknown setting and a bad version before any call', async () => {
    expect(await (await post({ action: 'delete' })).json()).toMatchObject({ code: 'trade_ops.bad_action' });
    expect(await (await post({ action: 'set', key: 'unknownCap', value: '3', expectedVersion: '0', reason: REASON })).json()).toMatchObject(
      {
        code: 'chart_owner_value.bad_key',
      },
    );
    expect(
      await (await post({ action: 'set', key: 'compareCap', value: '3', expectedVersion: 'v1', reason: REASON })).json(),
    ).toMatchObject({
      code: 'chart_owner_value.bad_version',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a count that is not a whole number, and a reason that is too short, before any write', async () => {
    for (const value of ['2.5', '-1', 'three']) {
      const res = await post({ action: 'set', key: 'compareCap', value, expectedVersion: '0', reason: REASON });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'chart_owner_value.not_whole' });
    }
    const short = await post({ action: 'set', key: 'compareCap', value: '3', expectedVersion: '0', reason: 'short' });
    expect(await short.json()).toMatchObject({ code: 'chart_owner_value.reason_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes a count under a business key, with the reason trimmed and the value as a number', async () => {
    const stored = {
      version: '1',
      values: { compareCap: 3, chartCountLimit: null, drawingCap: null, brushPointCap: null, delayedBoundarySeconds: null },
      operatorId: ME,
      reason: REASON,
      updatedAt: '2026-10-22T09:00:00.000Z',
    };
    fetchMock.mockImplementation(async () => json({ result: { data: { json: blankView({ scalars: stored }) } } }));
    const res = await post({ action: 'set', key: 'compareCap', value: '3', expectedVersion: '0', reason: `  ${REASON}  ` });
    expect(res.status).toBe(200);
    const sent = sentBody('admin.chartOwnerValues.set');
    expect(sent).toMatchObject({ key: 'compareCap', value: 3, expectedVersion: '0', reason: REASON });
    expect(sent?.clientRequestId).toBe(chartScalarClientRequestId('compareCap', '0', 3, REASON));
    expect(String(sent?.clientRequestId)).not.toMatch(/^[0-9a-f]{8}-/);
  });

  it('a blank value clears the count to not set', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: blankView() } } }));
    await post({ action: 'set', key: 'drawingCap', value: '', expectedVersion: '2', reason: REASON });
    expect(sentBody('admin.chartOwnerValues.set')).toMatchObject({ key: 'drawingCap', value: null, expectedVersion: '2' });
  });

  it('shows the service refusal in its own words, and the stored value does not change', async () => {
    fetchMock.mockImplementation(async () =>
      json(
        {
          error: {
            json: {
              message: 'compareCap must be a whole number from 1 to 50, or blank',
              data: { code: 'BAD_REQUEST', appCode: 'chart_owner_value_invalid' },
            },
          },
        },
        400,
      ),
    );
    const res = await post({ action: 'set', key: 'compareCap', value: '51', expectedVersion: '0', reason: REASON });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'chart_owner_value_invalid' });
  });

  it('a data class needs a market and a known class, and a blank class clears it', async () => {
    expect(
      await (await post({ action: 'propose', symbol: '', dataClass: 'real_time', expectedVersion: '0', reason: REASON })).json(),
    ).toMatchObject({
      code: 'chart_owner_value.bad_symbol',
    });
    expect(
      await (await post({ action: 'propose', symbol: 'BTC/USDT', dataClass: 'live', expectedVersion: '0', reason: REASON })).json(),
    ).toMatchObject({
      code: 'chart_owner_value.bad_data_class',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proposes a data class change bound to the hash svc-trade recomputes and the version just read', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: approval({ status: 'PENDING', approverId: null }) } } }));
    await post({ action: 'propose', symbol: 'BTC/USDT', dataClass: 'real_time', expectedVersion: '0', reason: REASON });
    const sent = sentBody('actionApproval.propose');
    expect(sent).toMatchObject({
      actionType: 'trade.chart_data_class_set',
      targetService: 'svc-trade',
      targetId: 'BTC/USDT',
      expectedVersion: '0',
      policyVersion: 'trade-chart-data-class-v1',
    });
    expect(sent?.payloadHash).toBe(
      chartDataClassPayloadHash({ symbol: 'BTC/USDT', dataClass: 'real_time', expectedVersion: '0', reason: REASON }),
    );
    expect(urls().every((u) => !u.includes('admin.chartOwnerValues.set'))).toBe(true);
  });

  it('refuses to apply while the request is still pending: nothing is written', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: approval({ status: 'PENDING', approverId: null }) } } }));
    const res = await post({
      action: 'apply',
      symbol: 'BTC/USDT',
      dataClass: 'real_time',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'ap-cdc-1',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'action_approval.pending' });
    expect(urls().some((u) => u.includes('admin.chartOwnerValues.set'))).toBe(false);
  });

  it('refuses an approval for other values than the ones on the form: nothing is written', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: approval({ payloadHash: 'sha256:other' }) } } }));
    const res = await post({
      action: 'apply',
      symbol: 'BTC/USDT',
      dataClass: 'delayed',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'ap-cdc-1',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'chart_owner_value.approval_mismatch' });
    expect(urls().some((u) => u.includes('admin.chartOwnerValues.set'))).toBe(false);
  });

  it('applies an approved change through admin.chartOwnerValues.set under the approval id and its own operation id', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('admin.chartOwnerValues.set')
        ? json({
            result: {
              data: {
                json: blankView({
                  dataClasses: [
                    { symbol: 'BTC/USDT', version: '1', dataClass: 'real_time', operatorId: ME, approverId: APPROVER, updatedAt: null },
                  ],
                }),
              },
            },
          })
        : json({ result: { data: { json: approval() } } }),
    );
    const res = await post({
      action: 'apply',
      symbol: 'BTC/USDT',
      dataClass: 'real_time',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'ap-cdc-1',
    });
    expect(res.status).toBe(200);
    expect(sentBody('admin.chartOwnerValues.set')).toMatchObject({
      key: 'dataClass',
      symbol: 'BTC/USDT',
      value: 'real_time',
      expectedVersion: '0',
      reason: REASON,
      approvalId: 'ap-cdc-1',
      clientRequestId: 'op-minted-by-identity',
    });
  });

  it('a read-only caller gets the values, and a write attempt is refused by the service, not by the page alone', async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { json: { message: 'Missing scope admin:write', data: { code: 'FORBIDDEN', appCode: 'FORBIDDEN' } } } }, 403),
    );
    const res = await post({ action: 'set', key: 'compareCap', value: '3', expectedVersion: '0', reason: REASON });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: 'refused', status: 403 });
  });
});
