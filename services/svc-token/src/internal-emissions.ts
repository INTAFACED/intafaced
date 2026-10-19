/**
 * POST /internal/emissions/mint-next — cron / S2S mint of the next epoch.
 *
 * Prefer this over the in-process auto-tick: a cron is pauseable, inspectable,
 * and does not depend on which replica holds the timer.
 *
 * ── WHY THIS LIVES IN ITS OWN MODULE ────────────────────────────────────────
 *
 * Same reason as `internal-stake.ts`: `index.ts` connects Postgres and NATS and
 * calls `app.listen()` at module scope, so it cannot be imported by a test. The
 * kill-switch path (`EMISSIONS_ENABLED=false` → 503, zero mint) had no unit
 * proof at the HTTP boundary even though tRPC mintEpoch was covered.
 *
 * Money on the wire is `formatAmount` — never `Amount.toString()` (see #1100).
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

export interface InternalEmissionsDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  /** When false every mint path fails closed — inflation cannot be un-minted. */
  readonly emissionsEnabled: boolean;
  readonly mintNextEpoch: () => Promise<{ epoch: number; minted: Amount }>;
  /** Defaults to `accept-both` — do not flip compose from here. */
  readonly bodyBind?: ServiceBodyBindMode;
  /**
   * Isolated tests need this. Production `index.ts` already called
   * `retainRawBody` — a second install throws and the process never listens.
   */
  readonly installRawBody?: boolean;
}

export function registerInternalEmissions(app: FastifyInstance, deps: InternalEmissionsDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const mode = deps.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;
  app.post('/internal/emissions/mint-next', async (req, reply) => {
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
    if (!deps.emissionsEnabled) {
      return reply.code(503).send({ error: 'emissions are disabled', code: 'token.emissions_disabled' });
    }
    try {
      const result = await deps.mintNextEpoch();
      return { epoch: result.epoch, minted: formatAmount(result.minted) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'mint failed';
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'token.mint_failed';
      // Time gate: not an error to alarm on — the next epoch is simply not due.
      // 429 + Retry-After (whole seconds, from the database clock) so a cron can back off.
      if (code === 'token.epoch_too_early') {
        const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
        const retryAfterSec = typeof retryAfterMs === 'number' && retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : undefined;
        if (retryAfterSec !== undefined) reply.header('retry-after', String(retryAfterSec));
        return reply.code(429).send({ error: message, code, ...(retryAfterSec !== undefined ? { retryAfterSeconds: retryAfterSec } : {}) });
      }
      // Fail closed: never 200 on a mint that did not land.
      return reply.code(400).send({ error: message, code });
    }
  });
}
