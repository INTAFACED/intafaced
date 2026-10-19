/**
 * S2S read used when svc-identity mints a pay:refund / pay:payout step-up token.
 *
 * The answer is this user's role on the named merchant: owner, or an active
 * team member. `refunds.create` and `payout.send` follow that role. A missing
 * merchant and a seat without the permission both answer false. Only
 * svc-identity may call this.
 */

import type { FastifyInstance } from 'fastify';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { MerchantRole } from './merchant-ops/roles.js';
import { payStepUpPermissions } from './merchant-ops/roles.js';

export interface PayStepUpGrantRouteDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly findRole: (userId: string, merchantId: string) => Promise<MerchantRole | null>;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerPayStepUpGrantRoute(app: FastifyInstance, deps: PayStepUpGrantRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post('/internal/merchant-pay-step-up-grant', async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    if (verified.service !== 'svc-identity') {
      return reply.code(403).send({
        error: 'pay.step_up_grant_service_forbidden',
        message: 'only svc-identity may read the pay step-up grant',
      });
    }
    const body = req.body as { userId?: unknown; merchantId?: unknown } | null;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const merchantId = typeof body?.merchantId === 'string' ? body.merchantId.trim() : '';
    if (!USER_ID.test(userId) || !USER_ID.test(merchantId)) {
      return reply.code(400).send({ error: 'pay.step_up_grant_invalid', message: 'userId and merchantId must be uuids' });
    }
    const role = await deps.findRole(userId, merchantId);
    return reply.send({ role, permissions: payStepUpPermissions(role) });
  });
}
