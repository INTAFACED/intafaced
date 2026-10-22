/**
 * CB-copy-03 — read the follower's verification tier from svc-identity.
 *
 * Uses the existing published contract `accountStateSchema` (packages/contracts
 * identity.ts) over identity's existing S2S route `GET /internal/account/:userId`.
 * svc-trade never reads identity tables. Every failure (transport, timeout,
 * non-2xx, bad shape, wrong user) throws, and the caller refuses
 * `trade.identity_unavailable` — never a guessed tier.
 */
import { accountStateSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';

export type ReadIdentityTierPort = (userId: string) => Promise<Principal['tier']>;

export function createIdentityTierReader(
  config: { url: string; serviceSecret: string; s2s?: { signer: ServiceSigner; mode: ServiceAuthMode } },
  fetcher: typeof fetch = fetch,
): ReadIdentityTierPort | undefined {
  let base: URL;
  try {
    base = new URL(config.url);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return undefined;
  } catch {
    return undefined;
  }
  if (config.serviceSecret.length < 32) return undefined;
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: config.serviceSecret, s2s: config.s2s });
  return async (userId) => {
    const target = new URL(`/internal/account/${encodeURIComponent(userId)}`, base);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2000);
    try {
      const response = await fetcher(target, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          ...sign('', { method: 'GET', url: target, contentType: 'application/json' }),
        },
        signal: abort.signal,
      });
      if (!response.ok) throw new Error('Identity account read refused');
      const state = accountStateSchema.parse(await response.json());
      if (state.userId.toLowerCase() !== userId.toLowerCase()) throw new Error('Identity account read answered for another user');
      return state.kycTier;
    } finally {
      clearTimeout(timer);
    }
  };
}
