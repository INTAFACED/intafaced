/**
 * THE CYCLE RUNNER'S ROUTE — an external cron reaches the charge cycle here.
 *
 * Its own module, and not four lines inline in `index.ts`, for one reason:
 * `reachability` is a doctrine gate, and a route defined inside the file that
 * also reads env, opens a pool, registers rails and calls `app.listen()` cannot
 * be reached by a test. This repository has produced *"six guards that were
 * correct in isolation and unreachable in place"*
 * (`adr/2026-08-08-twap-overdue-slice-disposition.md`, done bar item 6), and the
 * subscription engine's whole defence against double-charging is a guard. So the
 * route is registrable, and a test hits it over HTTP.
 *
 * `index.ts` registers exactly this — no second copy of the handler.
 *
 * S2S ONLY. An anonymous caller who found the port must not be able to fan out
 * invoices to every customer of every merchant on the platform, which is what an
 * unauthenticated due pass is.
 *
 * NOT a `setInterval`. Bank transplant law: a due runner that schedules itself
 * fires N times on N replicas.
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
import { formatAmount } from '@intafaced/ledger-client';
import { PayError, assertCycleListLimit, assertDueSubscriptionsBatchLimit } from '../payment-service.js';
import type { RunReport, SubscriptionService } from './subscription-service.js';

export interface SubscriptionCycleRouteDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly subscriptions: Pick<SubscriptionService, 'runDueSubscriptions' | 'listCycles'>;
  /**
   * Journal GET follows `INTERNAL_SERVICE_BODY_BIND` (compose stays accept-both).
   * Due-pass mutate ignores this and hardcodes HMAC `require`.
   */
  readonly bodyBind?: ServiceBodyBindMode;
  /**
   * Isolated tests install retention. Production index already called
   * `retainRawBody` on the same Fastify instance.
   */
  readonly installRawBody?: boolean;
}

/**
 * POST /internal/jobs/run-due-subscriptions — one pass of the charge cycle.
 * GET  /internal/subscriptions/:id/cycles  — what actually happened, per period.
 *
 * The second route is not decoration. A run report is a snapshot of one pass;
 * "was this period charged once or twice" is a question about the journal, and
 * an operator asking it during an incident needs the keys, the attempt counts
 * and the rejection codes, not a status word.
 */
export function registerSubscriptionCycleRoutes(app: FastifyInstance, deps: SubscriptionCycleRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const journalMode = deps.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;

  app.post<{ Body: { limit?: number } }>('/internal/jobs/run-due-subscriptions', async (req, reply) => {
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

    /*
     * `now` is NEVER accepted from the body. A caller-supplied clock on a charge
     * cycle is a caller-supplied answer to "which period is due", i.e. a way to
     * charge next year's twelve periods today. Same shape as the refuse-cases
     * table in `adr/2026-08-05-futures-risk-and-mark-law.md`: a price supplied in
     * a request body is refused rather than ignored-and-substituted.
     *
     * `limit` is required. Omit used to invent a 50-row due pass. Blank refuses.
     * Owner/cron may pass 50 explicitly.
     */
    try {
      const limit = assertDueSubscriptionsBatchLimit(req.body?.limit);
      const report: RunReport = await deps.subscriptions.runDueSubscriptions({ limit });
      return report;
    } catch (err) {
      if (err instanceof PayError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/internal/subscriptions/:id/cycles', async (req, reply) => {
    if (
      verifyServiceRequest(req, {
        verifier: deps.s2s?.verifier,
        mode: deps.s2s?.mode,
        legacySecret: deps.internalSecret,
        bodyBindMode: journalMode,
      }).service === null
    ) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    try {
      /*
       * `limit` is required. Omit used to dump every subscription_executions
       * row. Blank refuses. Owner/operator may pass 50 explicitly.
       * Query strings are not numbers — coerce so `?limit=50` is explicit 50.
       */
      const raw = req.query.limit;
      const parsed = raw === undefined || raw === '' ? undefined : Number(raw);
      const limit = assertCycleListLimit(parsed);
      const cycles = await deps.subscriptions.listCycles(req.params.id, { limit });
      return {
        subscriptionId: req.params.id,
        cycles: cycles.map((c) => ({
          occurrence: c.occurrence,
          /*
           * `formatAmount`, not `String(amount)`. An `Amount` is a SCALED bigint
           * — `String()` on it renders 10 USDT as "10000000000000000000", which
           * an operator reading this route would take at face value. And never a
           * JSON number: a JSON number is a float and a float is not money.
           */
          amount: formatAmount(c.amount),
          status: c.status,
          idempotencyKey: c.idempotencyKey,
          attemptCount: c.attemptCount,
          rejectionCode: c.rejectionCode,
          paymentId: c.paymentId,
          exhausted: c.exhaustedAt !== null,
          settledAt: c.settledAt === null ? null : c.settledAt.toISOString(),
          notifyStatus: c.notifyStatus,
          notifyCode: c.notifyCode,
        })),
      };
    } catch (err) {
      if (err instanceof PayError) {
        return reply.code(err.code === 'pay.subscription_not_found' ? 404 : 400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
