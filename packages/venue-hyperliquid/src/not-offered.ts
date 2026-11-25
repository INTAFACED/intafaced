import type { VenueIntent } from '@intafaced/venue-contracts';

/** The intents this adapter builds and signs (`HyperliquidTestnetUserVenue.buildOwn` in `venue.ts`). */
export type BuiltIntentKind =
  'place_order' | 'cancel_order' | 'update_leverage' | 'withdraw' | 'approve_builder_fee' | 'approve_agent' | 'revoke_agent';

export type BuiltIntent = Extract<VenueIntent, { kind: BuiltIntentKind }>;

/**
 * Every other `VenueIntent` kind, with why this adapter refuses it `not_offered` before anything is signed. A kind the
 * contract adds lands here by type: this record fails to compile until it names it. When the adapter starts building a
 * kind, move it into `BuiltIntentKind` and build it in `venue.ts`.
 */
export const NOT_OFFERED: Readonly<Record<Exclude<VenueIntent['kind'], BuiltIntentKind>, string>> = {
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
  // Hyperliquid has one (`updateIsolatedMargin`); this adapter does not build it or read its limit yet.
  update_isolated_margin: "changing an isolated position's margin is not offered by this adapter yet",
  place_orders: 'orders signed together are not offered by this adapter yet: sign each order on its own',
  // Hyperliquid has both (`usdClassTransfer`, and the account abstraction setting); this adapter builds neither yet.
  spot_perps_transfer: 'a move between spot and perps is not offered by this adapter yet',
  set_account_mode: 'changing the account mode is not offered by this adapter yet',
  // The venue holds one net position per contract and moves no open position between accounts: there is nothing to build.
  set_position_mode: 'a position mode switch is not offered: the venue holds one net position per contract',
  move_position: 'moving an open position between accounts is not offered by the venue',
  // Hyperliquid has one (`vaultTransfer`), and lists its vaults; this adapter builds neither the move nor the reads yet.
  vault_transfer: 'a move into or out of a vault is not offered by this adapter yet',
  // Hyperliquid has these (`cDeposit`, `cWithdraw`, `tokenDelegate`) and lists its validators; this adapter builds none yet.
  staking_transfer: 'a move into or out of staking is not offered by this adapter yet',
  staking_delegate: 'delegating to a validator is not offered by this adapter yet',
};

export function isBuiltIntent(intent: VenueIntent): intent is BuiltIntent {
  return !Object.hasOwn(NOT_OFFERED, intent.kind);
}
