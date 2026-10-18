/**
 * System overload on the order door (Binance -1008 shape).
 *
 * An explicit operator switch. Unset is not overloaded — this file does not
 * invent a request-rate ceiling. While the switch is on, new risk is refused
 * and a reduce-only or close-position order is not.
 */
import type { Principal } from '@intafaced/auth';
import { TradeError, type TradeErrorCode } from '../spot/types.js';
import { TradeService, type PlaceOrderInput } from '../spot/trade-service.js';

export const SYSTEM_OVERLOAD = 'trade.system_overload' as const;

export function orderDoorOverloaded(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRADE_ORDER_OVERLOAD === 'true';
}

export function admitUnderOverload(input: {
  readonly overloaded: boolean;
  readonly reduceOnly?: boolean;
  readonly closePosition?: boolean;
}): { readonly ok: true } | { readonly ok: false; readonly code: typeof SYSTEM_OVERLOAD; readonly reason: string } {
  if (!input.overloaded) return { ok: true };
  if (input.reduceOnly === true || input.closePosition === true) return { ok: true };
  return {
    ok: false,
    code: SYSTEM_OVERLOAD,
    reason: 'the order door is overloaded — new risk is refused; a reduce-only or close-position order is still accepted',
  };
}

type PlaceWithReduce = PlaceOrderInput & { readonly reduceOnly?: boolean; readonly closePosition?: boolean };

const PLACE_FLAG = Symbol.for('intafaced.trade.overloadPlace');

export function installOverloadPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<unknown>;
    [PLACE_FLAG]?: true;
  };
  if (proto[PLACE_FLAG]) return;
  proto[PLACE_FLAG] = true;
  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const tagged = input as PlaceWithReduce;
    const decision = admitUnderOverload({
      overloaded: orderDoorOverloaded(),
      reduceOnly: tagged.reduceOnly,
      closePosition: tagged.closePosition,
    });
    if (!decision.ok) throw new TradeError(decision.reason, decision.code as TradeErrorCode);
    return origPlace.call(this, principal, input);
  };
}

export function installOverload(): void {
  installOverloadPlace(TradeService);
}
