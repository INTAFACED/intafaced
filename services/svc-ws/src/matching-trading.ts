/**
 * Matching trading status on public depth / private orders streams.
 *
 * A live ladder or blotter without this name looks tradable while matching is
 * refusing submits (halt / prelaunch / expire / delist). Status is a sidecar
 * `{ type: 'status', code }` — never an invented price or a seq-0 empty book.
 */

export const DEPTH_MARKET_HALTED = 'depth.market_halted' as const;
export const DEPTH_VENUE_HALTED = 'depth.venue_halted' as const;
export const DEPTH_MARKET_PRELAUNCH = 'depth.market_prelaunch' as const;
export const DEPTH_MARKET_EXPIRED = 'depth.market_expired' as const;
export const DEPTH_MARKET_DELISTED = 'depth.market_delisted' as const;

export const ORDERS_MARKET_HALTED = 'orders.market_halted' as const;
export const ORDERS_VENUE_HALTED = 'orders.venue_halted' as const;
export const ORDERS_MARKET_PRELAUNCH = 'orders.market_prelaunch' as const;
export const ORDERS_MARKET_EXPIRED = 'orders.market_expired' as const;
export const ORDERS_MARKET_DELISTED = 'orders.market_delisted' as const;
/** A halt this seat already heard is gone. Not OPEN, not a price, not a depth code. */
export const ORDERS_SUBMITS_RESUMED = 'orders.submits_resumed' as const;

export type DepthMatchingTradingCode =
  | typeof DEPTH_MARKET_HALTED
  | typeof DEPTH_VENUE_HALTED
  | typeof DEPTH_MARKET_PRELAUNCH
  | typeof DEPTH_MARKET_EXPIRED
  | typeof DEPTH_MARKET_DELISTED;

export type OrdersMatchingTradingCode =
  | typeof ORDERS_MARKET_HALTED
  | typeof ORDERS_VENUE_HALTED
  | typeof ORDERS_MARKET_PRELAUNCH
  | typeof ORDERS_MARKET_EXPIRED
  | typeof ORDERS_MARKET_DELISTED;

/** Strongest named refusal wins when matching reports more than one flag. */
const DEPTH_RANK: readonly DepthMatchingTradingCode[] = [
  DEPTH_MARKET_DELISTED,
  DEPTH_MARKET_EXPIRED,
  DEPTH_MARKET_PRELAUNCH,
  DEPTH_MARKET_HALTED,
  DEPTH_VENUE_HALTED,
];

export function strongerTradingCode(
  a: DepthMatchingTradingCode | null | undefined,
  b: DepthMatchingTradingCode | null | undefined,
): DepthMatchingTradingCode | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return DEPTH_RANK.indexOf(a) <= DEPTH_RANK.indexOf(b) ? a : b;
}

/**
 * Read matching's public flags. Missing flags are unknown, not invented OPEN.
 * Unknown stays tradable-looking only until matching publishes the flags —
 * this parser never guesses halt from an empty book.
 */
export function parseMatchingTrading(raw: unknown): DepthMatchingTradingCode | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const status = typeof o.status === 'string' ? o.status : '';
  if (o.delisted === true || status === 'delisted' || status === 'market_delisted') return DEPTH_MARKET_DELISTED;
  if (o.expired === true || status === 'expired' || status === 'market_expired') return DEPTH_MARKET_EXPIRED;
  if (o.prelaunch === true || status === 'prelaunch' || status === 'market_prelaunch') return DEPTH_MARKET_PRELAUNCH;
  if (o.halted === true || status === 'halted' || status === 'market_halted') return DEPTH_MARKET_HALTED;
  if (o.venueHalted === true || o.venue_halted === true || status === 'venue_halted') return DEPTH_VENUE_HALTED;
  return null;
}

export interface MatchingTradingBoard {
  readonly venueHalted: boolean;
  readonly byMarket: ReadonlyMap<string, DepthMatchingTradingCode>;
}

