import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { z } from 'zod';

/**
 * One person's venue equity in one asset (J-campaigns-13 #2 #4): svc-trade `GET /internal/venue/equity?userId=&asset=`,
 * with service credentials. svc-trade reads the venue's own balances of the accounts the person's wallet signed through
 * our door; nothing is kept there. Every failure (transport, a non-2xx, a body that is not the published shape) is
 * `unread` with the code svc-trade gave, or `campaigns.equity_unread`: never 0.
 */
export interface EquitySource {
  equity(userId: string, asset: string): Promise<{ venueId: string; asOf: string; equity: string } | { unread: string }>;
}

export const EQUITY_UNREAD = 'campaigns.equity_unread';

const equitySchema = z.object({
  venueId: z.string().min(1),
  asset: z.string(),
  asOf: z.string().datetime({ offset: true }),
  equity: z.string().regex(/^-?\d+(\.\d+)?$/),
});

export function createEquitySource(options: {
  tradeUrl: string;
  internalSecret: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetchFn?: typeof globalThis.fetch;
}): EquitySource {
  const trade = options.tradeUrl.replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sign = serviceCallSigner({
    service: 'svc-campaigns',
    audience: 'svc-trade',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });
  return {
    async equity(userId, asset) {
      const target = `${trade}/internal/venue/equity?userId=${encodeURIComponent(userId)}&asset=${encodeURIComponent(asset)}`;
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
        return { unread: EQUITY_UNREAD };
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const code = (body as { code?: unknown } | null)?.code;
        return { unread: typeof code === 'string' && /^[a-z_.]+$/.test(code) ? code : EQUITY_UNREAD };
      }
      const parsed = equitySchema.safeParse(body);
      if (!parsed.success || parsed.data.asset !== asset) return { unread: EQUITY_UNREAD };
      return { venueId: parsed.data.venueId, asOf: parsed.data.asOf, equity: parsed.data.equity };
    },
  };
}
