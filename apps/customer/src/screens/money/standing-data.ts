/**
 * The reads behind `standing.ts`, shared by Assets and Home so both rooms read the same sources the same way: the
 * wallet from the chain at one block, the venue account from the venue, the partner account from the partner (through
 * svc-bank's `spaces.list`, which carries the partner's own figure and time), and the published prices (svc-ops
 * `valuation.prices`). Each is read again every few seconds while the room is open.
 */
import { BANK_SPACES_LIST } from '@intafaced/contracts/bank-spaces-list';
import { useMemo } from 'react';
import { OPS_VALUATION_PRICES } from '@intafaced/contracts/ops-public-procedures';
import type { ValuationPrices } from '@intafaced/contracts/valuation-prices';
import { useApi, useSession } from '../../features/session/session';
import { createProtocolApi } from '../../features/protocol/api';
import { nativeCurrency } from '../../features/protocol/wallet/transfer';
import { useWallet } from '../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../features/protocol/wallet/use-polled';
import { useResource } from '../../shared/resource';
import { useVenueApi } from '../../features/trade/venue/VenueKit';
import type { VenueStakingAccount, VenueVaultHoldings } from '../../features/trade/venue-api';
import { formatAmount, parseAmount } from '../../shared/money';
import { isTestBuild } from '../../shared/test-build';
import { readWallet, venueRows, type NodeRead, type VenueRow, type WalletRead, type WalletToken } from './where-it-sits';
import { PAR_ASSETS, quoteFromCandles, standing, type PartRead, type VenueMarketQuotes, type VenueQuote } from './standing';

/** How often each source is read again while a room is open. */
export const READ_EVERY_MS = 3_000;
/** How often valuation prices and venue market quotes are read again (30 seconds, named in ValuationNote). */
export const VALUATION_REFRESH_MS = READ_EVERY_MS * 10;

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

/**
 * The venue's vault read (J-derivatives-31 #3): its positions and its account value as the venue counts it, with its own
 * time, or why it was not read (a venue that reads no vaults, or one that did not answer): then the venue part is its
 * balances alone, and the room says vault positions were not read.
 */
export type VenueVaults = { read: true; asOf: string; holdings: VenueVaultHoldings } | { read: false; detail: string };

/**
 * The venue's staking read (J-cex-spot-21 #8): its rewards and its queue, with its own time, or why it was not read (a
 * venue that reports no staking, or one that did not answer). The staked, delegated and unstaking coins themselves are in
 * the balances' own lock split.
 */
export type VenueStakingRead = { read: true; asOf: string; account: VenueStakingAccount } | { read: false; detail: string };

export interface VenueRead {
  asOf: string;
  rows: VenueRow[];
  vaults: VenueVaults;
  staking: VenueStakingRead;
}

/** The venue account: the venue's balances with the open orders that lock them, its vault positions, and its times. */
export function useVenueRead(owner: string) {
  const venue = useVenueApi();
  return usePolled<VenueRead>(
    async (signal) => {
      const [balances, orders, vaults, staking] = await Promise.all([
        venue.balances(owner, signal),
        venue.openOrders(owner, signal),
        venue.vaultHoldings(owner, signal),
        venue.stakingAccount(owner, signal),
      ]);
      if (!balances.ok) return balances;
      if (!orders.ok) return orders;
      return {
        ok: true as const,
        data: {
          asOf: balances.data.asOf,
          rows: venueRows(balances.data.value, orders.data.value),
          vaults: vaults.ok
            ? { read: true, asOf: vaults.data.asOf, holdings: vaults.data.value }
            : { read: false, detail: vaults.message ?? '' },
          staking: staking.ok
            ? { read: true, asOf: staking.data.asOf, account: staking.data.value }
            : { read: false, detail: staking.message ?? '' },
        },
      };
    },
    `assets:venue:${owner}`,
    READ_EVERY_MS,
  );
}

/** What the partner holds for the person: every space it holds, by asset, with the partner's oldest time among them. */
export type PartnerRead =
  { state: 'reading' } | { state: 'unread' } | { state: 'none' } | (Extract<PartRead, { state: 'read' }> & { label: string });

export function usePartnerRead(): PartnerRead {
  const { api, userId } = useSession();
  const read = usePolled((signal) => api.call(BANK_SPACES_LIST, { limit: 200 }, { signal }), `standing:partner:${userId}`, READ_EVERY_MS);
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
  const read = usePolled((signal) => api.call(OPS_VALUATION_PRICES, undefined, { signal }), 'standing:prices', VALUATION_REFRESH_MS);
  return { prices: read.data, failed: !read.data && Boolean(read.failure) };
}

/**
 * The venue's own spot market quotes (last trade price and 24-hour open) for every non-par held asset that has a listed
 * USDT or USDC spot market on the venue (J-portfolio-01 #2 #7). Never read while valuation prices are unpublished.
 */
