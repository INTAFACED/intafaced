import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../../../shared/api';
import { NOT_MINE, createSettingsBMock, mockContext, refuse } from './b-mock.mjs';
import { settingsBApi, type SettingsBApi } from './b-client';

const USER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-17T04:00:00.000Z');

/** The real client against the stand-in with no browser: each request is handed to the mock as a route. */
function clientFor(scenario = 'active', role = 'owner'): { api: SettingsBApi; ctx: ReturnType<typeof mockContext> } {
  const ctx = mockContext(scenario, NOW, { role });
  const mock = createSettingsBMock(ctx);
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    let out = { status: 500, body: '' };
    const href = new URL(String(url), 'http://stand-in.test');
    const procedure = decodeURIComponent(href.pathname.split('/trpc/')[1] ?? '');
    const method = init?.method ?? 'GET';
    const input =
      method === 'GET' ? (JSON.parse(href.searchParams.get('input') ?? 'null') ?? {}) : init?.body ? JSON.parse(String(init.body)) : {};
    const route = {
      fulfill: async (r: { status?: number; body: string }) => {
        out = { status: r.status ?? 200, body: r.body };
      },
    };
    const answered = await mock.handle(procedure, input, route);
    if (answered === NOT_MINE) await refuse(route, 404, '', `No procedure ${procedure}`);
    return new Response(out.body, { status: out.status });
  };
  return { api: settingsBApi(createApiClient({ fetch: fetcher as typeof fetch }), USER), ctx };
}

const ID = 'f1000000-0000-4000-8000-000000000001';
const q = { merchantId: MERCHANT, from: '2026-09-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', bucket: 'day' as const };
type Call = (api: SettingsBApi) => Promise<{ ok: boolean }>;
const calls: Record<string, Call> = {
  keysList: (a) => a.keysList(),
  keyCreate: (a) => a.keyCreate({ name: 'TEST', scopes: ['pay:read'] }),
  keyRevoke: (a) => a.keyRevoke('TEST-key-1'),
  signingSet: (a) => a.signingSet('TEST-key-1', true, false),
  signingRotate: async (a) => {
    await a.signingSet('TEST-key-1', true, false);
    return a.signingRotate('TEST-key-1');
  },
  ipsBind: (a) => a.ipsBind('TEST-key-1', ['203.0.113.10']),
  ipsUnbind: (a) => a.ipsUnbind('TEST-key-1', '203.0.113.10'),
  endpointsList: (a) => a.endpointsList(undefined, '', ''),
  endpointCreate: (a) => a.endpointCreate('https://receiver.example/new'),
  endpointUpdate: (a) => a.endpointUpdate('TEST-endpoint-1', 'https://receiver.example/other'),
  endpointDisable: (a) => a.endpointDisable('TEST-endpoint-1'),
  endpointRotate: (a) => a.endpointRotate('TEST-endpoint-1', ID),
  deliveriesList: (a) => a.deliveriesList(undefined, {}),
  deliveryRetry: async (a) => {
    const failed = await a.deliveriesList(undefined, { status: 'failed' });
    return a.deliveryRetry(failed.ok ? failed.data.items[0]!.id : 'none', ID);
  },
  webhookHealth: (a) => a.webhookHealth(),
  reportJobs: (a) => a.reportJobs(undefined, {}),
  reportRequest: (a) => a.reportRequest({ requestId: ID, kind: 'fees', filters: {} }),
  reportDownload: (a) => a.reportDownload(ID),
  reportDelete: (a) => a.reportDelete(ID),
  analyticsVolume: (a) => a.analyticsVolume(q),
  analyticsFees: (a) => a.analyticsFees({ ...q, bucket: 'week' }),
};
// reportPeople reads the team list, which the shared stand-in answers; analyticsDailySeries reads the shared metrics series.
const sharedElsewhere = {
  reportPeople: 'answered by the shared team stand-in',
  analyticsDailySeries: 'answered by the shared metrics stand-in',
};

describe('the developers, reports and analytics client against the stand-in', () => {
  it.each(Object.entries(calls))('%s parses what the stand-in sends', async (_name, call) => {
    const { api } = clientFor();
    const result = await call(api);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
  it('covers every client method, or says who answers it', () => {
    const { api } = clientFor();
    const missing = Object.keys(api).filter((name) => !(name in calls) && !(name in sharedElsewhere));
    expect(missing).toEqual([]);
  });
  it('shows a secret only on the first rotate of a request id', async () => {
    const { api } = clientFor();
    const first = await api.endpointRotate('TEST-endpoint-1', ID);
    const again = await api.endpointRotate('TEST-endpoint-1', ID);
    expect(first.ok && first.data.rotated && first.data.secret).toBeTruthy();
    expect(again.ok && again.data.rotated).toBe(false);
    expect(again.ok && again.data.secret).toBeNull();
  });
  it('lists nothing for an account with no activity', async () => {
    const { api } = clientFor('quiet');
    const keys = await api.keysList();
    const hooks = await api.endpointsList(undefined, '', '');
    expect(keys.ok && keys.data).toEqual([]);
    expect(hooks.ok && hooks.data.items).toEqual([]);
  });
  it('refuses a change to a webhook for a role that may only read', async () => {
    const { api } = clientFor('active', 'viewer');
    const result = await api.endpointCreate('https://receiver.example/new');
    expect(result.ok).toBe(false);
  });
  it('keeps the exact decimal strings the service sent', async () => {
    const { api } = clientFor();
    const fees = await api.analyticsFees(q);
    expect(fees.ok && fees.data.items.every((i) => /^\d+(\.\d+)?$/.test(i.fees))).toBe(true);
  });
  it('sends the filters it was given to the service', async () => {
    const { api } = clientFor();
    const failed = await api.deliveriesList(undefined, { status: 'failed', endpointId: 'TEST-endpoint-1' });
    expect(failed.ok && failed.data.items.every((d) => d.status === 'failed' && d.endpointId === 'TEST-endpoint-1')).toBe(true);
  });
});
