import { describe, expect, it } from 'vitest';
import { QUANT_API_ENDPOINTS } from './quant-api-endpoints';

// The strategy API reference (J-algo-dev-14) names the procedures svc-quant serves a key, each under its scope. The same
// table is asserted on svc-quant's side (`QUANT_KEY_API`, services/svc-quant/src/key-api/key-api.test.ts), and the
// journey reads both through the running app.
describe('strategy API reference', () => {
  it('lists the procedures a key may call, with their scopes', () => {
    const listed = Object.fromEntries(QUANT_API_ENDPOINTS.filter((row) => row.procedure).map((row) => [row.procedure, row.scope]));
    expect(listed).toEqual({
      'studio.list': 'quant:read',
      'studio.get': 'quant:read',
      'backtest.history': 'quant:read',
      'backtest.result': 'quant:read',
      'backtest.report': 'quant:read',
      'backtest.start': 'quant:run',
    });
  });

  it('a query is a GET and a start is a POST', () => {
    for (const row of QUANT_API_ENDPOINTS.filter((r) => r.procedure))
      expect(row.method, row.procedure).toBe(row.procedure === 'backtest.start' ? 'POST' : 'GET');
  });

  it('names no deploy endpoint', () => {
    expect(
      QUANT_API_ENDPOINTS.filter((row) => /deploy/.test(row.path) || (row.path === '/api/v1/quant/live-runs' && row.method === 'POST')),
    ).toEqual([]);
  });
});
