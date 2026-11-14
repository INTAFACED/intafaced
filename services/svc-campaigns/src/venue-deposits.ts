import { serviceCallSigner, unwrapTrpcData, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { protocolVenueWalletStatusOutputSchema } from '@intafaced/contracts/protocol-venue-wallet';
import { z } from 'zod';

/**
 * The welcome deposit task's two reads (J-campaigns-04 #2 #3), keeping no copy:
 *
 * - the wallets a person connected: svc-protocol's `venueWallet.status` (J-wallet-09's record), read FOR the person during
 *   their own request, with the edge-signed principal passed on unchanged (`forwardedPrincipalHeaders`): svc-protocol
 *   answers only that person's wallets, and with no person (no request of theirs) it answers nothing;
 * - with service credentials:
 * - the venue's own deposits into the venue account each wallet owns: svc-trade `GET /internal/venue/deposits?owner=`,
 *   through the user-venue door (the venue's list, never ours).
 *
 * Every failure (transport, a non-2xx, a body that is not the published shape, an answer about another person) is null,
 * which the caller treats as unread: the task stays as it was and the checklist says the venue could not be read, never
 * "no deposit".
 */
export interface VenueDepositSource {
  /**
   * The person's connected wallets that are not blocked, lowercase; null when unread. `forwarded` is the person's own
   * edge-signed principal from their request (`forwardedPrincipalHeaders(ctx)`); empty, nothing is read.
   */
  wallets(forwarded: Record<string, string>): Promise<string[] | null>;
  /** The venue's deposits into this wallet's venue account; null when unread. */
  deposits(owner: string): Promise<VenueDepositRead | null>;
}

const amount = z.string().regex(/^\d+(\.\d+)?$/);
const depositSchema = z.object({
  depositRef: z.string().min(1),
  asset: z.string(),
  amount,
  status: z.enum(['confirming', 'credited', 'not_credited']),
  seenAt: z.string(),
});
const depositsSchema = z.object({ venueId: z.string(), asOf: z.string(), value: z.array(depositSchema.passthrough()) });

export type VenueDeposit = z.infer<typeof depositSchema>;
export interface VenueDepositRead {
  venueId: string;
  asOf: string;
  deposits: VenueDeposit[];
}

type Sign = (payload: string, request: { method: string; url: URL; contentType: string }) => Record<string, string>;

async function getJson(target: string, headers: Record<string, string>): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'GET',
      headers: { 'content-type': 'application/json', ...headers },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const signed = (target: string, sign: Sign) => sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' });

export function createVenueDepositSource(options: {
  protocolUrl: string;
  tradeUrl: string;
  internalSecret: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}): VenueDepositSource {
  const protocol = options.protocolUrl.replace(/\/$/, '');
  const trade = options.tradeUrl.replace(/\/$/, '');
  const toTrade: Sign = serviceCallSigner({
    service: 'svc-campaigns',
    audience: 'svc-trade',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });
  return {
    async wallets(forwarded) {
      if (Object.keys(forwarded).length === 0) return null;
      const body = await getJson(`${protocol}/trpc/venueWallet.status`, forwarded);
      const parsed = protocolVenueWalletStatusOutputSchema.safeParse(unwrapTrpcData(body));
      if (!parsed.success) return null;
      // An expired connection is still the person's own wallet (it only refuses signed actions); a blocked one is not read.
      const live = parsed.data.connections.filter((c) => c.status !== 'blocked').map((c) => c.address.toLowerCase());
      return [...new Set(live)];
    },
    async deposits(owner) {
      const target = `${trade}/internal/venue/deposits?owner=${encodeURIComponent(owner)}`;
      const body = await getJson(target, signed(target, toTrade));
      const parsed = depositsSchema.safeParse(body);
      if (!parsed.success) return null;
      return { venueId: parsed.data.venueId, asOf: parsed.data.asOf, deposits: parsed.data.value };
    },
  };
}
