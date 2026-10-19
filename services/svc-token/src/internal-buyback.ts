/**
 * POST /internal/buyback/run-window — cron / S2S buyback market-buy.
 *
 * Same extract pattern as `internal-yield.ts`: `index.ts` cannot be imported
 * by a test, so the kill-switch (`BUYBACK_JOB_ENABLED=false` → 503,
 * `token.buyback_job_unset`) needs this module.
 *
 * Body is `{ runId, revenueWindow }` only. Caller-typed `tokensBought` /
 * `revenueTotal` / `amount` are 400 — the job sizes from houseFees and the
 * fill from placeIocMarketBuy.
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

export interface InternalBuybackDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly buybackJobEnabled: boolean;
  readonly runWindow: (input: { runId: string; revenueWindow: { from: Date; to: Date } }) => Promise<{
    runId: string;
    tokensBought: Amount;
    burned: Amount;
    toRewards: Amount;
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

export function registerInternalBuyback(app: FastifyInstance, deps: InternalBuybackDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const mode = deps.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;
  app.post('/internal/buyback/run-window', async (req, reply) => {
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
    if ('tokensBought' in body || 'revenueTotal' in body || 'amount' in body) {
      return reply.code(400).send({
        error: 'Buyback job does not accept caller-typed tokensBought',
        code: 'token.buyback_job_unset',
      });
    }
    if (!deps.buybackJobEnabled) {
      return reply.code(503).send({
        error: 'Buyback market-buy job is unset',
        code: 'token.buyback_job_unset',
      });
    }
    const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
    const windowRaw = body.revenueWindow;
    const window =
      windowRaw !== null && typeof windowRaw === 'object' && !Array.isArray(windowRaw) ? (windowRaw as Record<string, unknown>) : {};
    const from = typeof window.from === 'string' ? window.from : '';
    const to = typeof window.to === 'string' ? window.to : '';
    if (!runId || !from || !to) {
      return reply.code(400).send({ error: 'runId and revenueWindow.from/to are required', code: 'token.buyback_job_unset' });
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (!(fromDate.getTime() < toDate.getTime())) {
      return reply.code(400).send({ error: 'revenueWindow.from must be strictly before to', code: 'token.buyback_window_invalid' });
    }
    try {
      const result = await deps.runWindow({ runId, revenueWindow: { from: fromDate, to: toDate } });
      return {
        runId: result.runId,
        tokensBought: formatAmount(result.tokensBought),
        burned: formatAmount(result.burned),
        toRewards: formatAmount(result.toRewards),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'buyback window failed';
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'token.buyback_failed';
      const status = code === 'token.buyback_job_unset' ? 503 : 400;
      return reply.code(status).send({ error: message, code });
    }
  });
}
