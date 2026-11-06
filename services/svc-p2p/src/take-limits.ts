/**
 * P-trade-orders-03 and -05. The owner's take limits: the most ongoing orders one person may hold as taker, the
 * per-order fiat bounds of each asset and fiat pair, and how many cancelled orders pause a person's buying.
 *
 * Both are owner data. Blank is unset, and an unset limit refuses every take `p2p.config_unset`: a missing cap is
 * not "no cap" and a missing pair is not "any amount". Pair bounds are decimal strings in the pair's fiat; a JSON
 * number, a partial row or min above max is not a table.
 */
import { compare, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TERMINAL_STATUSES, TRADE_STATUSES } from './state.js';

/** The trade states that count as an ongoing order: every state that is not finished. */
export const ONGOING_TRADE_STATUSES = TRADE_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status));

export interface PairBounds {
  min: Amount;
  max: Amount;
}

export type PairLimitConfig = { status: 'unset' } | { status: 'invalid' } | { status: 'active'; pairs: ReadonlyMap<string, PairBounds> };

/**
 * P-trade-orders-05. A buyer who has cancelled `limit` orders within the last `windowHours` (their own cancels and
 * payment windows they let run out) may not buy again until the oldest of those leaves the window. Either value
 * `null` is unset.
 */
export interface BuyerCancelLimit {
  limit: number | null;
  windowHours: number | null;
}

export interface TakeLimits {
  /** Whole number of ongoing orders, at least 1. `null` is unset. */
  activeOrderCap: number | null;
  pairLimits: PairLimitConfig;
  buyerCancels: BuyerCancelLimit;
}

/**
 * How a cancelled order's `resolution_reason` names the buyer as its cause: the buyer cancelled it (`buyer.<their
 * reason>`), or the payment window ran out on them. A seller's cancel, a lock that never completed and a moderator's
 * refund are not the buyer's doing.
 */
export const BUYER_CANCEL_REASON_PREFIX = 'buyer.';
export const BUYER_TIMEOUT_REASON = 'timeout.payment_window_elapsed';

const DECIMAL = /^\d{1,20}(\.\d{1,18})?$/;
const PAIR = /^[A-Z0-9]{2,16}\/[A-Z]{3}$/;

export function pairKey(asset: string, fiat: string): string {
  return `${asset.toUpperCase()}/${fiat.toUpperCase()}`;
}

/** Blank or omitted is unset. A whole number of 1 or more is the value; anything else is unset, never a guess. */
export function parseActiveOrderCap(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isSafeInteger(raw) || raw < 1) return null;
  return raw;
}

/** Both whole numbers of 1 or more, or the limit is unset. */
export function parseBuyerCancelLimit(limit: number | null | undefined, windowHours: number | null | undefined): BuyerCancelLimit {
  const l = parseActiveOrderCap(limit);
  const w = parseActiveOrderCap(windowHours);
  return l === null || w === null ? { limit: null, windowHours: null } : { limit: l, windowHours: w };
}

/** `{"USDT/EUR":{"min":"10","max":"5000"}}`. Blank is unset; anything else that is not a full table is invalid. */
export function parsePairLimits(raw: unknown): PairLimitConfig {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { status: 'unset' };
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { status: 'invalid' };
    }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' };
  const pairs = new Map<string, PairBounds>();
  for (const [key, row] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PAIR.test(key) || row == null || typeof row !== 'object' || Array.isArray(row)) return { status: 'invalid' };
    const { min, max, ...rest } = row as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return { status: 'invalid' };
    if (typeof min !== 'string' || typeof max !== 'string' || !DECIMAL.test(min) || !DECIMAL.test(max)) return { status: 'invalid' };
    const bounds = { min: parseAmount(min), max: parseAmount(max) };
    if (compare(bounds.min, bounds.max) > 0) return { status: 'invalid' };
    pairs.set(key, bounds);
  }
  if (pairs.size === 0) return { status: 'invalid' };
  return { status: 'active', pairs };
}

export type PairRefusal =
  { code: 'p2p.config_unset'; reason: 'unset' | 'invalid' | 'pair_unlisted' } | { code: 'p2p.pair_limit_exceeded'; bounds: PairBounds };

/** Whether a take of `fiatAmount` on this pair may proceed. */
export function pairLimitRefusal(config: PairLimitConfig, input: { asset: string; fiat: string; fiatAmount: Amount }): PairRefusal | null {
  if (config.status !== 'active') return { code: 'p2p.config_unset', reason: config.status };
  const bounds = config.pairs.get(pairKey(input.asset, input.fiat));
  if (!bounds) return { code: 'p2p.config_unset', reason: 'pair_unlisted' };
  if (compare(input.fiatAmount, bounds.min) < 0 || compare(input.fiatAmount, bounds.max) > 0) {
    return { code: 'p2p.pair_limit_exceeded', bounds };
  }
  return null;
}
