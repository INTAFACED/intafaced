import { rankPerksSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { BankError } from '../errors.js';
import type { CardTier } from './card-programme.js';

/**
 * The person's rank card tier (RC-bank-02), read from svc-identity's rank perks door (`GET /internal/rank/:userId/perks`,
 * service-signed, never a free user id on the edge). Only `cardTier` is read. Identity down, refusing or unreadable
 * refuses `bank.rank_unavailable`: no tier is guessed.
 */
export interface RankTierPort {
  cardTierOf(userId: string): Promise<CardTier>;
}

export function unconfiguredRankTier(): RankTierPort {
  return {
    async cardTierOf() {
      throw new BankError('IDENTITY_URL is unset, so the bank cannot read which card tier a rank gives', 'bank.rank_unavailable');
    },
  };
}

export function createIdentityRankTier(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): RankTierPort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async cardTierOf(userId) {
      const target = `${base}/internal/rank/${encodeURIComponent(userId)}/perks`;
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(3_000),
        });
      } catch {
        throw new BankError('identity did not answer the rank perks read', 'bank.rank_unavailable');
      }
      if (!response.ok) throw new BankError(`identity refused the rank perks read (${response.status})`, 'bank.rank_unavailable');
      const parsed = rankPerksSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new BankError('identity returned unreadable rank perks', 'bank.rank_unavailable');
      return parsed.data.cardTier;
    },
  };
}

/** For tests: a fixed tier per person, `none` for anyone else. */
export function memoryRankTier(tiers: Readonly<Record<string, CardTier>> = {}): RankTierPort {
  return {
    async cardTierOf(userId) {
      return tiers[userId] ?? 'none';
    },
  };
}
