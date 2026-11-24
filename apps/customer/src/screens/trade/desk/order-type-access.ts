import type { DeskMarket } from './market';
import type { OrderType } from './order-math';

/**
 * Why the ticket does not offer an order type here (J-cex-spot-04 #1): one reason per type, from the same rules the
 * service refuses it by, so a type the ticket offers is one this market, its state and this account's mode take.
 *
 * - opening window (svc-trade `assertOutsideOpeningWindow`, `trade.opening_window`): a new listing takes limit orders
 *   only until its window ends, so market and both stops are refused;
 * - higher-risk zone (`assertZoneOrder`, `trade.higher_risk_zone`): limit orders only, the same three refused;
 * - limit-only mode (`trade.mode_limit_only`): a market order is refused;
 * - a listed lead's Lead trade (`trade.copy_lead_price_required`): a lead trade needs a price, so market and stop-market
 *   are refused while the switch is on.
 *
 * A limit order is never refused by these, so the ticket always has a type to show.
 */
export type TypeReasonKey =
  'Type reason opening window' | 'Type reason zone' | 'Type reason limit only' | 'Type reason lead' | 'Type reason trailing stop';

const LIMIT_ONLY_TYPES: readonly OrderType[] = ['market', 'stop_limit', 'stop_market'];

export function refusedTypes(
  market: Pick<DeskMarket, 'state' | 'openingWindowEndsAt' | 'zone'>,
  account: { readonly lead: boolean | undefined },
  now: number,
): ReadonlyMap<OrderType, TypeReasonKey> {
  const refused = new Map<OrderType, TypeReasonKey>();
  const refuse = (types: readonly OrderType[], reason: TypeReasonKey) => {
    for (const type of types) if (!refused.has(type)) refused.set(type, reason);
  };
  if (market.openingWindowEndsAt != null && now < market.openingWindowEndsAt) refuse(LIMIT_ONLY_TYPES, 'Type reason opening window');
  if (market.zone === 'higher_risk') refuse(LIMIT_ONLY_TYPES, 'Type reason zone');
  if (market.state === 'LIMIT_ONLY') refuse(['market'], 'Type reason limit only');
  if (account.lead === true) refuse(['market', 'stop_market'], 'Type reason lead');
  return refused;
}
