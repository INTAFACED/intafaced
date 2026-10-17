import type { Sql } from 'postgres';
import { compareDecimal } from './decimal.js';
import {
  decidePayout,
  isNetworkRoutable,
  isVenueRoutable,
  isWalletRouteRoutable,
  type NetworkState,
  type PayoutRefusalCode,
  type VenueState,
  type WalletRouteState,
} from './policy.js';
import * as store from './store.js';

/**
 * READ API FOR INTERNAL CONSUMERS (the conversion workstream, W6).
 *
 * Returns ONLY entries that are enabled AND fully configured. A blank limit,
 * confirmation count, fee source or payout cap drops the entry from every answer
 * here, so a consumer cannot route through a half-set row by accident. It is a
 * plain module, not a procedure: it has no wire surface and no founder session.
 *
 * It reads the database on every call and never caches: an unreadable registry
 * throws, which the caller must treat as "refuse", never as "empty, so anything
 * goes". "No entry" is the same answer as "unreadable" for routing purposes.
 */
export interface RegistryReader {
  /** Enabled, testnet, fully configured venues, best priority first (lowest number first). */
  listRoutableVenues(): Promise<VenueState[]>;
  /** Routable venues that list `pair` and accept `amount` (within min and max), in priority order. */
  venuesFor(request: { pair: string; amount: string }): Promise<VenueState[]>;
  listRoutableNetworks(): Promise<NetworkState[]>;
  /** The routable wallet routes (payout allowed, cap set) whose network is also routable and lists the asset. */
  listRoutableWalletRoutes(): Promise<WalletRouteState[]>;
  /** May this merchant be paid out `amount` of `assetCode` on `networkId`? Refuses with a typed code, never throws for a "no". */
  evaluatePayout(request: {
    assetCode: string;
    networkId: string;
    merchantId: string;
    amount: string;
  }): Promise<{ allowed: true; route: WalletRouteState; network: NetworkState } | { allowed: false; code: PayoutRefusalCode }>;
}

export function createRegistryReader(sql: Sql): RegistryReader {
  const strip = store.stateOf;
  const routableVenues = async (): Promise<VenueState[]> => (await store.listVenues(sql)).map(strip).filter(isVenueRoutable);
  const routableNetworks = async (): Promise<NetworkState[]> => (await store.listNetworks(sql)).map(strip).filter(isNetworkRoutable);

  return {
    listRoutableVenues: routableVenues,

    async venuesFor({ pair, amount }) {
      return (await routableVenues()).filter(
        (v) => v.supportedPairs.includes(pair) && compareDecimal(amount, v.minOrder!) >= 0 && compareDecimal(amount, v.maxOrder!) <= 0,
      );
    },

    listRoutableNetworks: routableNetworks,

    async listRoutableWalletRoutes() {
      const networks = new Map((await routableNetworks()).map((n) => [n.networkId, n]));
      return (await store.listWalletRoutes(sql))
        .map(store.walletRouteState)
        .filter((r) => isWalletRouteRoutable(r) && networks.get(r.networkId)?.assetCodes.includes(r.assetCode) === true);
    },

    async evaluatePayout({ assetCode, networkId, merchantId, amount }) {
      const [route, network] = await Promise.all([store.getWalletRoute(sql, assetCode, networkId), store.getNetwork(sql, networkId)]);
      const routeState = route === null ? null : store.walletRouteState(route);
      const networkState = network === null ? null : strip(network);
      const decision = decidePayout(routeState, networkState, { merchantId, amount });
      return decision.allowed ? { allowed: true, route: routeState!, network: networkState! } : decision;
    },
  };
}
