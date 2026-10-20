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
    body: 'Raising leverage releases margin, and that needs a readable order book. Lowering leverage adds margin and still works.',
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
    body: 'Futures positions open and close at the accepted mark price. A price cannot be sent.',
    retryable: false,
  },
  'trade.order_type_unsupported': {
    title: 'That order type is not offered on futures',
    body: 'Futures open and close at the accepted mark. Resting, stop and take-profit orders are not offered on futures.',
    retryable: false,
  },
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

/** Every code this file has its own words for (read by `app/refusal-catalogue.ts`). */
export const FUTURES_REFUSAL_CODES: readonly string[] = Object.keys(WORDS);
