/**
 * S2S read used when svc-identity issues a session.
 *
 * The only scopes it can return are the ones `issueMerchantPayScopes`
 * already allowed. A user who does not own a merchant, or whose KYB is not
 * approved, gets an empty list. Team roles are not looked up: they are not
 * owners.
 */

import type { FastifyInstance } from 'fastify';
import { rawBodyOf, retainRawBody, verifyServiceHeaders } from '@intafaced/contracts';
import { grantedOwnerPayScopes, type OwnerPayScopeMerchant } from './merchant-pay-grant-path.js';

export interface OwnerPayScopeRouteDeps {
  readonly internalSecret: string;
  readonly installRawBody?: boolean;
  readonly findOwnedMerchant: (userId: string) => Promise<OwnerPayScopeMerchant | null>;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerOwnerPayScopeRoute(app: FastifyInstance, deps: OwnerPayScopeRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post('/internal/merchant-owner-pay-scopes', async (req, reply) => {
    if (verifyServiceHeaders(req.headers, deps.internalSecret, { rawBody: rawBodyOf(req), mode: 'require' }).service === null) {
      return reply.code(401).send({ error: 'pay.unauthenticated', message: 'service credentials required' });
    }
    const body = req.body as { userId?: unknown } | null;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (!USER_ID.test(userId)) {
      return reply.code(400).send({ error: 'pay.owner_grant_user_invalid', message: 'userId must be a uuid' });
    }
    const merchant = await deps.findOwnedMerchant(userId);
    const granted = grantedOwnerPayScopes(merchant, userId);
    return reply.send({ merchantId: granted.merchantId, scopes: [...granted.scopes] });
  });
}
