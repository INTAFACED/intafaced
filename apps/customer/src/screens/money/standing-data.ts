/**
 * The reads behind `standing.ts`, shared by Assets and Home so both rooms read the same sources the same way: the
 * wallet from the chain at one block, the venue account from the venue, the partner account from the partner (through
 * svc-bank's `spaces.list`, which carries the partner's own figure and time), and the published prices (svc-ops
 * `valuation.prices`). Each is read again every few seconds while the room is open.
 */
import { useMemo } from 'react';
import { VALUATION_PRICES_PROCEDURE, valuationPricesOutputSchema, type ValuationPrices } from '@intafaced/contracts/valuation-prices';
import { z } from 'zod';
import { useApi, useSession } from '../../features/session/session';
import { createProtocolApi } from '../../features/protocol/api';
import { nativeCurrency } from '../../features/protocol/wallet/transfer';
import { useWallet } from '../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../features/protocol/wallet/use-polled';
import { useResource } from '../../shared/resource';
import { useVenueApi } from '../../features/trade/venue/VenueKit';
import { decimalSchema, formatAmount, parseAmount } from '../../shared/money';
import { readWallet, venueRows, type NodeRead, type VenueRow, type WalletRead, type WalletToken } from './where-it-sits';
import { standing, type PartRead } from './standing';

/** How often each source is read again while a room is open. */
export const READ_EVERY_MS = 3_000;

/** The connected wallet, read from the chain at the newest block, for the network's own currency and its listed tokens. */
export function useWalletRead(owner: string, chainId: number) {
  const wallet = useWallet();
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const pairs = useResource((signal) => protocol.ammPairs(signal), 'assets:pairs');
  const tokens = useMemo<WalletToken[]>(() => {
    const native = nativeCurrency(chainId);
    const listed = pairs.resource.status === 'ready' ? pairs.resource.data.tokens : [];
    return [
      ...(native ? [{ address: null, symbol: native.symbol, decimals: native.decimals }] : []),
      ...listed.map((token) => ({ address: token.address, symbol: token.symbol, decimals: token.decimals })),
    ];
  }, [pairs.resource, chainId]);
  const node: NodeRead = (method, params) => wallet.read(method, params);
  const key = `${owner}:${chainId}:${tokens.map((token) => token.symbol).join(',')}`;
  return usePolled<WalletRead>(
    async () => ({ ok: true as const, data: await readWallet(node, chainId, owner, tokens) }),
    key,
    READ_EVERY_MS,
  );
}

/** The venue account: the venue's balances with the open orders that lock them, and the venue's as-of time. */
export function useVenueRead(owner: string) {
  const venue = useVenueApi();
  return usePolled(
    async (signal) => {
      const [balances, orders] = await Promise.all([venue.balances(owner, signal), venue.openOrders(owner, signal)]);
      if (!balances.ok) return balances;
      if (!orders.ok) return orders;
      return { ok: true as const, data: { asOf: balances.data.asOf, rows: venueRows(balances.data.value, orders.data.value) } };
    },
    `assets:venue:${owner}`,
    READ_EVERY_MS,
  );
}

/**
 * The part of svc-bank's `spaces.list` row the partner read needs: the asset, the balance and whose figure it is. Kept here
 * rather than reusing Money's full schema, so Home does not load Money's copy catalog with every page (core-imports test).
 */
const partnerSpaceSchema = z.object({
  assetId: z.string(),
  balance: decimalSchema,
  heldAt: z
    .object({ label: z.string(), asOf: z.string().datetime({ offset: true }) })
    .nullable()
    .optional(),
});

/** What the partner holds for the person: every space it holds, by asset, with the partner's oldest time among them. */
export type PartnerRead =
  { state: 'reading' } | { state: 'unread' } | { state: 'none' } | (Extract<PartRead, { state: 'read' }> & { label: string });

