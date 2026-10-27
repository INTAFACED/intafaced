/**
 * Plain words for the typed refusals the futures service sends (services/svc-trade/src/futures, VERIFIED 2026-10-17).
 * Each message names the real reason in money words, never an internal term. The service code stays as small
 * support text under the message. A code this table does not know falls back to the shared refusal words.
 */
import { refusalCopy } from '../../../data/refusals';

export interface FuturesRefusal {
  title: string;
  body: string;
  /** The raw service code, for the small support line. */
  code: string | null;
  /** True when the same request may be sent again. False for "this is never offered" and for rules the trader must change first. */
  retryable: boolean;
}

type Words = { title: string; body: string; retryable?: boolean };

const WORDS: Readonly<Record<string, Words>> = {
  'trade.futures_disabled': {
    title: 'Futures trading is switched off',
    body: 'The futures service is switched off by the platform right now. Open positions stay as they are. Nothing can be opened or changed until it is switched back on.',
  },
  'trade.futures_unconfigured': {
    title: 'Futures profit settlement is not set up',
    body: 'The platform has not named where futures profit is paid from, so positions cannot open.',
    retryable: false,
  },
  'trade.profit_source_unconfigured': {
    title: 'Futures profit settlement is not set up',
    body: 'The platform has not named where futures profit is paid from, so positions cannot open.',
    retryable: false,
  },
  'trade.profit_source_underfunded': {
    title: 'The profit pool cannot cover this close',
    body: 'The pool that pays futures profit is below what this close would pay. Nothing was changed. Try again later.',
  },
  'trade.cross_margin_unsupported': {
    title: 'Cross margin is not offered',
    body: 'Every futures position is isolated: it can lose only the margin you put into it. A shared pool across positions is not offered.',
    retryable: false,
  },
  'trade.portfolio_margin_unset': {
    title: 'Portfolio margin is not offered',
    body: 'Portfolio margin has no published rules, so it is switched off. Futures margin stays isolated.',
    retryable: false,
  },
  'trade.margin_mode_unknown': {
    title: 'That margin mode is not offered',
    body: 'Futures margin is isolated. No other mode can be chosen.',
    retryable: false,
  },
  'trade.unsupported_collateral_class': {
    title: 'Only cash can be posted as margin',
    body: 'Yield-bearing, staked and lending balances are refused as margin. Use cash from your free balance.',
    retryable: false,
  },
  'trade.leverage_required': {
    title: 'Choose a leverage',
    body: 'There is no default leverage. Enter the leverage you want, then review again.',
  },
  'trade.leverage_invalid': { title: 'Check the leverage', body: 'Enter a leverage as a plain number, for example 3 or 2.5.' },
  'trade.leverage_too_high': {
    title: 'That leverage is above the limit',
    body: 'This contract has a leverage cap. Lower the leverage to the cap or less.',
  },
  'trade.leverage_cap_unset': {
    title: 'This contract has no leverage cap set',
    body: 'The platform has not published a leverage cap for this contract, so nothing can be opened on it.',
    retryable: false,
  },
  'trade.leverage_would_liquidate': {
    title: 'That leverage would put the position at the liquidation price',
    body: 'Raising leverage releases margin. At this mark the position would be liquidated, so nothing was changed. Choose a lower leverage or add margin first.',
  },
  'trade.depth_unknown': {
    title: 'The book cannot be read right now',
    body: 'Opening, adding size and raising leverage need a readable order book to rate the margin tier. Nothing was held or changed. Lowering leverage adds margin and still works.',
  },
  'trade.risk_limit_confirm_required': {
    title: 'This order moves into a higher margin tier',
    body: 'The tier changed since your review, or it was not confirmed. Nothing was held. Review again, read the new tier and confirm it.',
    retryable: false,
  },
  'trade.confirm_tier_invalid': {
    title: 'The margin tier confirmation was not readable',
    body: 'Nothing was held. Review again and confirm the tier the review shows.',
    retryable: false,
  },
  'trade.oi_share_limit': {
    title: 'This order is above your share of open interest',
    body: 'One account may hold only part of this contract’s open interest limit, counting your open position and live orders. Nothing was held. Review again to see how much you can still add.',
    retryable: false,
  },
  'trade.oi_limit': {
    title: 'This contract is near its open interest limit',
    body: 'Open interest on this contract is capped, and this order would go past the cap. Nothing was held. Review again to see how much can still be added.',
    retryable: false,
  },
  'trade.oi_limit_unset': {
    title: 'This contract has no open interest limit published',
    body: 'The platform has not published how much open interest this contract may carry, so nothing can be opened on it. Closing still works.',
    retryable: false,
  },
  'trade.oi_room_unavailable': {
    title: 'Your open interest room could not be read',
    body: 'Nothing was held. Try the review again in a moment.',
  },
  'trade.ladder_unset': {
    title: 'Margin tiers are not published',
    body: 'The platform has not published the maintenance tiers for futures. Without them a position could not be closed when it runs out of margin, so nothing can be opened until they are.',
    retryable: false,
  },
  'trade.calculator_invalid': {
    title: 'Check the numbers',
    body: 'Enter the size, entry price and leverage as plain positive numbers. The exit price is optional.',
  },
  'trade.margin_variant_unsupported': {
    title: 'The calculator covers isolated linear contracts',
    body: 'Inverse contracts and other margin modes are not offered, so the calculator does not work them out.',
    retryable: false,
  },
  'trade.liquidation_price_between_tiers': {
    title: 'No single liquidation price',
    body: 'At this size the maintenance rate steps from one tier to the next right where the position would be closed, so no one price can be shown.',
    retryable: false,
  },
  'trade.liquidation_price_no_price_above_zero': {
    title: 'No liquidation price',
    body: 'The margin covers the whole position, so no price above zero would close it.',
    retryable: false,
  },
  'trade.insufficient_margin': {
    title: 'Not enough free balance',
    body: 'The margin and fee for this are more than your free balance. Add funds, lower the size, or lower the leverage.',
  },
  'trade.margin_below_initial': {
    title: 'That would take margin below the minimum',
    body: 'A position must keep at least its initial margin. Remove a smaller amount.',
  },
  'trade.margin_would_liquidate': {
    title: 'That would put the position at the liquidation price',
    body: 'Removing this much margin would leave the position liquidatable at the current mark. Remove less.',
  },
  'trade.margin_adjustment_in_progress': {
    title: 'A margin change is already running',
    body: 'Wait for the first change on this position to finish, then check its margin before you send another.',
  },
  'trade.liquidation_in_progress': {
    title: 'A liquidation step is live on this position',
    body: 'While the platform is closing part of this position, changes to it are refused. Check the position, then try again.',
  },
  'trade.close_in_progress': {
    title: 'Another change is running on this position',
    body: 'A close or margin change on this position has not finished. Wait a moment, then check the position before you try again.',
  },
  'trade.mark_missing': {
    title: 'No usable price right now',
    body: 'The mark price feed is not giving a usable price, so nothing was changed. Try again in a moment.',
  },
  'trade.mark_unusable': {
    title: 'No usable price right now',
    body: 'The mark price is not good enough to settle this at, so nothing was changed. Try again in a moment.',
  },
  'trade.mark_invalid': { title: 'The mark price is not usable', body: 'Nothing was changed. Try again in a moment.' },
  'trade.position_not_found': {
    title: 'That position was not found',
    body: 'It may be closed or may belong to another account. Refresh your positions.',
    retryable: false,
  },
  'trade.position_not_open': {
    title: 'That position is not open',
    body: 'It is already closed or liquidated. Check your position history.',
    retryable: false,
  },
  'trade.protection_wrong_side': {
    title: 'That price is on the wrong side of the mark',
    body: 'A take profit must be past the mark price in your favour, and a stop loss past it against you: above the mark for a long’s take profit, below it for its stop loss, and the other way round for a short. Nothing was saved.',
    retryable: false,
  },
  'trade.entry_protection_reduce_only': {
    title: 'A reduce-only order takes no take profit or stop loss',
    body: 'A take profit or stop loss is attached to an order that opens or adds to a position. Nothing was placed.',
    retryable: false,
  },
  'trade.entry_protection_split_unsupported': {
    title: 'A split order takes no take profit or stop loss',
    body: 'A take profit or stop loss attaches to one order. Clear them to split, then set them on the position once it is open. Nothing was placed.',
    retryable: false,
  },
  'trade.entry_protection_unmounted': {
    title: 'Take profit and stop loss on an order are not available here',
    body: 'This deployment does not attach a take profit or stop loss to an order. Nothing was placed. Clear them to open, then set them on the position.',
  },
  'trade.trigger_source_unset': {
    title: 'The index price is not published here',
    body: 'A stop judged on the index would never fire, so it was not armed. Choose the mark price or the last trade. Nothing was saved.',
    retryable: false,
  },
  'trade.trigger_source_unsupported': {
    title: 'That price source is not offered',
    body: 'A stop is judged on the mark price or the last trade. Nothing was saved.',
    retryable: false,
  },
  'trade.last_price_missing': {
    title: 'This contract has no trades',
    body: 'There is no last trade to judge the stop on. Choose the mark price, or try again once the book has traded. Nothing was saved.',
  },
  'trade.conditional_already_crossed': {
    title: 'That trigger is already reached',
    body: 'The price the stop is judged on is already past the trigger, so it would close at once. Set the trigger beyond the current price: below it for a long, above it for a short. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_would_increase': {
    title: 'A stop only closes',
    body: 'That stop would open or add to a position instead of closing one: a stop on a long sells, on a short it buys. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_reduce_only_required': {
    title: 'A stop only closes',
    body: 'A stop is always reduce-only: it can close a position, never open or enlarge one. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_field_required': {
    title: 'A price is missing for this stop',
    body: 'A stop market needs a trigger price, a stop limit a trigger and a limit price, and a trailing stop a distance. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_field_unsupported': {
    title: 'That stop does not take that price',
    body: 'Each stop takes only its own prices: a trailing stop takes a distance and no trigger, and only a stop limit takes a limit price. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_kind_unsupported': {
    title: 'That stop type is not offered',
    body: 'Choose a stop market, a stop limit or a trailing stop. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_trail_unusable': {
    title: 'That distance is too large',
    body: 'The trailing distance would put the trigger at or below zero. Enter a smaller distance. Nothing was saved.',
    retryable: false,
  },
  'trade.close_quantity_exceeds_size': {
    title: 'That is more than the position holds',
    body: 'Enter a size up to the position’s size. Nothing was saved.',
    retryable: false,
  },
  'trade.close_quantity_lot_step': {
    title: 'That size is not on the contract’s step',
    body: 'Enter a size in whole steps of the contract’s lot. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_trigger_off': {
    title: 'Price triggers are switched off',
    body: 'The platform is not watching prices for take-profit, stop-loss or stop orders right now, so none can be armed. Nothing was saved. Your position is unchanged.',
  },
  'trade.conditional_amount_invalid': {
    title: 'That price is not a number we can use',
    body: 'Enter each trigger as a price above zero. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_market_not_futures': {
    title: 'Only futures positions take these orders',
    body: 'Take profit, stop loss and stop orders here are for futures positions. Nothing was saved.',
    retryable: false,
  },
  'trade.conditional_not_cancellable': {
    title: 'That order already fired or ended',
    body: 'Only an armed take profit, stop loss or stop can be cancelled. This one has fired, filled or ended: see what it did in the Orders tab.',
    retryable: false,
  },
  'trade.conditional_not_found': {
    title: 'That order was not found',
    body: 'It may belong to another account. Refresh the Orders tab.',
    retryable: false,
  },
  'trade.client_request_id_required': { title: 'Request id missing', body: 'Nothing was sent. Start the action again.' },
  'trade.position_under_review': {
    title: 'That position is under review',
    body: 'The platform is checking this position. It cannot be changed until the review ends.',
  },
  'trade.not_futures_market': {
    title: 'That is not a futures contract',
    body: 'Choose a futures contract from the list.',
    retryable: false,
  },
  'trade.market_not_found': { title: 'That contract was not found', body: 'Choose a contract from the list.', retryable: false },
  'trade.market_not_tradable': { title: 'This contract is not open for trading', body: 'You can still see its price and your positions.' },
  'trade.dated_futures_expired': {
    title: 'This contract has expired',
    body: 'Expired contracts cannot be opened. Positions settle at the owner fixing.',
    retryable: false,
  },
  'trade.size_invalid': { title: 'Check the size', body: 'Enter a size that is more than zero and fits the contract step.' },
  'trade.price_not_accepted': {
    title: 'You cannot name a price here',
    body: 'A market order fills at the best prices on the book. Choose a limit order to name a price.',
    retryable: false,
  },
  'trade.order_type_unsupported': {
    title: 'That order type is not offered on futures',
    body: 'The futures book takes market and limit orders. Stop, take-profit and the other types are not offered.',
    retryable: false,
  },
  'trade.limit_price_on_market_order': {
    title: 'A market order has no price',
    body: 'A market order fills at the best prices on the book. Choose a limit order to name a price.',
    retryable: false,
  },
  'trade.invalid_price': { title: 'Check the limit price', body: 'Enter a price that is more than zero and fits the price step.' },
  'trade.time_in_force_unsupported': {
    title: 'That time in force is not offered',
    body: 'A limit order rests until it fills or is cancelled; a market order fills what it can and cancels the rest.',
    retryable: false,
  },
  'trade.futures_price_outside_band': {
    title: 'That price is outside the price band',
    body: 'Orders must sit inside the band around the mark price. Move the price closer to the mark.',
  },
  'trade.futures_price_band_unset': {
    title: 'The price band is not set',
    body: 'The platform has not set the price band for this contract, so orders are refused until it does.',
    retryable: false,
  },
  'trade.futures_margin_insufficient': {
    title: 'Not enough free balance',
    body: 'The margin held for this order is more than your free balance. Add funds, lower the size, or lower the leverage.',
  },
  'trade.futures_matching_unconfigured': {
    title: 'The futures book is not switched on',
    body: 'Orders through the futures book are switched off on this platform, so nothing can be placed.',
    retryable: false,
  },
  'trade.futures_matching_disabled': {
    title: 'The futures book is not switched on',
    body: 'Orders through the futures book are switched off on this platform, so nothing can be placed.',
    retryable: false,
  },
  'trade.futures_orders_unmounted': {
    title: 'The futures book is not switched on',
    body: 'Orders through the futures book are switched off on this platform, so nothing can be placed.',
    retryable: false,
  },
  'trade.futures_order_unfilled': {
    title: 'The book did not fill this order',
    body: 'Nothing filled and nothing rests, so no position was opened or changed. The margin held for it is released.',
  },
  'trade.futures_order_not_found': {
    title: 'That order was not found',
    body: 'It may belong to another account. Refresh your orders.',
    retryable: false,
  },
  'trade.futures_submit_unknown': {
    title: 'The book has not confirmed this order',
    body: 'The order was sent but its answer is not known. It is checked with the book before anything else is done. Refresh in a moment.',
  },
  'trade.futures_hold_released': {
    title: 'This order is no longer live',
    body: 'Its margin hold was already released, so it cannot fill. Refresh your orders.',
    retryable: false,
  },
  'trade.hold_unconfirmed': {
    title: 'The margin hold was not confirmed',
    body: 'The book could not confirm the margin held for this order, so it was not placed. Nothing was taken. Try again in a moment.',
  },
  'trade.reverse_open_not_sent': {
    title: 'The other side was not opened',
    body: 'The close went through, but the opening order was not sent within two minutes, so it was not placed. Open a position from the ticket if you still want one.',
    retryable: false,
  },
  'trade.reverse_close_not_sent': {
    title: 'The close was not sent',
    body: 'The closing order was not sent within two minutes, so nothing was placed and your position is unchanged. Reverse again to try once more.',
    retryable: false,
  },
  'trade.reverse_position_closed_elsewhere': {
    title: 'Closed by another order',
    body: 'Another order, such as a stop, a take profit or a liquidation, closed the position before the reverse did, so nothing was opened.',
    retryable: false,
  },
  'trade.reverse_already_requested': {
    title: 'Already being reversed',
    body: 'An earlier request is still reversing this position. Wait for it to finish, then check your positions.',
    retryable: false,
  },
  'trade.reverse_leverage_unknown': {
    title: 'Leverage not recorded',
    body: 'This position has no recorded leverage, so the other side cannot be opened at the same leverage.',
    retryable: false,
  },
  'trade.futures_reduce_only_no_position': {
    title: 'No open position to reduce',
    body: 'A reduce-only order needs an open position on the other side. Refresh your positions.',
    retryable: false,
  },
  'trade.futures_reduce_only_exceeds_position': {
    title: 'That is more than the position',
    body: 'Together with your other reduce-only orders, this would close more than the position holds. Lower the size.',
  },
  'trade.futures_reduce_past_bankruptcy': {
    title: 'That price would lose more than the margin',
    body: 'A reduce at this price would lose more than the margin on the position. Choose a price closer to the mark.',
  },
  'trade.futures_reduce_bankruptcy_outside_band': {
    title: 'This close cannot be placed now',
    body: 'The price at which this position loses its whole margin lies outside the price band, so a market close is refused. Add margin or wait for the mark to move.',
  },
  'trade.futures_one_way_flip_refused': {
    title: 'Close the other side first',
    body: 'Positions are one-way on this contract. Close or cancel the opposite position or order first.',
    retryable: false,
  },
  'trade.futures_fill_in_progress': {
    title: 'A fill is still being recorded',
    body: 'A fill on this position has not finished recording. Wait a moment, then check the position.',
  },
  'trade.futures_reduce_orders_resting': {
    title: 'A close order is resting on this position',
    body: 'Cancel the resting reduce-only order on this position first, then try again.',
  },
  'trade.futures_open_at_mark_retired': {
    title: 'Positions open through the book',
    body: 'Opening at the mark is retired. Send a market or limit order instead.',
    retryable: false,
  },
  'trade.futures_close_at_mark_retired': {
    title: 'Positions close through the book',
    body: 'Closing at the mark is retired. Close with a reduce-only order instead.',
    retryable: false,
  },
  'trade.client_order_id_conflict': {
    title: 'That request id was used for something else',
    body: 'The same id came with a different order. Nothing was changed. Start the order again.',
  },
  'trade.client_order_id_required': { title: 'Request id missing', body: 'Nothing was sent. Start the action again.' },
  'trade.email_proof_required': {
    title: 'Confirm your email first',
    body: 'A new order needs a confirmed email address. Confirm it from your account, then try again.',
    retryable: false,
  },
  'trade.identity_level_insufficient': {
    title: 'Your identity level is too low',
    body: 'Derivatives need a higher identity level. Finish identity checks from your account.',
    retryable: false,
  },
  'trade.identity_level_unavailable': {
    title: 'Your identity level cannot be read',
    body: 'The platform cannot read your identity level right now, so derivatives stay closed. Try again later.',
  },
  'trade.identity_level_unset': {
    title: 'Derivatives are closed',
    body: 'The identity level derivatives need is not published, so positions cannot be opened.',
    retryable: false,
  },
  'trade.gated_list_unknown': {
    title: 'A check could not be read',
    body: 'One of the checks for this contract could not be read, so it is shown as blocked. Try again in a moment.',
  },
  'trade.gated_list_unmounted': {
    title: 'Your access cannot be listed here',
    body: 'The per-account list of contracts is not wired on this platform. Opening still runs every check.',
    retryable: false,
  },
  'trade.market_not_orderable': {
    title: 'This contract does not take orders now',
    body: 'You can still see its price and your positions.',
  },
  'trade.market_halted': {
    title: 'This contract is halted',
    body: 'The platform halted trading on this contract. Positions stay as they are.',
  },
  'trade.market_paused': { title: 'This contract is paused', body: 'Trading on this contract is paused. Positions stay as they are.' },
  'trade.position_mode_unset': {
    title: 'Position mode is not set',
    body: 'The platform has not set how positions on one contract combine (one-way or hedge), so new positions are refused until it does. Nothing was changed.',
    retryable: false,
  },
  'trade.position_side_unsupported': {
    title: 'That side is not offered',
    body: 'Positions are one-way on this contract. Close the open position first.',
    retryable: false,
  },
  'trade.idempotency_conflict': {
    title: 'That request id was used for something else',
    body: 'The same id came with different numbers. Nothing was changed. Start the action again.',
  },
  'trade.client_open_id_required': { title: 'Request id missing', body: 'Nothing was sent. Start the action again.' },
  'trade.idempotency_key_required': { title: 'Request id missing', body: 'Nothing was sent. Start the action again.' },
  'trade.cancel_not_close': {
    title: 'That does not close the position',
    body: 'Deleting a position does not close it or release its margin. Use close. Nothing was changed.',
    retryable: false,
  },
  'trade.system_overload': {
    title: 'New orders are paused',
    body: 'The order door is overloaded, so a new position is refused. An order that only reduces a position can still be sent. Nothing new was opened.',
  },
  'trade.position_id_required': { title: 'Position missing', body: 'Nothing was sent. Pick the position and try again.' },
  'trade.funding_rate_unavailable': {
    title: 'No funding rate is published',
    body: 'The platform has not published a funding rate for this contract, so no funding figure is shown. Nothing is estimated.',
    retryable: false,
  },
  'trade.margin_call_not_found': {
    title: 'No delivered margin call',
    body: 'No margin call has been delivered for this position.',
    retryable: false,
  },
  'trade.futures_ticker_market_unknown': {
    title: 'That contract is not listed',
    body: 'Choose a contract from the list.',
    retryable: false,
  },
  'trade.position_preview_mark_unavailable': {
    title: 'No mark price to review against',
    body: 'The review needs a current mark. None is available, so no figure is shown.',
  },
  'trade.position_preview_liquidation_unavailable': {
    title: 'No liquidation price',
    body: 'The platform has not set how liquidation is priced for this contract, so the review shows none and opening is not allowed.',
    retryable: false,
  },
  'trade.position_preview_margin_unavailable': {
    title: 'Margin cannot be priced',
    body: 'The review cannot work out the margin, so opening is not allowed.',
  },
  'trade.position_preview_fee_unavailable': {
    title: 'Fee cannot be priced',
    body: 'The review cannot work out the fee, so opening is not allowed.',
  },
  'trade.position_preview_invalid': {
    title: 'Check the review inputs',
    body: 'The size or leverage was not accepted. Change them and review again.',
  },
  'trade.max_order_unset': {
    title: 'Order limits are not set',
    body: 'The platform has not set the largest order size, so new positions are refused until it does.',
    retryable: false,
  },
  'trade.max_position_unset': {
    title: 'Position limits are not set',
    body: 'The platform has not set the largest position size, so new positions are refused until it does.',
    retryable: false,
  },
  'trade.max_loss_unset': {
    title: 'Loss limits are not set',
    body: 'The platform has not set the loss limit, so new positions are refused until it does.',
    retryable: false,
  },
  'trade.permission_denied': {
    title: 'This account cannot trade futures',
    body: 'The account does not have trading permission. Contact support.',
    retryable: false,
  },
};

function readable(status: number | undefined, reason: string | undefined): Words | null {
  if (status === 401 || reason === 'unauthorized') return { title: 'Sign in again', body: 'Your session ended. Sign in to carry on.' };
  if (status === 501 || reason === 'not_supported')
    return { title: 'This is not offered', body: 'The service does not offer this action.', retryable: false };
  if (reason === 'unreachable' || (status !== undefined && status >= 502))
    return { title: 'The trading service did not answer', body: 'Nothing was changed. Try again in a moment.' };
  return null;
}

/** Words for a failed `api.rest` result. */
export function futuresRefusal(failure: { code?: string; message?: string; status?: number; reason?: string }): FuturesRefusal {
  const code = failure.code ?? null;
  const known = code ? WORDS[code] : undefined;
  if (known) return { title: known.title, body: known.body, code, retryable: known.retryable ?? true };
  const generic = readable(failure.status, failure.reason);
  if (generic) return { title: generic.title, body: generic.body, code, retryable: generic.retryable ?? true };
  const shared = refusalCopy(code ?? 'unknown');
  return { title: shared.title, body: shared.body, code, retryable: true };
}

/** Codes that mean "the whole futures plane is not accepting this", so the room shows one plane-level block. */
export function isPlaneOff(code: string | null | undefined): boolean {
  return code === 'trade.futures_disabled';
}

/** Codes that mean the outcome is a saved intent still settling (not a failure). */
export function isSettling(code: string | null | undefined): boolean {
  return code === 'trade.mark_missing' || code === 'trade.mark_unusable' || code === 'trade.close_in_progress';
}
