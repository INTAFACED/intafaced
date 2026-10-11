import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  MERCHANT_WATCH_METRICS_PATH,
  MERCHANT_WATCH_METRICS_PUBLISH_PATH,
  MERCHANT_WATCH_METRICS_REFRESH_PATH,
  registerMerchantWatchMetricsRoutes,
} from './merchant-watch-metrics-routes.js';
import type { MerchantWatchMetricPoint, MerchantWatchMetricsStore } from './merchant-watch-metrics-store.js';

const SECRET = 'a-merchant-watch-metrics-internal-secret-long-enough';

function serviceHeaders(body: string = ''): Record<string, string> {
  return {
    ...(body === '' ? {} : { 'content-type': 'application/json' }),
    ...serviceAuthHeadersForBody('svc-agents', SECRET, body),
  };
}

function memoryStore(projected: MerchantWatchMetricPoint[] = []): MerchantWatchMetricsStore {
  const points: MerchantWatchMetricPoint[] = [];
  return {
    async listPoints() {
      return points;
    },
    async publishPoint(point) {
      const idx = points.findIndex((p) => p.railId === point.railId);
      if (idx >= 0) points[idx] = point;
      else points.push(point);
    },
    async materializeProjectedMetrics() {
      for (const point of projected) {
        await this.publishPoint(point);
      }
      return projected.length;
    },
  };
}

