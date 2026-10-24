/**
 * The recovery claim check for svc-bank (`POST /internal/recovery-claims/verify`, `recoveryClaimVerdictSchema`). Before
 * it sweeps a dead owner's trading balances to the heir (RC-identity-08), svc-bank asks here whether the account has a
 * confirmed death notice and whether enough of the owner's live recovery keys signed this claim. Only svc-bank may ask;
 * a refusal is answered as a verdict, so the caller refuses the claim with its code.
 */
import type { FastifyInstance } from 'fastify';
import type { ServiceBodyBindMode } from '@intafaced/contracts';
import {
  RECOVERY_CLAIM_VERIFY_PATH,
  recoveryClaimVerifyRequestSchema,
  type RecoveryClaimVerdict,
  type RecoveryClaimVerifyRequest,
} from '@intafaced/contracts/identity-recovery';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';

/** The services allowed to ask. */
export const RECOVERY_CLAIM_VERIFIERS: ReadonlySet<string> = new Set(['svc-bank']);

export function registerRecoveryClaimVerifyRoute(
  app: FastifyInstance,
  opts: {
    verify: (input: RecoveryClaimVerifyRequest) => Promise<RecoveryClaimVerdict>;
    internalSecret: string | undefined;
    bodyBind?: ServiceBodyBindMode;
    s2s?: IdentityS2s;
  },
): void {
  app.post(RECOVERY_CLAIM_VERIFY_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (!RECOVERY_CLAIM_VERIFIERS.has(service)) {
      return reply.code(403).send({ error: 'this service may not check recovery claims', code: 'identity.recovery_verifier_refused' });
    }
    const parsed = recoveryClaimVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid recovery claim', code: 'identity.recovery_claim_invalid' });
    }
    return opts.verify(parsed.data);
  });
}
