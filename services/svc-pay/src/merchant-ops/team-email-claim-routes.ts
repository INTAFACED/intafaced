/**
 * POST /internal/merchant-team/claim-email-invites
 *
 * svc-identity calls this after the account's email is confirmed. A merchant session cannot:
 * the body would let them attach someone else's email invites to their account.
 * Only an svc-identity HMAC is accepted. Other signed services are refused
 * separately from a missing signature.
 */
import type { FastifyInstance } from 'fastify';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { MerchantOpsError } from './errors.js';
import type { EmailInviteClaimResult } from './team-email-claim.js';

export interface MerchantEmailInviteRouteDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly claim: (input: { userId: string; email: string }) => Promise<EmailInviteClaimResult>;
  /** Isolated tests install retention. Production index already called retainRawBody. */
  readonly installRawBody?: boolean;
}

export function registerMerchantEmailInviteRoutes(app: FastifyInstance, deps: MerchantEmailInviteRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post<{ Body: { userId?: string; email?: string } }>('/internal/merchant-team/claim-email-invites', async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) {
      return reply.code(401).send({ error: 'pay.unauthenticated' });
    }
    if (verified.service !== 'svc-identity') {
      return reply.code(403).send({ error: 'pay.team_email_claim_forbidden' });
    }
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    try {
      return await deps.claim({ userId, email });
    } catch (err) {
      if (err instanceof MerchantOpsError) {
        return reply.code(400).send({ error: err.code });
      }
      throw err;
    }
  });
}
