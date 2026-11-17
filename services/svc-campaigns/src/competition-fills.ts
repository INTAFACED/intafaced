import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { z } from 'zod';
import type { CompetitionFillSource } from './competitions.js';

/**
 * A competition's volume (J-campaigns-11 #3 #4): svc-trade `GET /internal/venue/our-fills?userId=&since=`, with service
 * credentials. svc-trade reads the venue's own fills of the person's orders placed through our door, with our builder fee
 * above zero; nothing is kept there. Every failure (transport, a non-2xx, a body that is not the published shape) is
 * `unread` with the code svc-trade gave, or `campaigns.fills_unread`, which the board names and the settlement waits on:
 * never "no volume".
 */
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const fillsSchema = z.object({
  venueId: z.string().min(1),
  asOf: z.string(),
  value: z.array(
    z
      .object({
        fillId: z.string().min(1),
        venueAccount: z.string().min(1),
        symbol: z.string(),
        quoteAsset: z.string(),
        notional: decimal,
        builderFee: decimal,
        filledAt: z.string(),
      })
      .passthrough(),
  ),
});

export function createCompetitionFillSource(options: {
  tradeUrl: string;
  internalSecret: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetchFn?: typeof globalThis.fetch;
}): CompetitionFillSource {
  const trade = options.tradeUrl.replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sign = serviceCallSigner({
    service: 'svc-campaigns',
    audience: 'svc-trade',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });
  return {
    async ourFills(userId, since) {
      const target = `${trade}/internal/venue/our-fills?userId=${encodeURIComponent(userId)}&since=${encodeURIComponent(since.toISOString())}`;
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        return { unread: 'campaigns.fills_unread' };
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const code = (body as { code?: unknown } | null)?.code;
        return { unread: typeof code === 'string' && /^[a-z_.]+$/.test(code) ? code : 'campaigns.fills_unread' };
      }
      const parsed = fillsSchema.safeParse(body);
      if (!parsed.success) return { unread: 'campaigns.fills_unread' };
      return { venueId: parsed.data.venueId, asOf: parsed.data.asOf, fills: parsed.data.value };
    },
  };
}
