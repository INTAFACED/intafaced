import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { miningHealthHonesty } from './health-honesty.js';
import { createMiningRequestHandler } from './http.js';

const SECRET = 'mining-http-test-edge-secret-32chars!';

let base = '';
let closeServer: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const handler = createMiningRequestHandler({
    health: () => miningHealthHonesty({ ledgerConfigured: false, pgConfigured: false, jobs: [] }),
    sql: null,
    internalSecret: SECRET,
    edgeSecret: SECRET,
    ledger: null,
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  closeServer = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await closeServer();
});

describe('mining HTTP routes', () => {
  it('keeps health, ready, submitShare, and the unknown-route refusal', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: 'svc-mining-pool' });
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, service: 'svc-mining-pool' });
    const submit = await fetch(`${base}/submitShare`, { method: 'POST', body: '{}' });
    expect(submit.status).toBe(401);
    expect(await submit.json()).toMatchObject({ accepted: false, code: 'mining.unauthenticated' });
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'mining.route_unavailable' });
  });

  it('refuses an unsigned tRPC call before a handler can answer pg_unavailable', async () => {
    const res = await fetch(`${base}/trpc/workers.mine?input=${encodeURIComponent(JSON.stringify({ windowMinutes: 60 }))}`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('UNAUTHORIZED');
    expect(body).not.toContain('mining.pg_unavailable');
    expect(body).not.toContain('mining.route_unavailable');
  });
});