function addBoardIds(byMarket: Map<string, DepthMatchingTradingCode>, ids: unknown, code: DepthMatchingTradingCode): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    byMarket.set(id, strongerTradingCode(byMarket.get(id), code) ?? code);
  }
}

/** Extra arrays on matching `GET /markets` — `{ markets: string[] }` still the id list. */
export function parseMatchingBoard(raw: unknown): MatchingTradingBoard {
  const byMarket = new Map<string, DepthMatchingTradingCode>();
  if (raw === null || typeof raw !== 'object') return { venueHalted: false, byMarket };
  const o = raw as Record<string, unknown>;
  addBoardIds(byMarket, o.delisted, DEPTH_MARKET_DELISTED);
  addBoardIds(byMarket, o.expired, DEPTH_MARKET_EXPIRED);
  addBoardIds(byMarket, o.prelaunch, DEPTH_MARKET_PRELAUNCH);
  addBoardIds(byMarket, o.halted, DEPTH_MARKET_HALTED);
  const venueHalted = o.venueHalted === true || o.venue_halted === true;
  return { venueHalted, byMarket };
}

export function tradingFromBoard(board: MatchingTradingBoard | null | undefined, marketId: string): DepthMatchingTradingCode | null {
  if (!board) return null;
  return board.byMarket.get(marketId) ?? (board.venueHalted ? DEPTH_VENUE_HALTED : null);
}

export function ordersCodeForDepth(code: DepthMatchingTradingCode): OrdersMatchingTradingCode {
  switch (code) {
    case DEPTH_MARKET_DELISTED:
      return ORDERS_MARKET_DELISTED;
    case DEPTH_MARKET_EXPIRED:
      return ORDERS_MARKET_EXPIRED;
    case DEPTH_MARKET_PRELAUNCH:
      return ORDERS_MARKET_PRELAUNCH;
    case DEPTH_MARKET_HALTED:
      return ORDERS_MARKET_HALTED;
    case DEPTH_VENUE_HALTED:
      return ORDERS_VENUE_HALTED;
  }
}

export interface DepthMatchingTradingFrame {
  readonly type: 'status';
  readonly code: DepthMatchingTradingCode;
  readonly marketId: string;
}

export function depthMatchingTradingFrame(marketId: string, code: DepthMatchingTradingCode): string {
  const frame: DepthMatchingTradingFrame = { type: 'status', code, marketId };
  return JSON.stringify(frame);
}

export interface OrdersMatchingTradingFrame {
  readonly type: 'status';
  readonly code: OrdersMatchingTradingCode;
  readonly channel: 'orders' | 'fills';
  readonly userId: string;
  readonly marketId?: string;
}

export function ordersMatchingTradingFrame(
  userId: string,
  code: OrdersMatchingTradingCode,
  marketId?: string,
  channel: 'orders' | 'fills' = 'orders',
): string {
  const frame: OrdersMatchingTradingFrame =
    marketId === undefined || code === ORDERS_VENUE_HALTED
      ? { type: 'status', code, channel, userId }
      : { type: 'status', code, channel, userId, marketId };
  return JSON.stringify(frame);
}

export interface OrdersSubmitsResumedFrame {
  readonly type: 'status';
  readonly code: typeof ORDERS_SUBMITS_RESUMED;
  readonly channel: 'orders' | 'fills';
  readonly userId: string;
  readonly marketId?: string;
}

/** Venue resume omits marketId, matching the venue halt frame this seat already has. */
export function ordersSubmitsResumedFrame(userId: string, channel: 'orders' | 'fills', marketId?: string): string {
  const frame: OrdersSubmitsResumedFrame =
    marketId === undefined
      ? { type: 'status', code: ORDERS_SUBMITS_RESUMED, channel, userId }
      : { type: 'status', code: ORDERS_SUBMITS_RESUMED, channel, userId, marketId };
  return JSON.stringify(frame);
}

/** A priced snapshot while matching is not taking submits is a tradable lie. */
export function wouldInventTradableBook(hasRestingDepth: boolean, trading: DepthMatchingTradingCode | null): boolean {
  return hasRestingDepth && trading !== null;
}
