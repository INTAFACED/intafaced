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
 * this mill and marks the production posture (`markPreTradeCreditInstalled`).
 *
 * This mill only proves the three limits are published (the early refusal).
 * The comparison itself, #4725, lives in `pretrade-limits.ts` and is called
 * from the admission seam of each order door: `TradeService.placeOrderInner`
 * (every placed order, copy mirror and algo child included),
 * `TradeService.convertExecute`, `PositionService.open`, and the native qty-up
 * amend. Closes, liquidation, ADL, reconcile and seeded MM never call it.
 */
import type { Principal } from '@intafaced/auth';
import {
  checkPreTradeCreditDimensions,
  markPreTradeCreditInstalled,
  readOwnerPreTradeCredit,
  type PreTradeCreditCheck,
} from './pretrade-limits.js';
import { TradeError, type TradeErrorCode } from '../spot/types.js';
import { TradeService, type PlaceOrderInput } from '../spot/trade-service.js';
import { FuturesError, PositionService, type OpenPositionInput } from './position-service.js';

export {
  MAX_LOSS_UNSET,
  MAX_ORDER_UNSET,
  MAX_POSITION_UNSET,
  checkPreTradeCreditDimensions,
  readOwnerPreTradeCredit,
  type PreTradeCreditCheck,
  type PreTradeCreditDimensions,
  type PreTradeCreditRefuseCode,
} from './pretrade-limits.js';

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
    const tagged = input as PlaceOrderInput & { reduceOnly?: boolean; closePosition?: boolean };
    // Reducing a position is never refused only because a cap is unset.
    if (tagged.reduceOnly !== true && tagged.closePosition !== true) {
      const check = checkPreTradeCreditDimensions(readOwnerPreTradeCredit());
      if (!check.ok) refusePlace(check);
    }
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
  markPreTradeCreditInstalled();
  installPreTradeCreditPlace(TradeService);
  installPreTradeCreditOpen(PositionService);
}

installPreTradeCredit();
