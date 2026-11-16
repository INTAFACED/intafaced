import type { VenueIntent } from '@intafaced/venue-contracts';

/** The intents this adapter builds and signs (`HyperliquidTestnetUserVenue.buildOwn` in `venue.ts`). */
export type BuiltIntentKind = 'place_order' | 'cancel_order' | 'update_leverage' | 'withdraw' | 'approve_builder_fee' | 'approve_agent';

export type BuiltIntent = Extract<VenueIntent, { kind: BuiltIntentKind }>;

/**
 * Every other `VenueIntent` kind, with why this adapter refuses it `not_offered` before anything is signed. A kind the
 * contract adds lands here by type: this record fails to compile until it names it. When the adapter starts building a
 * kind, move it into `BuiltIntentKind` and build it in `venue.ts`.
 */
export const NOT_OFFERED: Readonly<Record<Exclude<VenueIntent['kind'], BuiltIntentKind>, string>> = {
  revoke_agent: 'revoking an agent is not offered by this adapter yet',
  amend_order: 'amend is not offered by this adapter yet: cancel and place a new order',
  replace_order: 'a cancel-and-replace signed once is not offered by this adapter yet: cancel, then place',
  cancel_orders: 'cancelling several orders in one signed action is not offered by this adapter yet',
  // Hyperliquid has one (`scheduleCancel`); this adapter's descriptor declares none until it is wired and cross-checked.
  schedule_cancel: 'a scheduled cancel is not offered by this adapter yet',
  create_sub_account: 'sub-accounts are not offered by this adapter yet',
  sub_account_transfer: 'sub-accounts are not offered by this adapter yet',
  market_margin_transfer: "a HIP-3 deployer's own margin account is not offered by this adapter yet",
  // The venue takes several orders in one `order` action, but this adapter does not build or read one yet, and its
  // descriptor declares no `ordersPerAction`: each order is signed on its own.
  place_orders: 'orders signed together are not offered by this adapter yet: sign each order on its own',
};

export function isBuiltIntent(intent: VenueIntent): intent is BuiltIntent {
  return !Object.hasOwn(NOT_OFFERED, intent.kind);
}
