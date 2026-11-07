/**
 * The webhook creator's live verification tier, read on every alert (signals/signal-desk.ts), so an alert never places
 * on the tier the webhook's stored grant carries from its create.
 */
import { accountStateSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { SignalError } from './signal-desk.js';

/** A person's live verification tier as identity holds it now. Fails closed: any read problem refuses. */
export interface LiveTierSource {
  tierOf(userId: string): Promise<Principal['tier']>;
}

/**
 * Identity `GET /internal/account/:userId` (service credentials): `kycTier` is the highest approved, unexpired tier.
 * A transport error, a non-200 or a body that does not parse is `trade.signal_tier_unavailable` (503), never a guess.
 */
export function createLiveTierClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): LiveTierSource {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async tierOf(userId: string) {
      const target = `${url}/internal/account/${encodeURIComponent(userId)}`;
      let response: Response;
      try {
        response = await fetch(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
      } catch (err) {
        throw new SignalError(`account state unavailable: ${(err as Error).message}`, 'trade.signal_tier_unavailable', 503);
      }
      if (!response.ok) throw new SignalError(`account state unavailable (${response.status})`, 'trade.signal_tier_unavailable', 503);
      const parsed = accountStateSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success)
        throw new SignalError('account state did not match the published contract', 'trade.signal_tier_unavailable', 503);
      return parsed.data.kycTier;
    },
  };
}