function useVenueMarketQuotes(
  enabled: boolean,
  venueName: string,
  venueTest: boolean,
  assets: readonly string[],
): VenueMarketQuotes | null {
  const venue = useVenueApi();
  const key = enabled && assets.length > 0 ? `standing:venue-quotes:${venueName}:${assets.join(',')}` : 'standing:venue-quotes:off';
  const read = usePolled<VenueMarketQuotes>(
    async (signal) => {
      if (!enabled || assets.length === 0) return null;
      const markets = await venue.markets(signal);
      if (!markets.ok) return markets;
      const spot = markets.data.value.filter((m) => m.kind === 'spot');
      const matched: Array<{ asset: string; symbol: string }> = [];
      for (const asset of assets) {
        const market =
          spot.find((m) => m.baseAsset.toUpperCase() === asset && m.quoteAsset.toUpperCase() === 'USDT') ??
          spot.find((m) => m.baseAsset.toUpperCase() === asset && m.quoteAsset.toUpperCase() === 'USDC');
        if (market) matched.push({ asset, symbol: market.symbol });
      }
      const byAsset = new Map<string, VenueQuote>();
      let latestAsOf = markets.data.asOf;
      await Promise.all(
        matched.map(async ({ asset, symbol }) => {
          const candles = await venue.candles(symbol, '1h', 25, signal);
          if (!candles.ok) {
            byAsset.set(asset, { symbol, last: null, open: null, windowStart: null });
            return;
          }
          if (Date.parse(candles.data.asOf) > Date.parse(latestAsOf)) latestAsOf = candles.data.asOf;
          byAsset.set(asset, quoteFromCandles(symbol, candles.data.value, candles.data.asOf));
        }),
      );
      return { ok: true as const, data: { venueName, test: venueTest, asOf: latestAsOf, byAsset } };
    },
    key,
    VALUATION_REFRESH_MS,
  );
  return enabled ? read.data : null;
}

/**
 * A venue read as a standing part: reading, unread, or its rows: each asset's total, free and locked together, and each
 * vault position the venue reports (J-derivatives-31 #3), counted as the venue counts it in the account's value.
 */
export function venuePart(read: { data: VenueRead | null; failure: unknown }): PartRead {
  if (!read.data) return read.failure ? { state: 'unread' } : { state: 'reading' };
  const vaults = read.data.vaults.read ? read.data.vaults.holdings.positions : [];
  return {
    state: 'read',
    asOf: read.data.asOf,
    rows: [
      ...read.data.rows.map((row) => ({ asset: row.asset, amount: row.total })),
      ...vaults.map((p) => ({ asset: p.asset, amount: p.equity, key: `vault:${p.vault}` })),
    ],
  };
}

/**
 * The venue's account value beside what its parts add to (J-derivatives-31 #3): the balances and vault positions held in
 * the account value's asset, summed exactly. `null` where the venue publishes no account value or vaults were not read.
 */
export function venueTotals(data: VenueRead): { asset: string; venue: string; parts: string } | null {
  if (!data.vaults.read || !data.vaults.holdings.accountValue) return null;
  const { asset, amount } = data.vaults.holdings.accountValue;
  let parts = 0n;
  for (const row of data.rows) if (row.asset === asset) parts += parseAmount(row.total);
  for (const p of data.vaults.holdings.positions) if (p.asset === asset) parts += parseAmount(p.equity);
  return { asset, venue: amount, parts: formatAmount(parts) };
}

/** A wallet read as a standing part. A token the chain did not answer for is in `unread` and is not a part's row. */
export function walletPart(read: { data: WalletRead | null }): PartRead {
  if (!read.data) return { state: 'reading' };
  if (!read.data.ok) return { state: 'unread' };
  return { state: 'read', asOf: read.data.asOf, rows: read.data.rows.map((row) => ({ asset: row.symbol, amount: row.amount })) };
}

/**
 * The partner account alone, valued at the published prices: what Assets and Home show of the money the partner bank
 * holds when no wallet or venue is read (the venue door off, or no wallet connected yet: the partner is read with no
 * wallet). `none` when the partner holds nothing of this person's.
 */
export function usePartnerStanding(unit: 'USD' | 'BTC') {
  const partner = usePartnerRead();
  const { prices, failed } = useValuationPrices();
  const result = standing(
    partner.state === 'none'
      ? []
      : [
          {
            id: 'partner' as const,
            label: partner.state === 'read' ? partner.label : '',
            test: isTestBuild(),
            read: partner.state === 'read' ? { state: 'read' as const, asOf: partner.asOf, rows: partner.rows } : partner,
          },
        ],
    failed ? null : prices,
    unit,
  );
  return { partner, standing: result, pricesFailed: failed, valued: result.parts.find((part) => part.id === 'partner') };
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
  const walletRead = walletPart(wallet);
  const venueRead = venuePart(venue);
  const partnerRead: PartRead | null =
    partner.state === 'none' ? null : partner.state === 'read' ? { state: 'read', asOf: partner.asOf, rows: partner.rows } : partner;
  const published = !failed && prices?.published ? prices : null;
  const venueAssets = (() => {
    if (!published) return [];
    const listed = new Set(published.prices.map((row) => row.asset.toUpperCase()));
    const need = new Set<string>();
    for (const part of [walletRead, venueRead, partnerRead]) {
      if (part?.state !== 'read') continue;
      for (const row of part.rows) {
        if (!/[1-9]/.test(row.amount)) continue;
        const code = row.asset.toUpperCase();
        if (!PAR_ASSETS.has(code) && !listed.has(code)) need.add(code);
      }
    }
    if (unit === 'BTC' && !listed.has('BTC')) need.add('BTC');
    return [...need].sort();
  })();
  const venueQuotes = useVenueMarketQuotes(Boolean(published), names.venue, names.venueTest, venueAssets);
  const result = standing(
    [
      // On a test build the wallet's chain and the partner are the stack's TEST adapters (J-home-ia-11 #3): their figures are
      // TEST figures, as every amount on a test build is. The venue says so itself.
      { id: 'wallet', label: names.network, read: walletRead, test: isTestBuild() },
      { id: 'venue', label: names.venue, read: venueRead, test: names.venueTest },
      ...(partner.state === 'none' || !partnerRead
        ? []
        : [
            {
              id: 'partner' as const,
              label: partner.state === 'read' ? partner.label : '',
              test: isTestBuild(),
              read: partnerRead,
            },
          ]),
    ],
    failed ? null : prices,
    unit,
    venueQuotes,
  );
  return { wallet, venue, partner, standing: result, pricesFailed: failed };
}
