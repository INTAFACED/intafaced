/**
 * Open-interest and concentration limits on a futures open (D-margin-05, J-derivatives-02 #7).
 *
 * The operator publishes two limits per futures market on its versioned, four-eyes limits row (`admin/risk.ts`): the
 * market's largest open interest in its base asset, and the largest share of that limit one account may hold, in bps.
 * Open interest is the sum of position sizes, as the ticker counts it, with closing positions still counted until they
 * close; an opening order counts from the moment it is placed by what it can still fill, so live orders cannot
 * together carry the market past its limit:
 *
 *   market committed  = every open or closing position's size + every live opening order's unfilled size, on this market
 *   account committed = the same, for this account only
 *   account cap       = limit x share / 10000
 *
 * An opening order is refused when it would carry the account past its cap (`trade.oi_share_limit`) or the market
 * past its limit (`trade.oi_limit`). Exactly at a limit is allowed. The refusal names the room left, cut to the
 * market's lot so it is a size the trader can send. A market with either limit blank refuses every open
 * (`trade.oi_limit_unset`): a missing concentration limit never means unlimited. Reduce-only orders never meet this.
 * A lowered limit blocks new opens and never closes a position.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';

export const OI_LIMIT_UNSET = 'trade.oi_limit_unset';
export const OI_LIMIT = 'trade.oi_limit';
export const OI_SHARE_LIMIT = 'trade.oi_share_limit';
/** The preview's open-interest line when the room could not be read for a reason that is not a blank limit. */
export const OI_ROOM_UNAVAILABLE = 'trade.oi_room_unavailable';

/** The HTTP status of a limit refusal, as the owner's pre-trade limits answer (`pretrade-limits.ts`). */
const OI_LIMIT_HTTP_STATUS = 422;

const BPS = 10_000n;

export interface OpenInterestLimits {
  /** The market's largest open interest, in its base asset. */
  readonly limit: Amount;
  /** The largest share of `limit` one account may hold, in bps. */
  readonly shareBps: number;
}

export interface OpenInterestRoom {
  readonly limit: Amount;
  readonly shareBps: number;
  /** `limit x shareBps / 10000`, rounded down. */
  readonly accountCap: Amount;
  readonly marketCommitted: Amount;
  readonly accountCommitted: Amount;
  /** The most this account may still open, cut to the lot; never below zero. */
  readonly room: Amount;
  /** Which limit sets the room: the account's share or the market's limit. */
  readonly binding: 'account' | 'market';
}

export interface OpenInterestRefusal {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

/**
 * The operator's two values, or null when either is blank or unreadable. A malformed stored value counts as blank,
 * so it refuses rather than being read as some number.
 */
export function readOpenInterestLimits(
  row: { readonly oiLimit: string | null; readonly oiShareBps: string | null } | null,
): OpenInterestLimits | null {
  if (row?.oiLimit == null || row.oiShareBps == null) return null;
  let limit: Amount;
  try {
    limit = parseAmount(row.oiLimit);
  } catch {
    return null;
  }
  const shareBps = /^\d+$/.test(row.oiShareBps) ? Number(row.oiShareBps) : NaN;
  if (limit < 0n || !Number.isSafeInteger(shareBps) || shareBps < 1 || shareBps > 10_000) return null;
  return { limit, shareBps };
}

export function openInterestUnsetRefusal(symbol: string): OpenInterestRefusal {
  return {
    code: OI_LIMIT_UNSET,
    message: `no open-interest limit is published for ${symbol}, so no open can be sized against it; nothing was held`,
    status: 503,
  };
}

/** The room this account has left on the market before this order. */
export function openInterestRoom(input: {
  readonly limits: OpenInterestLimits;
  readonly marketCommitted: Amount;
  readonly accountCommitted: Amount;
  readonly lotSize: Amount | null;
}): OpenInterestRoom {
  const { limit, shareBps } = input.limits;
  const accountCap = ((limit * BigInt(shareBps)) / BPS) as Amount;
  const accountLeft = accountCap - input.accountCommitted;
  const marketLeft = limit - input.marketCommitted;
  const binding = accountLeft <= marketLeft ? 'account' : 'market';
  const left = binding === 'account' ? accountLeft : marketLeft;
  const positive = left > 0n ? left : 0n;
  const lot = input.lotSize != null && input.lotSize > 0n ? input.lotSize : null;
  const room = (lot ? positive - (positive % lot) : positive) as Amount;
  return {
    limit,
    shareBps,
    accountCap,
    marketCommitted: input.marketCommitted,
    accountCommitted: input.accountCommitted,
    room,
    binding,
  };
}

function percent(bps: number): string {
  return `${Math.floor(bps / 100)}${bps % 100 === 0 ? '' : `.${String(bps % 100).padStart(2, '0')}`}%`;
}

/** The refusal an opening order of `qty` meets against `room`, or null when it fits. */
export function openInterestRefusal(room: OpenInterestRoom, qty: Amount, baseAsset: string): OpenInterestRefusal | null {
  const accountAfter = room.accountCommitted + qty;
  const marketAfter = room.marketCommitted + qty;
  const overAccount = accountAfter > room.accountCap;
  const overMarket = marketAfter > room.limit;
  if (!overAccount && !overMarket) return null;
  const left = `room left ${formatAmount(room.room)} ${baseAsset}`;
  // When both are over, the one that sets the room is named, so the room in the words is the one that applies.
  if (overAccount && (room.binding === 'account' || !overMarket)) {
    return {
      code: OI_SHARE_LIMIT,
      status: OI_LIMIT_HTTP_STATUS,
      message:
        `this order would take your open interest on this market to ${formatAmount(accountAfter)} ${baseAsset}, past the ` +
        `${formatAmount(room.accountCap)} ${baseAsset} one account may hold (${percent(room.shareBps)} of the market's ` +
        `limit of ${formatAmount(room.limit)} ${baseAsset}); ${left}`,
    };
  }
  return {
    code: OI_LIMIT,
    status: OI_LIMIT_HTTP_STATUS,
    message:
      `this order would take the market's open interest to ${formatAmount(marketAfter)} ${baseAsset}, past its limit ` +
      `of ${formatAmount(room.limit)} ${baseAsset}; ${left}`,
  };
}
