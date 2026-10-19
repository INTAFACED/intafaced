/**
 * S2S read used when svc-identity issues a session.
 *
 * The only scopes it can return are the ones `issueMerchantPayScopes`
 * already allowed, plus `pay:onboard` from `issueMerchantOnboardingScope`
 * when the caller sends a user snapshot. A user who does not own a merchant,
 * or whose KYB is not approved, gets no acquiring scopes. Team roles are not
 * looked up: they are not owners.
 *
 * Only svc-identity may call this. Any other signed service is refused.
 */

import type { FastifyInstance } from 'fastify';
import { issueMerchantOnboardingScope, type OnboardingUser } from '@intafaced/auth';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { grantedOwnerPayScopes, type OwnerPayScopeMerchant } from './merchant-pay-grant-path.js';

export interface OwnerPayScopeRouteDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly findOwnedMerchant: (userId: string) => Promise<OwnerPayScopeMerchant | null>;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readOnboardingUser(body: unknown): OnboardingUser | null {
  if (!body || typeof body !== 'object' || !('user' in body)) return null;
  const user = (body as { user?: unknown }).user;
  if (!user || typeof user !== 'object') return null;
  const row = user as Record<string, unknown>;
  if (typeof row.accountStatus !== 'string') return null;
  if (typeof row.emailVerified !== 'boolean') return null;
  if (typeof row.secondFactorEnrolled !== 'boolean') return null;
  return {
    accountStatus: row.accountStatus,
    emailVerified: row.emailVerified,
    secondFactorEnrolled: row.secondFactorEnrolled,
  };
}

function onboardingMerchant(merchant: OwnerPayScopeMerchant | null) {
  if (!merchant) return null;
  if (merchant.parentMerchantId === undefined) {
    return { parentMerchantId: 'unspecified', status: 'suspended' as const };
  }
  return { parentMerchantId: merchant.parentMerchantId, status: merchant.status };
}

export function registerOwnerPayScopeRoute(app: FastifyInstance, deps: OwnerPayScopeRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post('/internal/merchant-owner-pay-scopes', async (req, reply) => {
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
        error: 'pay.owner_grant_service_forbidden',
        message: 'only svc-identity may read the owner pay grant',
      });
    }
    const body = req.body as { userId?: unknown } | null;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (!USER_ID.test(userId)) {
      return reply.code(400).send({ error: 'pay.owner_grant_user_invalid', message: 'userId must be a uuid' });
    }
    const merchant = await deps.findOwnedMerchant(userId);
    const granted = grantedOwnerPayScopes(merchant, userId);
    const user = readOnboardingUser(req.body);
    const onboard = user ? issueMerchantOnboardingScope({ user, merchant: onboardingMerchant(merchant) }) : [];
    return reply.send({ merchantId: granted.merchantId, scopes: [...granted.scopes, ...onboard] });
  });
}