describe('merchant watch metrics internal route', () => {
  it('refuses no_live_metrics with service auth when store absent', async () => {
    const app = Fastify();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: MERCHANT_WATCH_METRICS_PATH,
      headers: serviceHeaders(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_live_metrics' });
    await app.close();
  });

  it('refuses no_live_metrics when store is empty', async () => {
    const app = Fastify();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET, store: memoryStore() });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: MERCHANT_WATCH_METRICS_PATH,
      headers: serviceHeaders(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_live_metrics' });
    await app.close();
  });

  it('401s without service credentials', async () => {
    const app = Fastify();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: MERCHANT_WATCH_METRICS_PATH });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('publish refuses no_metrics_store when store absent', async () => {
    const app = Fastify();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET });
    await app.ready();

    const payload = JSON.stringify({
      railId: 'card',
      approvalRate: '0.91',
      attempts: 100,
      asOf: '2026-01-01T00:00:00.000Z',
      maxAgeMs: 60_000,
    });
    const res = await app.inject({
      method: 'POST',
      url: MERCHANT_WATCH_METRICS_PUBLISH_PATH,
      headers: serviceHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_metrics_store' });
    await app.close();
  });

  it('publish then GET returns operator-owned points', async () => {
    const app = Fastify();
    const store = memoryStore();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET, store });
    await app.ready();

    const publishBody = JSON.stringify({
      railId: 'card',
      approvalRate: '0.91',
      attempts: 100,
      asOf: '2026-01-01T00:00:00.000Z',
      maxAgeMs: 60_000,
    });
    const publish = await app.inject({
      method: 'POST',
      url: MERCHANT_WATCH_METRICS_PUBLISH_PATH,
      headers: serviceHeaders(publishBody),
      payload: publishBody,
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json()).toEqual({ ok: true });

    const res = await app.inject({
      method: 'GET',
      url: MERCHANT_WATCH_METRICS_PATH,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      points: [{ railId: 'card', approvalRate: '0.91', attempts: 100, asOf: '2026-01-01T00:00:00.000Z', maxAgeMs: 60_000 }],
    });
    await app.close();
  });

  it('publish refuses a junk approvalRate and does not store the point', async () => {
    const app = Fastify();
    const store = memoryStore();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET, store });
    await app.ready();

    const payload = JSON.stringify({
      railId: 'card',
      approvalRate: 'not-a-rate',
      attempts: 100,
      asOf: '2026-01-01T00:00:00.000Z',
      maxAgeMs: 60_000,
    });
    const publish = await app.inject({
      method: 'POST',
      url: MERCHANT_WATCH_METRICS_PUBLISH_PATH,
      headers: serviceHeaders(payload),
      payload,
    });
    expect(publish.statusCode).toBe(400);
    expect(publish.json()).toEqual({ ok: false, reason: 'invalid_publish_body' });

    const res = await app.inject({
      method: 'GET',
      url: MERCHANT_WATCH_METRICS_PATH,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_live_metrics' });
    await app.close();
  });

  it('publish refuses a negative attempts and does not store the point', async () => {
    const app = Fastify();
    const store = memoryStore();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET, store });
    await app.ready();

    const payload = JSON.stringify({
      railId: 'card',
      approvalRate: '0.91',
      attempts: -1,
      asOf: '2026-01-01T00:00:00.000Z',
      maxAgeMs: 60_000,
    });
    const publish = await app.inject({
      method: 'POST',
      url: MERCHANT_WATCH_METRICS_PUBLISH_PATH,
      headers: serviceHeaders(payload),
      payload,
    });
    expect(publish.statusCode).toBe(400);
    expect(publish.json()).toEqual({ ok: false, reason: 'invalid_publish_body' });

    const res = await app.inject({
      method: 'GET',
      url: MERCHANT_WATCH_METRICS_PATH,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_live_metrics' });
    await app.close();
  });

  it('publish refuses a non-finite attempts and does not store the point', async () => {
    const app = Fastify();
    const store = memoryStore();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET, store });
    await app.ready();

    // JSON has no Infinity token. 1e309 parses as Infinity and must not be stored.
    const payload = '{"railId":"card","approvalRate":"0.91","attempts":1e309,"asOf":"2026-01-01T00:00:00.000Z","maxAgeMs":60000}';
    const publish = await app.inject({
      method: 'POST',
      url: MERCHANT_WATCH_METRICS_PUBLISH_PATH,
      headers: serviceHeaders(payload),
      payload,
    });
    expect(publish.statusCode).toBe(400);
    expect(publish.json()).toEqual({ ok: false, reason: 'invalid_publish_body' });

    const res = await app.inject({
      method: 'GET',
      url: MERCHANT_WATCH_METRICS_PATH,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_live_metrics' });
    await app.close();
  });

  it('publish refuses a junk asOf and does not store the point', async () => {
    const app = Fastify();
    const store = memoryStore();
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET, store });
    await app.ready();

    const payload = JSON.stringify({
      railId: 'card',
      approvalRate: '0.91',
      attempts: 100,
      asOf: 'not-a-timestamp',
      maxAgeMs: 60_000,
    });
    const publish = await app.inject({
      method: 'POST',
      url: MERCHANT_WATCH_METRICS_PUBLISH_PATH,
      headers: serviceHeaders(payload),
      payload,
    });
    expect(publish.statusCode).toBe(400);
    expect(publish.json()).toEqual({ ok: false, reason: 'invalid_publish_body' });

    const res = await app.inject({
      method: 'GET',
      url: MERCHANT_WATCH_METRICS_PATH,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_live_metrics' });
    await app.close();
  });

  it('refresh materializes projected metrics then GET succeeds', async () => {
    const projected = [{ railId: 'card', approvalRate: '0.91', attempts: 100, asOf: '2026-01-01T00:00:00.000Z', maxAgeMs: 60_000 }];
    const app = Fastify();
    const store = memoryStore(projected);
    registerMerchantWatchMetricsRoutes(app, { internalSecret: SECRET, store });
    await app.ready();

    const refresh = await app.inject({
      method: 'POST',
      url: MERCHANT_WATCH_METRICS_REFRESH_PATH,
      headers: serviceHeaders(),
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toEqual({ ok: true, materialized: 1 });

    const res = await app.inject({
      method: 'GET',
      url: MERCHANT_WATCH_METRICS_PATH,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, points: projected });
    await app.close();
  });
});
