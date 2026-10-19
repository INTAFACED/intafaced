/**
 * S2S merchant approval-rate samples for svc-agents merchant watch.
 *
 * Empty store = honest `no_live_metrics`. Operator publishes real samples via
 * POST publish — never seeded with fabricated approval rates.
 */

import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_SERVICE_BODY_BIND_MODE,
  retainRawBody,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceVerifier,
  type ServiceBodyBindMode,
} from '@intafaced/contracts';
import type { MerchantWatchMetricsStore } from './merchant-watch-metrics-store.js';

export const MERCHANT_WATCH_METRICS_PATH = '/internal/agents/merchant-watch-metrics' as const;
export const MERCHANT_WATCH_METRICS_PUBLISH_PATH = '/internal/agents/merchant-watch-metrics/publish' as const;
export const MERCHANT_WATCH_METRICS_REFRESH_PATH = '/internal/agents/merchant-watch-metrics/refresh' as const;

export type MerchantWatchMetricsRefuse = {
  readonly ok: false;
  readonly reason: 'no_live_metrics';
};

export type MerchantWatchMetricsPublishRefuse = {
  readonly ok: false;
  readonly reason: 'no_metrics_store' | 'invalid_publish_body';
};

export type MerchantWatchMetricsRefreshRefuse = {
  readonly ok: false;
  readonly reason: 'no_metrics_store' | 'no_live_metrics';
};

export type MerchantWatchMetricsRefreshOk = {
  readonly ok: true;
  readonly materialized: number;
};

export type MerchantWatchMetricsPublishOk = {
  readonly ok: true;
};

export type MerchantWatchMetricsOk = {
  readonly ok: true;
  readonly points: readonly {
    readonly railId: string;
    readonly approvalRate: string | null;
    readonly attempts: number | null;
    readonly asOf: string;
    readonly maxAgeMs: number;
  }[];
};

export type MerchantWatchMetricsBody = MerchantWatchMetricsRefuse | MerchantWatchMetricsOk;

export type MerchantWatchMetricsRouteDeps = {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly store?: MerchantWatchMetricsStore;
  /** `INTERNAL_SERVICE_BODY_BIND`. Isolated tests default to accept-both. */
  readonly bodyBind?: ServiceBodyBindMode;
  /**
   * Isolated tests install retention. Production index already called
   * `retainRawBody` on the same Fastify instance.
   */
  readonly installRawBody?: boolean;
};

/** Digits with an optional fraction. Same shape as a non-negative decimal string. */
const NON_NEGATIVE_DECIMAL = /^\d+(\.\d+)?$/;

function parsePublishBody(raw: unknown): MerchantWatchMetricsOk['points'][number] | null {
  if (raw === null || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.railId !== 'string' || !body.railId.trim()) return null;
  if (body.approvalRate !== null && typeof body.approvalRate !== 'string') return null;
  if (typeof body.approvalRate === 'string' && !NON_NEGATIVE_DECIMAL.test(body.approvalRate)) return null;
  if (body.attempts !== null && typeof body.attempts !== 'number') return null;
  if (typeof body.attempts === 'number' && (!Number.isInteger(body.attempts) || body.attempts < 0)) return null;
  if (typeof body.asOf !== 'string' || !Number.isFinite(Date.parse(body.asOf))) return null;
  if (typeof body.maxAgeMs !== 'number' || !Number.isFinite(body.maxAgeMs) || body.maxAgeMs < 0) return null;
  return {
    railId: body.railId.trim(),
    approvalRate: body.approvalRate,
    attempts: body.attempts,
    asOf: body.asOf,
    maxAgeMs: body.maxAgeMs,
  };
}

export function registerMerchantWatchMetricsRoutes(app: FastifyInstance, deps: MerchantWatchMetricsRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const mode = deps.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;
  const authorised = (req: Parameters<typeof verifyServiceRequest>[0]): boolean =>
    verifyServiceRequest(req, { verifier: deps.s2s?.verifier, mode: deps.s2s?.mode, legacySecret: deps.internalSecret, bodyBindMode: mode })
      .service !== null;

  app.get(MERCHANT_WATCH_METRICS_PATH, async (req, reply) => {
    if (!authorised(req)) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    if (!deps.store) {
      const body: MerchantWatchMetricsRefuse = { ok: false, reason: 'no_live_metrics' };
      return reply.code(503).send(body);
    }
    const points = await deps.store.listPoints();
    if (points.length === 0) {
      const body: MerchantWatchMetricsRefuse = { ok: false, reason: 'no_live_metrics' };
      return reply.code(503).send(body);
    }
    const body: MerchantWatchMetricsOk = { ok: true, points };
    return reply.send(body);
  });

  app.post(MERCHANT_WATCH_METRICS_PUBLISH_PATH, async (req, reply) => {
    if (!authorised(req)) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    if (!deps.store) {
      const body: MerchantWatchMetricsPublishRefuse = { ok: false, reason: 'no_metrics_store' };
      return reply.code(503).send(body);
    }
    const point = parsePublishBody(req.body);
    if (!point) {
      const body: MerchantWatchMetricsPublishRefuse = { ok: false, reason: 'invalid_publish_body' };
      return reply.code(400).send(body);
    }
    await deps.store.publishPoint(point);
    const body: MerchantWatchMetricsPublishOk = { ok: true };
    return reply.send(body);
  });

  app.post(MERCHANT_WATCH_METRICS_REFRESH_PATH, async (req, reply) => {
    if (!authorised(req)) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    if (!deps.store) {
      const body: MerchantWatchMetricsRefreshRefuse = { ok: false, reason: 'no_metrics_store' };
      return reply.code(503).send(body);
    }
    const materialized = await deps.store.materializeProjectedMetrics();
    if (materialized === 0) {
      const body: MerchantWatchMetricsRefreshRefuse = { ok: false, reason: 'no_live_metrics' };
      return reply.code(503).send(body);
    }
    const body: MerchantWatchMetricsRefreshOk = { ok: true, materialized };
    return reply.send(body);
  });
}
