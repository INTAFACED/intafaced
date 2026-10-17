/**
 * The Options room's reads. Policy and the market list are public; orders are private and come from the desk's
 * shared reads, cut down to option markets here. Nothing is guessed: a read that fails stays failed.
 */
import { useMemo } from 'react';
import type { Order } from '../../../features/trade/trade-api';
import type { OptionsPolicy, ListedMarket } from '../rooms/api';
import { ROOM_INTERVALS, usePublicRead, useRoomApi } from '../rooms/read';
import type { Loadable } from '../rooms/ui';
import { useClosedOrders, useOpenOrders } from '../desk/data';

export function useOptionsPolicy(): Loadable<OptionsPolicy> {
  const api = useRoomApi();
  return usePublicRead('options-policy', (signal) => api.optionsPolicy(signal), ROOM_INTERVALS.policy);
}

/** Only the markets the service marks as options. Spot and futures rows are dropped before anything renders. */
export function useOptionMarkets(): Loadable<ListedMarket[]> {
  const api = useRoomApi();
  return usePublicRead(
    'options-markets',
    async (signal) => {
      const result = await api.markets(signal);
      return result.ok ? { ok: true, data: result.data.filter((market) => market.option) } : result;
    },
    ROOM_INTERVALS.markets,
  );
}

function onlyOptions(load: Loadable<Order[]>, symbols: ReadonlySet<string>): Loadable<Order[]> {
  return load.status === 'ready' ? { ...load, data: load.data.filter((order) => symbols.has(order.symbol)) } : load;
}

/** Open and closed orders in option markets. History is only fetched while its tab shows. */
export function useOptionOrders(
  symbols: ReadonlySet<string>,
  historyShown: boolean,
): { open: Loadable<Order[]>; closed: Loadable<Order[]> } {
  const open = useOpenOrders();
  const closed = useClosedOrders(historyShown);
  return useMemo(() => ({ open: onlyOptions(open, symbols), closed: onlyOptions(closed, symbols) }), [open, closed, symbols]);
}
