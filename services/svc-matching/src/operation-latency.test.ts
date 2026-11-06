import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerHealth } from './health.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { OperationLatency, operationOf, registerOperationLatency } from './operation-latency.js';

const SECRET = 'matching-latency-router-secret-32ch!!';

async function mount() {
  const journal = new MemoryJournal();
  const engine = new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
  const app = Fastify({ logger: false });
  const latency = new OperationLatency(new Date(Date.now() - 60_000));
  registerOperationLatency(app, latency);
  registerHealth(app, 'svc-matching', engine, journal, latency);
  registerRoutes(app, engine, SECRET, {
    bodyBind: 'require',
    approvals: stubApprovalConsumer('ops-confirm'),
    operatorIds: new Set(['ops-1']),
  });
  await app.ready();
  return { app };
}

describe('operation latency on /health (J-cex-spot-20 #1)', () => {
  it('a fresh engine has timed nothing: counts 0 and no percentile, never 0 ms', async () => {
    const { app } = await mount();
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    for (const op of ['submit', 'cancel', 'depth']) {
      expect(body.metrics.operations[op]).toEqual({ count: 0, errors: 0, p50Ms: null, p99Ms: null, perMinute: '0' });
    }
    expect(Date.parse(body.metrics.startedAt)).toBeLessThan(Date.now());
  });

  it('times a depth read under its own operation, by route pattern, and not the health read itself', async () => {
    const { app } = await mount();
    await app.inject({ method: 'GET', url: '/markets/no-such-market/depth' });
    await app.inject({ method: 'GET', url: '/health' });
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.metrics.operations.depth.count).toBe(1);
    expect(body.metrics.operations.depth.p99Ms).toBeGreaterThan(0);
    expect(body.metrics.operations.submit.count).toBe(0);
    expect(Number(body.metrics.operations.depth.perMinute)).toBeGreaterThan(0);
  });

  it('classifies only the three order routes', () => {
    expect(operationOf('post', '/markets/:marketId/orders')).toBe('submit');
    expect(operationOf('DELETE', '/markets/:marketId/orders/:orderId')).toBe('cancel');
    expect(operationOf('GET', '/markets/:marketId/depth')).toBe('depth');
    expect(operationOf('GET', '/markets/:marketId/orders')).toBeNull();
    expect(operationOf('GET', undefined)).toBeNull();
  });

  it('reports the bucket bound holding each percentile, and 5xx replies as errors', () => {
    const l = new OperationLatency(new Date(0));
    for (let i = 0; i < 98; i++) l.observe('submit', 3, 200);
    l.observe('submit', 40, 200);
    l.observe('submit', 400, 503);
    const r = l.read(new Date(60_000)).operations.submit;
    expect(r).toMatchObject({ count: 100, errors: 1, p50Ms: 5, p99Ms: 50, perMinute: '100.00' });
  });

  it('a reply slower than the last bound has no finite percentile', () => {
    const l = new OperationLatency(new Date(0));
    l.observe('cancel', 20_000, 200);
    expect(l.read(new Date(60_000)).operations.cancel).toMatchObject({ count: 1, p50Ms: null, p99Ms: null });
  });
});
