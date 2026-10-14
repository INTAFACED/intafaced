/**
 * What every panel needs from the desk: the coin being traded and the polled reads that more than one panel shows.
 * `index.tsx` (the desk) reads them once through the tab's one scheduler and provides them here; a panel reads what
 * it needs with `useDesk()`. This replaces the old props chain from `Desk` to each column.
 */
import { createContext, useContext } from 'react';
import type { OrderBook as WireBook, Trade } from '@intafaced/exchange-contract/schemas';
import type { BalanceEntry } from '../../../data/derive';
import type { Order } from '../../../features/trade/trade-api';
import type { Preferences } from '../../../shared/preferences';
import type { BookPick } from '../desk/OrderBook';
import type { BottomTab } from '../desk/BottomTabs';
import type { Loadable, TickerRow } from '../desk/deps';
import type { DeskMarket } from '../desk/market';
import type { Reference, Side } from '../desk/order-math';
import type { ConnectionState } from './connection';

export interface DeskShared {
  market: DeskMarket;
  markets: DeskMarket[];
  zone: Preferences['timeZone'];
  ticker: Loadable<TickerRow>;
  book: Loadable<WireBook>;
  balances: Loadable<Record<string, BalanceEntry>>;
  openOrders: Loadable<Order[]>;
  fills: Loadable<Trade[]>;
  /** Best bid and ask of the book, stable between updates that change nothing. */
  reference: Reference | null;
  referenceFresh: boolean;
  suggestion: BookPick | null;
  focusSide: Side | null;
  bottomTab: BottomTab;
  setBottomTab: (tab: BottomTab) => void;
  onPick: (pick: BookPick) => void;
  onPickPrice: (price: string) => void;
  onPlaced: () => void;
  connection: ConnectionState;
}

const Context = createContext<DeskShared | null>(null);
export const DeskProvider = Context.Provider;

export function useDesk(): DeskShared {
  const value = useContext(Context);
  if (!value) throw new Error('useDesk() outside the desk');
  return value;
}
