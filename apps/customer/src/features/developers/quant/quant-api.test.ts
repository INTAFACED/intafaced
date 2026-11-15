import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUANT_API_ENDPOINTS } from './quant-api-endpoints';

// The strategy API reference (J-algo-dev-14) names exactly the procedures svc-quant lets a key call, each under its scope.
const source = readFileSync(fileURLToPath(new URL('../../../../../../services/svc-quant/src/key-api/key-api.ts', import.meta.url)), 'utf8');
const table = source.slice(
  source.indexOf('export const QUANT_KEY_API'),
  source.indexOf('};', source.indexOf('export const QUANT_KEY_API')),
);
const served = Object.fromEntries([...table.matchAll(/'([a-z]+\.[a-zA-Z]+)': '(quant:[a-z]+)'/g)].map((m) => [m[1], m[2]]));

describe('strategy API reference', () => {
  it('lists every procedure svc-quant serves a key, with its scope, and no other', () => {
    expect(Object.keys(served).length).toBeGreaterThan(0);
    const listed = Object.fromEntries(QUANT_API_ENDPOINTS.filter((row) => row.procedure).map((row) => [row.procedure, row.scope]));
    expect(listed).toEqual(served);
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
