/**
 * System overload on the order door (Binance -1008 shape).
 *
 * An explicit operator switch. Unset is not overloaded — this file does not
 * invent a request-rate ceiling. While the switch is on, new risk is refused
 * and a reduce-only or close-position order is not.
 */
import { TradeError, type TradeErrorCode } from '../spot/types.js';

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

/**
 * Throws `trade.system_overload` for new risk while the switch is on. Called at the start of `placeOrderInner`,
 * which every order kind reaches (a direct place, a TWAP child, a copy mirror, a grid level), so none skips it.
 */
export function assertAdmittedUnderOverload(
  input: { readonly reduceOnly?: boolean; readonly closePosition?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const decision = admitUnderOverload({
    overloaded: orderDoorOverloaded(env),
    reduceOnly: input.reduceOnly,
    closePosition: input.closePosition,
  });
  if (!decision.ok) throw new TradeError(decision.reason, decision.code as TradeErrorCode);
}
