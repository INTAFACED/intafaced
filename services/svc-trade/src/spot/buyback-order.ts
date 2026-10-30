/**
 * The token buyback's own IOC buy on the spot book (J-dex-protocol-17).
 *
 * svc-token sweeps the fee share it spends into `rewardsEngine(<quote>)`, then asks this service for one IOC limit buy
 * through the service-authenticated door (`buyback-door.ts`). The order is a `trade.orders` row under a synthetic house
 * user, so the fill and release paths find it like any other order, but its money is the rewards engine's, never a
 * user's: the hold is `buybackOrderHold`, each fill `buybackTakerFill`, the remainder `buybackOrderHoldRelease`.
 *
 * Everything that reads an order's hold account goes through `holdAccountOf` here, and `finalize` posts a buyback
 * row's release with `buybackReleasePost`, so a buyback row can never be read or released as a customer's order.
 */
import {
  buybackOrderHoldAccount,
  orderHoldAccount,
  recipes,
  type AccountRef,
  type Amount,
  type PostRequest,
} from '@intafaced/ledger-client';
import { stampAuthAttribution, requireAuthAttribution, type AuthAttribution } from './auth-attribution.js';
import { HOUSE_BUYBACK_USER_UUID } from './ids.js';

export { HOUSE_BUYBACK_USER_UUID };

/** Matching STP account for the buyback's orders. Distinct from `house:market-maker` and from every user id. */
export const BUYBACK_MATCHING_ACCOUNT_ID = 'house:buyback';

/** Attribution stamped on the buyback's rows and posts: no session, a fixed house key id. */
export const HOUSE_BUYBACK_API_KEY_ID = 'house-buyback' as const;

/** The only service that may place a buyback buy. */
export const BUYBACK_CALLER = 'svc-token' as const;

export const BUYBACK_HOUSE_MAKER = 'trade.buyback_house_maker' as const;
export const BUYBACK_INVALID = 'trade.buyback_invalid' as const;
export const BUYBACK_IN_FLIGHT = 'trade.buyback_in_flight' as const;
export const BUYBACK_CONFLICT = 'trade.buyback_conflict' as const;
export const BUYBACK_BOOK_UNREADABLE = 'trade.buyback_book_unreadable' as const;

export function isBuybackUser(userId: string | null | undefined): boolean {
  return userId === HOUSE_BUYBACK_USER_UUID;
}

export function buybackAttribution(): AuthAttribution {
  return requireAuthAttribution(stampAuthAttribution({ sessionId: null, apiKeyId: HOUSE_BUYBACK_API_KEY_ID }));
}

/** The ledger account holding what is left of an order's reservation. */
export function holdAccountOf(order: { readonly id: string; readonly userId: string; readonly holdAsset: string }): AccountRef {
  return isBuybackUser(order.userId)
    ? buybackOrderHoldAccount(order.holdAsset, order.id)
    : orderHoldAccount(order.userId, order.holdAsset, order.id);
}

/** The one terminal release (sequence 0) of a buyback order. A customer order's stays `recipes.orderHoldRelease`. */
export function buybackReleasePost(order: { readonly id: string; readonly holdAsset: string }, amount: Amount): PostRequest {
  return recipes.buybackOrderHoldRelease({ orderId: order.id, quoteAsset: order.holdAsset, amount, sequence: 0 });
}
