/**
 * Pre-trade credit dimensions (CARD F5 / PTX-M09-R10 / PX-S06).
 *
 * Firm/session credit: max-order, max-position, max-loss. Unset any of the
 * three refuses NEW risk. This mill does not invent those numbers and does
 * not recut router.ts, trade-service.ts, position-service.ts, index.ts,
 * types.ts, or ccxt-errors.ts.
 *
 * Hitch: `checkPreTradeCredit` / `assertPreTradeCreditOrThrow` is the live
 * function place/open jobs SHOULD call before hold/lock (same shape as
 * `checkMarginModeForFuturesOpen` → FuturesError). Hosts currently do not
 * invent TRADE_MAX_* defaults. Owner integers come from TRADE_MAX_ORDER_QTY /
 * TRADE_MAX_POSITION / TRADE_MAX_LOSS via parseOwnerIntegerEnv (blank → null).
 * 0 is unset, not unlimited. Dimensions stay independent — never netted.
 */
import { parseOwnerIntegerEnv } from '../owner-int-env.js';
import { FuturesError } from './position-service.js';

export const MAX_ORDER_UNSET = 'trade.max_order_unset';
export const MAX_POSITION_UNSET = 'trade.max_position_unset';
export const MAX_LOSS_UNSET = 'trade.max_loss_unset';

export const TRADE_MAX_ORDER_QTY_ENV = 'TRADE_MAX_ORDER_QTY';
export const TRADE_MAX_POSITION_ENV = 'TRADE_MAX_POSITION';
export const TRADE_MAX_LOSS_ENV = 'TRADE_MAX_LOSS';

export type PreTradeCreditRefuseCode = typeof MAX_ORDER_UNSET | typeof MAX_POSITION_UNSET | typeof MAX_LOSS_UNSET;

export type PreTradeCreditInput = {
  readonly maxOrder: unknown;
  readonly maxPosition: unknown;
  readonly maxLoss: unknown;
};

export type PreTradeCreditCheck =
  { readonly ok: true } | { readonly ok: false; readonly code: PreTradeCreditRefuseCode; readonly reason: string };

/** Positive owner integer. Blank / 0 / negative / non-integer → null. Never invent a cap. */
function publishedPositiveOwnerInteger(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = parseOwnerIntegerEnv(raw);
  if (n == null || n <= 0) return null;
  return n;
}

function refuse(code: PreTradeCreditRefuseCode, reason: string): PreTradeCreditCheck {
  return { ok: false, code, reason };
}

/**
 * Owner env, convert-spread shape: blank / unset → the raw value (undefined or '').
 * parseOwnerIntegerEnv happens in checkPreTradeCredit. Do not default to 0.
 */
export function readOwnerPreTradeCredit(env: NodeJS.ProcessEnv = process.env): PreTradeCreditInput {
  return {
    maxOrder: env[TRADE_MAX_ORDER_QTY_ENV],
    maxPosition: env[TRADE_MAX_POSITION_ENV],
    maxLoss: env[TRADE_MAX_LOSS_ENV],
  };
}

/**
 * Unset any dimension refuses that dimension's code. Published positive owner
 * integers admit. This function does not compare an order against a cap.
 */
export function checkPreTradeCredit(input: PreTradeCreditInput): PreTradeCreditCheck {
  if (publishedPositiveOwnerInteger(input.maxOrder) == null) {
    return refuse(MAX_ORDER_UNSET, 'TRADE_MAX_ORDER_QTY is unset — refuse new risk rather than invent a max-order');
  }
  if (publishedPositiveOwnerInteger(input.maxPosition) == null) {
    return refuse(MAX_POSITION_UNSET, 'TRADE_MAX_POSITION is unset — refuse new risk rather than invent a max-position');
  }
  if (publishedPositiveOwnerInteger(input.maxLoss) == null) {
    return refuse(MAX_LOSS_UNSET, 'TRADE_MAX_LOSS is unset — refuse new risk rather than invent a max-loss');
  }
  return { ok: true };
}

export function checkOwnerPreTradeCredit(env: NodeJS.ProcessEnv = process.env): PreTradeCreditCheck {
  return checkPreTradeCredit(readOwnerPreTradeCredit(env));
}

/** Mill throw — FuturesError carrying mill string codes, not TradeErrorCode. */
export function assertPreTradeCreditOrThrow(input: PreTradeCreditInput = readOwnerPreTradeCredit()): void {
  const check = checkPreTradeCredit(input);
  if (!check.ok) {
    throw new FuturesError(check.reason, check.code, 400);
  }
}
