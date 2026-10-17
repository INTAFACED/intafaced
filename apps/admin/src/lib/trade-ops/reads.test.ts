import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEffectiveFees, readKillSwitchSnapshot } from './reads';

const fetchMock = vi.fn();
const original = { ...process.env };

beforeEach(() => {
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_OPERATOR_TOKEN = 'test-operator-token';
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  process.env = { ...original };
});

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const snapshot = { disabledModules: ['trade'], reasons: { trade: 'incident 4471' }, audit: [] };

describe('readKillSwitchSnapshot', () => {
  it('reads /admin/kill-switches with the operator token, never a founder session token', async () => {
    fetchMock.mockResolvedValue(reply(200, snapshot));
    const out = await readKillSwitchSnapshot();
    expect(out).toMatchObject({ kind: 'ok', data: { disabledModules: ['trade'] } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://isolated-edge:4000/admin/kill-switches');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-operator-token');
  });

  it('shows a refused door as refused, not as Open', async () => {
    fetchMock.mockResolvedValue(reply(403, { code: 'auth.insufficient_scope', error: 'admin:write required' }));
    const out = await readKillSwitchSnapshot();
    expect(out).toMatchObject({ kind: 'refused', status: 403, code: 'auth.insufficient_scope' });
  });

  it('shows a gateway error and a dropped wire as unknown', async () => {
    fetchMock.mockResolvedValueOnce(reply(504, { error: 'gateway timeout' }));
    expect((await readKillSwitchSnapshot()).kind).toBe('unknown');
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await readKillSwitchSnapshot()).kind).toBe('unknown');
  });

  it('shows an unconfigured console as refused and sends nothing', async () => {
    delete process.env.ADMIN_OPERATOR_TOKEN;
    const out = await readKillSwitchSnapshot();
    expect(out).toMatchObject({ kind: 'refused', code: 'admin.kill_unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('readEffectiveFees', () => {
  const ctx = {
    session: { accessToken: 'founder-token' },
    config: { edgeUrl: 'http://isolated-edge:4000' },
  } as unknown as Parameters<typeof readEffectiveFees>[0];

  it('reads /api/v1/admin/fees with the founder token and keeps bps as strings', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        source: 'TRADE_FEE_SCHEDULE',
        version: 'desk',
        markets: [
          {
            symbol: 'BTC/USDT',
            kind: 'spot',
            product: 'spot',
            charged: { makerBps: '8', takerBps: '10', makerRate: '0.0008', takerRate: '0.001' },
            refusal: null,
          },
        ],
      }),
    );
    const out = await readEffectiveFees(ctx);
    expect(out).toMatchObject({ kind: 'ok', data: { markets: [{ charged: { makerBps: '8', takerBps: '10' } }] } });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://isolated-edge:4000/api/v1/admin/fees');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer founder-token');
  });

  it('shows a blank schedule as the service refusal, never a number', async () => {
    fetchMock.mockResolvedValue(
      reply(503, {
        code: 'ExchangeNotAvailable',
        message: 'Trading fees are not available yet.',
        intafacedCode: 'trade.fee_schedule_blank',
      }),
    );
    expect(await readEffectiveFees(ctx)).toMatchObject({ kind: 'refused', status: 503, code: 'trade.fee_schedule_blank' });
  });

  it('refuses a body that is not the fee shape', async () => {
    fetchMock.mockResolvedValue(reply(200, { BTC: { maker: '0.001', taker: '0.002' } }));
    expect((await readEffectiveFees(ctx)).kind).toBe('refused');
  });
});