export function usePartnerRead(): PartnerRead {
  const { api, userId } = useSession();
  const read = usePolled(
    (signal) => api.query('bank', 'spaces.list', { limit: 200 }, z.array(partnerSpaceSchema), { signal }),
    `standing:partner:${userId}`,
    READ_EVERY_MS,
  );
  // As Assets shows every source: the last answer stays until a newer one, and with none a failed read is unread.
  if (!read.data) return read.failure ? { state: 'unread' } : { state: 'reading' };
  const held = read.data.filter((space) => space.heldAt && /[1-9]/.test(space.balance));
  const anyHeld = read.data.some((space) => space.heldAt);
  if (!anyHeld) return { state: 'none' };
  if (held.length === 0) {
    const first = read.data.find((space) => space.heldAt)!.heldAt!;
    return { state: 'read', label: first.label, asOf: first.asOf, rows: [] };
  }
  const byAsset = new Map<string, bigint>();
  for (const space of held) byAsset.set(space.assetId, (byAsset.get(space.assetId) ?? 0n) + parseAmount(space.balance));
  const asOf = held.map((space) => space.heldAt!.asOf).sort()[0]!;
  return {
    state: 'read',
    label: held[0]!.heldAt!.label,
    asOf,
    rows: [...byAsset].map(([asset, amount]) => ({ asset, amount: formatAmount(amount) })),
  };
}

/** The published prices, or `failed` when svc-ops did not answer (then nothing is valued, and the room says so). */
export function useValuationPrices(): { prices: ValuationPrices | null; failed: boolean } {
  const { api } = useSession();
  const read = usePolled(
    (signal) => api.query('ops', VALUATION_PRICES_PROCEDURE, undefined, valuationPricesOutputSchema, { signal }),
    'standing:prices',
    READ_EVERY_MS * 10,
  );
  return { prices: read.data, failed: !read.data && Boolean(read.failure) };
}

/** A venue read as a standing part: reading, unread, or its rows (each asset's total, free and locked together). */
export function venuePart(read: { data: { asOf: string; rows: VenueRow[] } | null; failure: unknown }): PartRead {
  if (!read.data) return read.failure ? { state: 'unread' } : { state: 'reading' };
  return { state: 'read', asOf: read.data.asOf, rows: read.data.rows.map((row) => ({ asset: row.asset, amount: row.total })) };
}

/** A wallet read as a standing part. A token the chain did not answer for is in `unread` and is not a part's row. */
export function walletPart(read: { data: WalletRead | null }): PartRead {
  if (!read.data) return { state: 'reading' };
  if (!read.data.ok) return { state: 'unread' };
  return { state: 'read', asOf: read.data.asOf, rows: read.data.rows.map((row) => ({ asset: row.symbol, amount: row.amount })) };
}

/**
 * Every source for one connected wallet, and where the person stands: the one call Assets and Home both make. `unit`
 * is the display unit (BTC, or dollars for anything else); `network` and `venue` name the wallet's network and the venue.
 */
export function useStanding(
  owner: string,
  chainId: number,
  names: { network: string; venue: string; venueTest: boolean },
  unit: 'USD' | 'BTC',
) {
  const wallet = useWalletRead(owner, chainId);
  const venue = useVenueRead(owner);
  const partner = usePartnerRead();
  const { prices, failed } = useValuationPrices();
  const result = standing(
    [
      { id: 'wallet', label: names.network, read: walletPart(wallet) },
      { id: 'venue', label: names.venue, read: venuePart(venue), test: names.venueTest },
      ...(partner.state === 'none'
        ? []
        : [
            {
              id: 'partner' as const,
              label: partner.state === 'read' ? partner.label : '',
              read: partner.state === 'read' ? { state: 'read' as const, asOf: partner.asOf, rows: partner.rows } : partner,
            },
          ]),
    ],
    failed ? null : prices,
    unit,
  );
  return { wallet, venue, partner, standing: result, pricesFailed: failed };
}
