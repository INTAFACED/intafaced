/**
 * S2S read for svc-identity's sign-in (M-plat-org-06): does any merchant this
 * user owns or is an active member of require MFA? Answers
 * `{ rule: 'required' | 'not_required' | 'unset' | 'none' }`. Only svc-identity
 * may call this; the body is bound to the signature.
 */

import type { FastifyInstance } from 'fastify';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { MfaRuleForUser } from './merchant-ops/security.js';

export interface MerchantMfaRuleRouteDeps {
  readonly internalSecret: string;
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly read: (userId: string) => Promise<MfaRuleForUser>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerMerchantMfaRuleRoute(app: FastifyInstance, deps: MerchantMfaRuleRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post('/internal/merchant-mfa-rule', async (req, reply) => {
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
      return reply.code(403).send({ error: 'pay.mfa_rule_service_forbidden', message: 'only svc-identity may read the merchant MFA rule' });
    }
    const body = req.body as { userId?: unknown } | null;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (!UUID.test(userId)) {
      return reply.code(400).send({ error: 'pay.mfa_rule_invalid', message: 'userId must be a uuid' });
    }
    return reply.send({ rule: await deps.read(userId) });
  });
}
