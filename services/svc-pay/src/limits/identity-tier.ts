import { accountStateSchema } from '@intafaced/contracts';
import type { KycTierOf } from './guards.js';
import { createIdentityGet, type IdentityReadOptions } from './identity-get.js';

/**
 * The customer's KYC tier for the withdrawal limit (D-148), read per request from
 * svc-identity's `GET /internal/account/:userId` (the published `AccountState`),
 * service-authenticated like every other internal read. Nothing is cached or
 * copied: identity derives the tier from approved, unexpired documents.
 *
 * Every failure THROWS: transport, timeout, 401, 404, a body off the published
 * contract, or a body for another user. The guard turns a throw into
 * `pay.guard_unavailable`, so a limit is never applied against a guessed tier
 * and a dark identity service never reads as "full".
 */
export type IdentityKycTierOptions = IdentityReadOptions;

export function createIdentityKycTierClient(options: IdentityKycTierOptions): KycTierOf {
  const get = createIdentityGet(options, 'identity KYC tier client');
  return async (userId) => {
    const body = await get(`/internal/account/${encodeURIComponent(userId)}`, 'KYC tier');
    const parsed = accountStateSchema.safeParse(body);
    if (!parsed.success) throw new Error('identity answered off the published account contract: KYC tier not read');
    // Bind the answer to the user we asked about, so a misrouted reply cannot set another customer's limit.
    if (parsed.data.userId !== userId) throw new Error('identity answered for a different user: KYC tier not read');
    return parsed.data.kycTier;
  };
}
