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

export function withPreTradeCreditPlace(Base: typeof TradeService): typeof TradeService {
  return class PreTradeCreditPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const tagged = input as PlaceOrderInput & { reduceOnly?: boolean; closePosition?: boolean };
      // Reducing a position is never refused only because a cap is unset.
      if (tagged.reduceOnly !== true && tagged.closePosition !== true) {
        const check = checkPreTradeCreditDimensions(readOwnerPreTradeCredit());
        if (!check.ok) refusePlace(check);
      }
      return super.placeOrder(principal, input);
    }
  };
}

export function withPreTradeCreditOpen(Base: typeof PositionService): typeof PositionService {
  return class PreTradeCreditOpen extends Base {
    override async open(input: OpenPositionInput, principal?: Principal): ReturnType<PositionService['open']> {
      const check = checkPreTradeCreditDimensions(readOwnerPreTradeCredit());
      if (!check.ok) refuseOpen(check);
      return super.open(input, principal);
    }
  };
}

export function installPreTradeCredit(): void {
  markPreTradeCreditInstalled();
}

installPreTradeCredit();
