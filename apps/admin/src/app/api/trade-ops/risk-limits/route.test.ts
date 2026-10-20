import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { riskSetPayloadHash } from '@/lib/trade-ops/risk-set-hash';
import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const MARKET = 'a1b2c3d4-0000-4000-8000-000000000001';
const fetchMock = vi.fn();

const current = (version: string, over: Record<string, unknown> = {}) => ({
  marketId: MARKET,
  version,
  collar: null,
  fatFinger: null,
  slippageCap: null,
  throttle: null,
  circuitBreaker: null,
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const REASON = 'tighten after incident 4471';
const values = { collar: '0.05', fatFinger: '', slippageCap: '100', throttle: '', circuitBreaker: '' };

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
  POST(new Request('https://admin.example/api/trade-ops/risk-limits', { method: 'POST', body: JSON.stringify(body) }));

describe('risk limits route', () => {
  it('refuses a bad market before any call', async () => {
    const res = await post({ action: 'read', market: 'BTC/USDT' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'trade_ops.risk_bad_market' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the current limits and the history, and shows an unset limit as null', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('admin.risk.history')
        ? json({ result: { data: { json: [] } } })
        : json({ result: { data: { json: current('0') } } }),
    );
    const res = await post({ action: 'read', market: MARKET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'ok', data: { current: { version: '0', collar: null }, history: [] } });
    expect(urls().some((u) => u.includes('/api/trade/trpc/admin.risk.get'))).toBe(true);
  });

  it('refuses a body that is not the shape it expects instead of showing half of it', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: { marketId: MARKET, version: 'x' } } } }));
    const res = await post({ action: 'read', market: MARKET });
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'trade_ops.unexpected_shape' });
  });

  it('proposes with the hash svc-trade will recompute, bound to the version just read', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('actionApproval.propose')
        ? json({ result: { data: { json: { approvalId: 'ap-1', status: 'PENDING' } } } })
        : json({ result: { data: { json: current('2') } } }),
    );
    await post({ action: 'propose', market: MARKET, values, reason: REASON, expectedVersion: '2' });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('actionApproval.propose'));
    expect(call).toBeDefined();
    const sent = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({ actionType: 'trade.risk_set', targetService: 'svc-trade', targetId: MARKET, expectedVersion: '2' });
    expect(sent.payloadHash).toBe(
      riskSetPayloadHash({
        market: MARKET,
        limits: { collar: '0.05', fatFinger: null, slippageCap: '100', throttle: null, circuitBreaker: null },
        expectedVersion: '2',
        reason: REASON,
      }),
    );
  });

  it('refuses a stale form: nothing is proposed or written', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: current('3') } } }));
    for (const action of ['propose', 'apply']) {
      const res = await post({ action, market: MARKET, values, reason: REASON, expectedVersion: '2', approvalId: 'ap-1' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ kind: 'refused', code: 'risk_limit_stale' });
    }
    expect(urls().every((u) => u.includes('admin.risk.get'))).toBe(true);
  });

  it('refuses a change with no change, a short reason and a missing approval id, and sends no write', async () => {
    fetchMock.mockImplementation(async () => json({ result: { data: { json: current('2', { collar: '0.05', slippageCap: '100' }) } } }));
    expect(await (await post({ action: 'propose', market: MARKET, values, reason: REASON })).json()).toMatchObject({
      code: 'risk_limits.no_change',
    });
    const changed = { ...values, throttle: '30' };
    expect(await (await post({ action: 'propose', market: MARKET, values: changed, reason: 'short' })).json()).toMatchObject({
      code: 'risk_limits.bad_reason',
    });
    expect(await (await post({ action: 'apply', market: MARKET, values: changed, reason: REASON })).json()).toMatchObject({
      code: 'trade_ops.approval_id_invalid',
    });
    expect(urls().every((u) => u.includes('admin.risk.get'))).toBe(true);
  });

  it('applies through admin.risk.set with the approval id, and passes the service refusal through in its words', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('admin.risk.set')
        ? json(
            { error: { json: { message: 'approval was already consumed', data: { code: 'BAD_REQUEST', appCode: 'approval_reused' } } } },
            400,
          )
        : json({ result: { data: { json: current('2') } } }),
    );
    const res = await post({ action: 'apply', market: MARKET, values, reason: REASON, approvalId: 'ap-1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'approval_reused' });
    const write = fetchMock.mock.calls.find((c) => String(c[0]).includes('admin.risk.set'));
    expect(JSON.parse((write![1] as RequestInit).body as string)).toMatchObject({
      market: MARKET,
      expectedVersion: '2',
      approvalId: 'ap-1',
      limits: { collar: '0.05', fatFinger: null, slippageCap: '100' },
    });
  });
});
