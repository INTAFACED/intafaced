/**
 * POST /internal/yield/run-window — cron / S2S weekly yield aggregation.
 *
 * Same extract pattern as `internal-emissions.ts`: `index.ts` cannot be
 * imported by a test, so the kill-switch (`YIELD_JOB_ENABLED=false` → 503,
 * `token.yield_job_unset`) needs this module.
 *
 * Body is `{ windowId }` only. Caller-typed `sources` / `amount` are 400 —
 * the job reads houseFees via ledger-client.
 *
 * Money on the wire is `formatAmount` — never `Amount.toString()`.
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
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { authorizeTokenJobHttp } from './job-hmac.js';

export interface InternalYieldDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly yieldJobEnabled: boolean;
  readonly runWindow: (input: { windowId: string }) => Promise<{
    windowId: string;
    distributed: Amount;
    recipients: number;
    skipped: number;
    alreadyPaid: number;
  }>;
  /** Defaults to `accept-both` — do not flip compose from here. */
  readonly bodyBind?: ServiceBodyBindMode;
  /**
   * Isolated tests need this. Production `index.ts` already called
   * `retainRawBody` — a second install throws and the process never listens.
   */
  readonly installRawBody?: boolean;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function registerInternalYield(app: FastifyInstance, deps: InternalYieldDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const mode = deps.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;
  app.post('/internal/yield/run-window', async (req, reply) => {
    const auth = authorizeTokenJobHttp(
      verifyServiceRequest(req, {
        verifier: deps.s2s?.verifier,
        mode: deps.s2s?.mode,
        legacySecret: deps.internalSecret,
        bodyBindMode: mode,
      }).service,
    );
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: auth.error, code: auth.code });
    }
    const body = bodyRecord(req.body);
    if ('sources' in body || 'amount' in body) {
      return reply.code(400).send({
        error: 'Yield job does not accept caller-typed sources',
        code: 'token.yield_job_unset',
      });
    }
    if (!deps.yieldJobEnabled) {
      return reply.code(503).send({
        error: 'Yield aggregation job is unset',
        code: 'token.yield_job_unset',
      });
    }
    const windowId = typeof body.windowId === 'string' ? body.windowId.trim() : '';
    if (!windowId) {
      return reply.code(400).send({ error: 'windowId is required', code: 'token.yield_job_unset' });
    }
    try {
      const result = await deps.runWindow({ windowId });
      return {
        windowId: result.windowId,
        distributed: formatAmount(result.distributed),
        recipients: result.recipients,
        skipped: result.skipped,
        alreadyPaid: result.alreadyPaid,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'yield window failed';
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'token.yield_failed';
      const status = code === 'token.yield_job_unset' ? 503 : 400;
      return reply.code(status).send({ error: message, code });
    }
  });
}
