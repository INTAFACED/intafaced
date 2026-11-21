import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { z } from 'zod';

/**
 * One person's realised trading result in one asset over a window (J-bank-31 #2 #7): svc-trade
 * `GET /internal/venue/realised?userId=&asset=&since=&until=`, with service credentials. svc-trade adds up the realised
 * result the venue reports on the closing fills of the person's main venue accounts; nothing is kept there. Every
 * failure (transport, a non-2xx, a body not in the published shape) is `unread` with the code svc-trade gave, or
 * `bank.realised_unread`: never 0, so a read that failed is never "no profit".
 */
export interface RealisedSource {
  realised(userId: string, asset: string, since: Date, until?: Date): Promise<Realised | { unread: string }>;
}

export interface Realised {
  readonly venueId: string;
  readonly asOf: Date;
  readonly realised: Amount;
  /** The main venue accounts, each with its owner wallet and its own realised result. */
  readonly accounts: readonly { readonly owner: string; readonly realised: Amount }[];
}

export const REALISED_UNREAD = 'bank.realised_unread';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const realisedSchema = z.object({
  venueId: z.string().min(1),
  asset: z.string(),
  asOf: z.string().datetime({ offset: true }),
  realised: decimal,
  accounts: z.array(z.object({ owner: z.string().regex(/^0x[0-9a-f]{40}$/), realised: decimal })),
});

export function createRealisedSource(options: {
  tradeUrl: string;
  internalSecret: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetchFn?: typeof globalThis.fetch;
}): RealisedSource {
  const trade = options.tradeUrl.replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-trade', legacySecret: options.internalSecret, s2s: options.s2s });
  return {
    async realised(userId, asset, since, until) {
      const query = new URLSearchParams({ userId, asset, since: since.toISOString(), ...(until ? { until: until.toISOString() } : {}) });
      const target = `${trade}/internal/venue/realised?${query.toString()}`;
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
        return { unread: REALISED_UNREAD };
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const code = (body as { code?: unknown } | null)?.code;
        return { unread: typeof code === 'string' && /^[a-z_.]+$/.test(code) ? code : REALISED_UNREAD };
      }
      const parsed = realisedSchema.safeParse(body);
      if (!parsed.success || parsed.data.asset !== asset) return { unread: REALISED_UNREAD };
      return {
        venueId: parsed.data.venueId,
        asOf: new Date(parsed.data.asOf),
        realised: parseAmount(parsed.data.realised),
        accounts: parsed.data.accounts.map((a) => ({ owner: a.owner, realised: parseAmount(a.realised) })),
      };
    },
  };
}
