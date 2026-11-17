import { serviceAuthHeadersForBody } from './service-auth.js';
import {
  tradeVenueActivityInputSchema,
  tradeVenueActivitySchema,
  type TradeVenueActivityPort,
  type TradeVenueActivityResult,
} from './trade-venue-activity.js';

const UNAVAILABLE: TradeVenueActivityResult = { state: 'unavailable', code: 'trade.venue_activity_unavailable' };

/**
 * svc-tax's client for svc-trade's `venue.ownActivity`. One bounded request, signed over its body with the shared service
 * secret. A missing or malformed URL, a secret under 32 characters, a non-2xx reply (the venue down answers 503), a reply
 * that does not parse, a timeout and a thrown fetch all answer `unavailable`: no answer is never read as "no trades".
 */
export function createTradeVenueActivityClient(options: {
  tradeUrl?: string;
  secret?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): TradeVenueActivityPort {
  let endpoint: string | null = null;
  try {
    const url = new URL(options.tradeUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/venue.ownActivity`;
  } catch {
    /* Missing or invalid transport reads nothing. */
  }
  return {
    async read(raw) {
      if (endpoint === null || !options.secret || options.secret.length < 32) return UNAVAILABLE;
      const parsed = tradeVenueActivityInputSchema.safeParse(raw);
      if (!parsed.success) return UNAVAILABLE;
      const body = JSON.stringify(parsed.data);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
      try {
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            ...serviceAuthHeadersForBody('svc-tax', options.secret, body),
          },
          body,
        });
        if (!response.ok) return UNAVAILABLE;
        const envelope: unknown = await response.json();
        if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) return UNAVAILABLE;
        const answer = tradeVenueActivitySchema.safeParse((envelope as { result?: { data?: unknown } }).result?.data);
        return answer.success ? answer.data : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
