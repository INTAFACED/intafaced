/**
 * Shared shapes for the redesign data layer (UI-SPEC §4.2). Screens code against
 * these and the hooks in this folder; they never call `api.rest` directly.
 * Money is always an exact decimal string, never a JS number.
 */

export type Decimal = string;

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; asOf: number }
  | { status: 'empty' }
  /** Typed 4xx refusal; the words come from `refusalCopy(code)`. */
  | { status: 'refused'; code: string }
  /** Network failure, 5xx or 502. */
  | { status: 'error'; retry: () => void };

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface MarketRow {
  symbol: string;
  base: string;
  quote: string;
  orderable: boolean;
  tickSize: Decimal;
  lotSize: Decimal;
  minAmount: Decimal | null;
  listedAt: string | null;
}

export interface TickerRow {
  symbol: string;
  last: Decimal | null;
  bid: Decimal | null;
  ask: Decimal | null;
  open24h: Decimal | null;
  high24h: Decimal | null;
  low24h: Decimal | null;
  change24h: Decimal | null;
  /** Ratio string, e.g. "-0.0028". */
  changePct24h: Decimal | null;
  baseVolume24h: Decimal | null;
  quoteVolume24h: Decimal | null;
  /** Epoch ms of the window start; earlier than now - 24h means a full window. */
  windowStart: number | null;
  source: 'server' | 'derived';
}

export interface Candle {
  t: number;
  o: Decimal;
  h: Decimal;
  l: Decimal;
  c: Decimal;
  v: Decimal;
  /** True when forward-filled for a silent interval. */
  filled: boolean;
}

export interface Holding {
  asset: string;
  class: 'cash' | 'crypto';
  total: Decimal;
  available: Decimal;
  inOrders: Decimal;
  usdValue: Decimal | null;
  usdChange24h: Decimal | null;
  share: Decimal | null;
  priceSymbol: string | null;
  /** The USD price the value used: "1" for dollar coins, the ticker's last price otherwise; absent when not priced. */
  priceUsd?: Decimal | null;
}

export interface PortfolioSummary {
  totalUsd: Decimal | null;
  change24hUsd: Decimal | null;
  change24hPct: Decimal | null;
  cashUsd: Decimal | null;
  cryptoUsd: Decimal | null;
  holdings: Holding[];
  unpriced: string[];
  source: 'server' | 'derived';
  asOf: number;
  /**
   * Added by the data layer. Epoch ms when today's change only covers part of a day
   * (a counted market is younger than 24 h): the screen says "since 14:00". Null for a full day.
   */
  windowStart?: number | null;
}

export interface Movers {
  gainers: TickerRow[];
  losers: TickerRow[];
}

export interface RefusalCopy {
  title: string;
  body: string;
  action?: { label: string; href: string };
  /** Short reference a customer can quote to support ("Ref SCR-1"). Never the raw service code. */
  reference?: string;
}
