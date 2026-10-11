/**
 * Pre-trade credit dimensions (CARD F5 / PTX-M09-R10 / PX-S06).
 *
 * Firm/session credit: max-order, max-position, max-loss. Unset / null / blank /
 * non-integer refuses NEW risk. Published owner integers (including 0) pass
 * through. This mill does not invent those numbers, does not default a
 * dimension to 0, and does not collapse the three dimensions into one cap.
 *
 * Hitch: wrap `TradeService.placeOrder` and `PositionService.open` so the mill
 * runs BEFORE `recipes.orderHold` / `recipes.futuresMarginLock`. Increase of
 * new risk uses the same doors. Cancel/close/reduce stay.
 *
 * Live boot: `src/index.ts` already imports `ledger-client.ts`, which loads
 * this mill. router.ts / trade-service.ts / position-service.ts / index.ts
 * are not recut.
 */
import type { Principal } from '@intafaced/auth';
import { parseOwnerIntegerEnv } from '../owner-int-env.js';
import { TradeError, type TradeErrorCode } from '../spot/types.js';
import { TradeService, type PlaceOrderInput } from '../spot/trade-service.js';
import { FuturesError, PositionService, type OpenPositionInput } from './position-service.js';

export const MAX_ORDER_UNSET = 'trade.max_order_unset' as const;
export const MAX_POSITION_UNSET = 'trade.max_position_unset' as const;
export const MAX_LOSS_UNSET = 'trade.max_loss_unset' as const;

export type PreTradeCreditRefuseCode = typeof MAX_ORDER_UNSET | typeof MAX_POSITION_UNSET | typeof MAX_LOSS_UNSET;

export interface PreTradeCreditDimensions {
  readonly maxOrder?: string | number | null;
  readonly maxPosition?: string | number | null;
  readonly maxLoss?: string | number | null;
}

export type PreTradeCreditCheck =
  | { readonly ok: true; readonly maxOrder: number; readonly maxPosition: number; readonly maxLoss: number }
  | { readonly ok: false; readonly code: PreTradeCreditRefuseCode; readonly reason: string };

/** Owner integer. Blank / unset / non-integer → null. 0 is published, not a default. */
function publishedOwnerInteger(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  return parseOwnerIntegerEnv(raw);
}

export function readOwnerPreTradeCredit(env: NodeJS.ProcessEnv = process.env): PreTradeCreditDimensions {
  return {
    maxOrder: env.TRADE_MAX_ORDER,
    maxPosition: env.TRADE_MAX_POSITION,
    maxLoss: env.TRADE_MAX_LOSS,
  };
}

/**
 * Unset any dimension refuses. Published owner integers admit (including 0).
 * This function does not compare an order against a cap and does not collapse dimensions.
 */
export function checkPreTradeCreditDimensions(dims: PreTradeCreditDimensions): PreTradeCreditCheck {
  const maxOrder = publishedOwnerInteger(dims.maxOrder);
  if (maxOrder == null) {
    return {
      ok: false,
      code: MAX_ORDER_UNSET,
      reason: 'TRADE_MAX_ORDER is unset — refuse new risk rather than invent a max-order',
    };
  }
  const maxPosition = publishedOwnerInteger(dims.maxPosition);
  if (maxPosition == null) {
    return {
      ok: false,
      code: MAX_POSITION_UNSET,
      reason: 'TRADE_MAX_POSITION is unset — refuse new risk rather than invent a max-position',
    };
  }
  const maxLoss = publishedOwnerInteger(dims.maxLoss);
  if (maxLoss == null) {
    return {
      ok: false,
      code: MAX_LOSS_UNSET,
      reason: 'TRADE_MAX_LOSS is unset — refuse new risk rather than invent a max-loss',
    };
  }
  return { ok: true, maxOrder, maxPosition, maxLoss };
}

function refusePlace(check: Extract<PreTradeCreditCheck, { ok: false }>): never {
  throw new TradeError(check.reason, check.code as TradeErrorCode);
}

function refuseOpen(check: Extract<PreTradeCreditCheck, { ok: false }>): never {
  throw new FuturesError(check.reason, check.code, 400);
}

const PLACE_FLAG = Symbol.for('intafaced.trade.preTradeCreditPlace');
const OPEN_FLAG = Symbol.for('intafaced.trade.preTradeCreditOpen');

export function installPreTradeCreditPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<unknown>;
    [PLACE_FLAG]?: true;
  };
  if (proto[PLACE_FLAG]) return;
  proto[PLACE_FLAG] = true;
  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const check = checkPreTradeCreditDimensions(readOwnerPreTradeCredit());
    if (!check.ok) refusePlace(check);
    return origPlace.call(this, principal, input);
  };
}

export function installPreTradeCreditOpen(ctor: typeof PositionService): void {
  const proto = ctor.prototype as unknown as {
    open: (input: OpenPositionInput, principal?: Principal) => Promise<unknown>;
    [OPEN_FLAG]?: true;
  };
  if (proto[OPEN_FLAG]) return;
  proto[OPEN_FLAG] = true;
  const origOpen = proto.open;
  proto.open = async function (this: PositionService, input: OpenPositionInput, principal?: Principal) {
    const check = checkPreTradeCreditDimensions(readOwnerPreTradeCredit());
    if (!check.ok) refuseOpen(check);
    return origOpen.call(this, input, principal);
  };
}

export function installPreTradeCredit(): void {
  installPreTradeCreditPlace(TradeService);
  installPreTradeCreditOpen(PositionService);
}

installPreTradeCredit();
