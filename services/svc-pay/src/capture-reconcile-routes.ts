/**
 * POST /internal/jobs/reconcile-authorized-captures
 *
 * External cron, same shape as the subscription due pass: its own module so a
 * test can hit it, service credentials required, no second copy of the handler
 * in index.ts. Not a setInterval — N replicas would each run a pass.
 *
 * The flag is checked inside the job. `off` refuses and moves nothing.
 */

import type { FastifyInstance } from 'fastify';
import { rawBodyOf, retainRawBody, verifyServiceHeaders } from '@intafaced/contracts';
import type { CaptureReconcileCursor, CaptureReconcileMode } from './capture-reconcile.js';
import { PayError, type PayService } from './payment-service.js';

export interface CaptureReconcileRouteDeps {
  readonly internalSecret: string;
  readonly pay: Pick<PayService, 'reconcileAuthorizedCaptures'>;
  readonly mode: CaptureReconcileMode;
  /** Isolated tests install retention. Production index already called `retainRawBody`. */
  readonly installRawBody?: boolean;
}

export function registerCaptureReconcileRoutes(app: FastifyInstance, deps: CaptureReconcileRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post<{ Body: { limit?: number; cursor?: { createdAt?: string; id?: string } } }>(
    '/internal/jobs/reconcile-authorized-captures',
    async (req, reply) => {
      if (verifyServiceHeaders(req.headers, deps.internalSecret, { rawBody: rawBodyOf(req), mode: 'require' }).service === null) {
        return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
      }
      const rawCursor = req.body?.cursor;
      const cursor: CaptureReconcileCursor | undefined =
        rawCursor === undefined ? undefined : { createdAt: rawCursor.createdAt ?? '', id: rawCursor.id ?? '' };
      try {
        const report = await deps.pay.reconcileAuthorizedCaptures(
          cursor === undefined ? { limit: req.body?.limit } : { limit: req.body?.limit, cursor },
          deps.mode,
        );
        if (report.busy) return reply.code(409).send(report);
        return report;
      } catch (err) {
        if (err instanceof PayError && err.code === 'pay.capture_reconcile_disabled') {
          return reply.code(409).send({ error: err.code, message: err.message });
        }
        if (err instanceof PayError && (err.code === 'pay.capture_reconcile_batch_limit_unset' || err.code === 'pay.validation_failed')) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
