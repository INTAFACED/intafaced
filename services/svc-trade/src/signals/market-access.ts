/**
 * A person's access to a signal listing, as svc-market holds it (J-copy-bots-otc-21 #1 #2): svc-market's
 * `GET /internal/signals/access/:listingId/:userId` (service credentials). Fails closed: a transport error, a status
 * other than 200 or 404, or a body that does not parse throws, and the create refuses `trade.signal_access_unavailable`.
 */
import { z } from 'zod';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { SignalAccessSource } from './signal-bots.js';

/** How long a create waits for svc-market's answer. */
export const MARKET_ACCESS_TIMEOUT_MS = 5_000;

const answerSchema = z.object({ access: z.boolean(), title: z.string() });

export function createMarketAccessClient(
  baseUrl: string | undefined,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): SignalAccessSource {
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-market', legacySecret: internalSecret, s2s });
  return {
    async access(listingId, userId) {
      if (!baseUrl) throw new Error('MARKET_URL is not set');
      const target = `${baseUrl.replace(/\/$/, '')}/internal/signals/access/${encodeURIComponent(listingId)}/${encodeURIComponent(userId)}`;
      const response = await fetch(target, {
        method: 'GET',
        signal: AbortSignal.timeout(MARKET_ACCESS_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
        },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`svc-market answered ${response.status}`);
      const parsed = answerSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new Error('svc-market answer did not parse');
      return parsed.data;
    },
  };
}
