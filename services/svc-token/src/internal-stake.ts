/**
 * GET /internal/stake/:userId — the S2S stake gate every other service reads.
 *
 * Consumers: svc-academy staked lobbies (`stake-source.ts`), the svc-trade OTC
 * gate (`otc/stake-source.ts`), and future stake gates such as marketplace
 * vendor slots. All of them fail CLOSED on a bad response, which is why this
 * route breaking is invisible from the outside: nothing errors, everything is
 * merely refused.
 *
 * ── WHY THIS LIVES IN ITS OWN MODULE ────────────────────────────────────────
 *
 * It used to be inline in `index.ts`, which connects Postgres and NATS and calls
 * `app.listen()` at module scope. That file cannot be imported by a test, so the
 * route had no test and shipped returning HTTP 500 on every single call. Moving
 * the handler here is what makes `internal-stake.test.ts` possible.
 *
 * ── THE TWO WAYS MONEY BREAKS ON THIS BOUNDARY ──────────────────────────────
 *
 * `Amount` is a scaled bigint (`packages/ledger-client/src/money.ts`), and there
 * are exactly two ways to get it wrong on the way out:
 *
 *   1. Send the bigint. `JSON.stringify` throws "Do not know how to serialize a
 *      BigInt", Fastify turns that into a 500, and every gate refuses forever.
 *      This is what the route did.
 *
 *   2. Send `amount.toString()`. That does not throw — it emits the RAW SCALED
 *      integer, so 10,000 IFC leaves as "10000000000000000000000". Every
 *      consumer parses this field with `parseAmount`, which scales by 10^18
 *      again, so the caller reads a stake 10^18 times too large and the gate
 *      opens for everyone. This is strictly worse than the 500: it fails OPEN.
 *
 * `formatAmount` is the only correct answer, and it is the rule `router.ts`
 * already states: money crosses the wire as a decimal string. Always.
 *
 * `StakeAccessBody` exists to make that a type error rather than an outage —
 * every money field on it is `AmountString`, so putting an `Amount` back into
 * this response fails the typecheck instead of the request.
 *
 * ponytail: no Fastify response schema on purpose. A schema would not have
 * caught this and cannot fix it — `fast-json-stringify` coerces a bigint under
 * `type: 'string'` with `String()`, which is failure mode 2 above. The
 * conversion has to be `formatAmount`, so it belongs in the handler.
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
import { formatAmount, type Amount, type AmountString } from '@intafaced/ledger-client';
import type { AccessTier } from './economics/staking.js';

/** What `TokenService.accessOf` returns. Narrow on purpose so tests need no service instance. */
export interface StakeAccess {
  readonly staked: Amount;
  readonly tier: AccessTier;
  readonly feeDiscountBps: number;
}

/** Wire shape. Every money field is a decimal string — an `Amount` here is a typecheck failure. */
export interface StakeAccessBody {
  readonly staked: AmountString;
  readonly tier: Omit<AccessTier, 'minStake'> & { readonly minStake: AmountString };
  readonly feeDiscountBps: number;
}

export interface InternalStakeDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly accessOf: (userId: string) => Promise<StakeAccess>;
  /** Defaults to `accept-both` — do not flip compose from here. */
  readonly bodyBind?: ServiceBodyBindMode;
  /**
   * Isolated tests need this. Production `index.ts` already called
   * `retainRawBody` — a second install throws and the process never listens.
   */
  readonly installRawBody?: boolean;
}

/** The wire projection, separate from the route so the test can assert it directly. */
export function toStakeAccessBody(access: StakeAccess): StakeAccessBody {
  return {
    staked: formatAmount(access.staked),
    tier: { ...access.tier, minStake: formatAmount(access.tier.minStake) },
    feeDiscountBps: access.feeDiscountBps,
  };
}

export function registerInternalStake(app: FastifyInstance, deps: InternalStakeDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);
  const mode = deps.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;
  app.get<{ Params: { userId: string } }>('/internal/stake/:userId', async (req, reply) => {
    if (
      verifyServiceRequest(req, {
        verifier: deps.s2s?.verifier,
        mode: deps.s2s?.mode,
        legacySecret: deps.internalSecret,
        bodyBindMode: mode,
      }).service === null
    ) {
      return reply.code(401).send({ error: 'service credentials required', code: 'token.unauthenticated' });
    }
    return toStakeAccessBody(await deps.accessOf(req.params.userId));
  });
}
