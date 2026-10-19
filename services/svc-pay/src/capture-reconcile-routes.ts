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
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { CaptureReconcileError, captureReconcileInputFromBody, type CaptureReconcileMode } from './capture-reconcile.js';
import { PayError, type PayService } from './payment-service.js';

export interface CaptureReconcileRouteDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly pay: Pick<PayService, 'reconcileAuthorizedCaptures'>;
  readonly mode: CaptureReconcileMode;
  /** Isolated tests install retention. Production index already called `retainRawBody`. */
  readonly installRawBody?: boolean;
}

export function registerCaptureReconcileRoutes(app: FastifyInstance, deps: CaptureReconcileRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post('/internal/jobs/reconcile-authorized-captures', async (req, reply) => {
    if (
      verifyServiceRequest(req, {
        verifier: deps.s2s?.verifier,
        mode: deps.s2s?.mode,
        legacySecret: deps.internalSecret,
        bodyBindMode: 'require',
      }).service === null
    ) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    try {
      // Shape first. A null cursor or a numeric createdAt must be 400, not a throw from a string method.
      const input = captureReconcileInputFromBody(req.body);
      const report = await deps.pay.reconcileAuthorizedCaptures(input, deps.mode);
      if (report.busy) return reply.code(409).send(report);
      return report;
    } catch (err) {
      const code = err instanceof PayError || err instanceof CaptureReconcileError ? err.code : undefined;
      const message = err instanceof Error ? err.message : 'capture reconcile failed';
      if (code === 'pay.capture_reconcile_disabled') {
        return reply.code(409).send({ error: code, message });
      }
      if (code === 'pay.capture_reconcile_batch_limit_unset' || code === 'pay.validation_failed') {
        return reply.code(400).send({ error: code, message });
      }
      throw err;
    }
  });
}
