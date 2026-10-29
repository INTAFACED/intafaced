// Customer words for every refusal the Copy and Bots rooms can meet. A screen shows these, never the service's own
// sentence (those carry internal desk-law wording). Codes not listed here fall to the shared table in data/refusals.ts.
// The raw code is only offered as a small "Ref" line for support.
import type { ApiResult } from '../../../shared/api';
import { refusalCopy } from '../../../data';
import type { RefusalCopy } from '../../../data';

type Words = { title: string; body: string };

const COPY: Readonly<Record<string, Words>> = {
  'trade.copy_jurisdiction_blank': {
    title: 'Copy trading isn’t open for your country',
    body: 'The list of countries where it can be offered hasn’t been approved. Nothing was followed and no money moved.',
  },
  'trade.copy_jurisdiction_blocked': {
    title: 'Copy trading isn’t offered in your country',
    body: 'Nothing was followed and no money moved.',
  },
  'trade.copy_fee_share_blank': {
    title: 'Leader fees aren’t approved',
    body: 'Copy trading stays closed until the share a leader earns from the trading fee is approved. Nothing was followed.',
  },
  'trade.copy_law_blank': {
    title: 'Copy trading isn’t open',
    body: 'Its fee share and country list haven’t been approved. Nothing was followed.',
  },
  'trade.copy_unavailable': {
    title: 'Copy trading isn’t available right now',
    body: 'The copy service isn’t switched on here. Nothing was followed and no money moved.',
  },
  'trade.copy_self_follow': { title: 'You can’t follow yourself', body: 'Choose a different leader.' },
  'trade.copy_already_following': { title: 'You already follow this leader', body: 'Open it in My follows to change it.' },
  'trade.copy_not_following': { title: 'You don’t follow that leader', body: 'Check My follows and try again.' },
  'trade.copy_envelope_invalid': { title: 'Check your limits', body: 'One of the limits can’t be used. Check each amount and the expiry.' },
  'trade.copy_limit_missing': { title: 'Set every limit', body: 'A cap per order and a total cap are both required.' },
  'trade.copy_cap_exceeded': { title: 'That is over your limit', body: 'The copy would go past a limit you set, so it was not placed.' },
  'trade.copy_market_not_permitted': { title: 'That market isn’t in your permission', body: 'Add the market to your limits first.' },
  'trade.copy_key_expired': { title: 'Your permission has expired', body: 'Follow again to start new copies.' },
  'trade.copy_fee_share_killed': { title: 'Leader fee share is switched off', body: 'You pay the normal trading fee only.' },
  'trade.copy_pnl_fee_forbidden': {
    title: 'Profit-based fees aren’t allowed',
    body: 'Leaders are paid from the trading fee, never from your profit.',
  },
  'trade.copy_ranking_forbidden': {
    title: 'Rankings aren’t offered',
    body: 'Leaders aren’t ranked by how much they earned, so there are no top lists or trending boards. Every listed leader is shown in the order they were listed.',
  },
  'trade.copy_settle_refused': { title: 'Fee share was not settled', body: 'Nothing was charged beyond the normal trading fee.' },
  'trade.copy_leader_fill_not_found': { title: 'That leader trade wasn’t found', body: 'It may be too old, or it isn’t one you can copy.' },
  'trade.copy_auto_mirror_place_socket': {
    title: 'Automatic copying is switched off',
    body: 'Copied orders aren’t placed for you. Your limits and permission are kept.',
  },
  'trade.copy_place_disabled': {
    title: 'Automatic copying is switched off',
    body: 'Copied orders aren’t placed for you. Your limits and permission are kept.',
  },
  'trade.copy_paper_live_forbidden': {
    title: 'Paper and live can’t be mixed',
    body: 'A paper leader can’t be copied with live money, or the other way round.',
  },
  'trade.copy_session_key_missing': { title: 'The copy permission isn’t granted', body: 'Grant it before copies can be placed.' },
  'trade.copy_session_key_revoked': { title: 'The copy permission was withdrawn', body: 'Follow again to start new copies.' },
  'trade.copy_paused': { title: 'This follow is paused', body: 'Resume it to copy new trades. Open positions stay as they are.' },
  'trade.copy_stopped': { title: 'This follow has stopped', body: 'Follow again to copy new trades. Open positions stay as they are.' },
  'trade.copy_detached': { title: 'You have left this leader', body: 'Your positions are yours to manage.' },
  'trade.copy_leader_resume_forbidden': { title: 'Only you can resume this', body: 'A leader can’t restart your copying.' },
  'trade.copy_state_invalid': { title: 'That isn’t possible in this state', body: 'Refresh the list and check the follow’s state.' },
  'trade.copy_flatten_refused': {
    title: 'Closing copied positions isn’t available',
    body: 'Nothing was closed and you are still following. Close positions yourself on the spot desk.',
  },
  'trade.copy_flatten_drift': {
    title: 'Your positions changed while closing',
    body: 'Nothing was closed. Refresh the follow and check your positions.',
  },
  'trade.copy_flatten_partial': {
    title: 'Only some positions were closed',
    body: 'Part of your copied positions was closed and the rest is still open. Refresh the follow, then close what remains yourself on the spot desk.',
  },
  'trade.copy_flatten_unavailable': {
    title: 'Closing copied positions isn’t available',
    body: 'Nothing was closed and you are still following. Close positions yourself on the spot desk.',
  },
  'trade.copy_leaders_limit_unset': {
    title: 'Say how many leaders to show',
    body: 'A page size is required. Nothing was listed.',
  },
  'trade.copy_follow_events_limit_unset': {
    title: 'Say how many updates to show',
    body: 'A page size is required.',
  },
  'trade.copy_leaders_cursor_invalid': {
    title: 'That page isn’t valid',
    body: 'Start again from the first page. Nothing was changed.',
  },
  'trade.copy_leader_suspended': {
    title: 'This leader is suspended',
    body: 'New copies are stopped. Your existing positions and permission stay as they are. You can stop, leave, or close positions yourself.',
  },
  'trade.copy_leader_delisted': {
    title: 'This leader is delisted',
    body: 'New copies are stopped. Your existing positions and permission stay as they are. You can stop, leave, or close positions yourself.',
  },
  'trade.copy_leader_capacity_full': {
    title: 'This leader is full',
    body: 'No new follower was added.',
  },
  'trade.copy_leader_not_found': {
    title: 'That leader was not found',
    body: 'The reference is unknown or not listed. Nothing was followed.',
  },
  'trade.copy_leader_identity_unset': {
    title: 'Choose one leader',
    body: 'Send either a leader id or a leader reference, not both and not neither.',
  },
  'trade.copy_leader_evidence_unset': {
    title: 'Evidence is required',
    body: 'A verified live listing needs an evidence reference. Nothing was published.',
  },
  'trade.copy_leader_request_unset': {
    title: 'The request id is missing',
    body: 'Nothing was changed.',
  },
  'trade.copy_leader_request_mismatch': {
    title: 'That request id was already used',
    body: 'Send a new request id. The first result was kept.',
  },
  'trade.copy_leader_record_blank': {
    title: 'A listing field is blank',
    body: 'Nothing was published. Fill the field or leave it out.',
  },
  'trade.copy_leader_state_invalid': {
    title: 'That leader state isn’t valid',
    body: 'Nothing was changed.',
  },
  'trade.copy_leader_state_reason_unset': {
    title: 'A reason is required',
    body: 'Nothing was changed.',
  },
  'trade.copy_leader_mode_invalid': {
    title: 'That market type isn’t one we list',
    body: 'Choose Futures, Spot, Bots or Signal.',
  },
  'trade.copy_leader_search_invalid': {
    title: 'That search is too long',
    body: 'Search with 80 characters or fewer.',
  },
  'trade.copy_leader_trades_limit_unset': {
    title: 'This lead’s trades can’t be shown',
    body: 'The page size wasn’t sent. Refresh the page.',
  },
  'trade.copy_leader_trades_cursor_invalid': {
    title: 'That page of trades has changed',
    body: 'Go back to the first page.',
  },
  'trade.copy_fixed_size_above_cap': {
    title: 'The fixed amount is above your limit',
    body: 'Each copied order can use at most your most per order. Lower the fixed amount or raise that limit. Nothing was followed.',
  },
  'trade.copy_tier_unset': {
    title: 'Copy trading is closed',
    body: 'The platform hasn’t set the verification level copying needs, so no one can start a copy. Nothing was followed.',
  },
  'trade.tier_insufficient': {
    title: 'More verification needed',
    body: 'Copying needs a higher verification level than your account has. Finish verification, then start again. Nothing was followed.',
  },
  'trade.copy_subaccount_refused': {
    title: 'Sub-accounts can’t copy',
    body: 'Start copying from your main account. Nothing was followed.',
  },
  'trade.copy_reserve_exceeds_balance': {
    title: 'Not enough free balance',
    body: 'The most in total is more than you have free after your other copies. Lower it, or add funds. Nothing was followed or held.',
  },
  'trade.copy_market_quote_mixed': {
    title: 'Markets settle in different assets',
    body: 'Choose markets that settle in the same asset, so one amount can be set aside. Nothing was followed.',
  },
  'trade.copy_trail_window_unset': {
    title: 'Choose a start and end',
    body: 'The copy history needs both dates. Nothing was exported.',
  },
  'trade.copy_trail_window_too_wide': {
    title: 'That date range is too long',
    body: 'Ask for 92 days or less at a time. This limit protects the database.',
  },
  'trade.copy_trail_limit_unset': {
    title: 'Choose how many rows',
    body: 'The copy history needs a page size. Nothing was listed.',
  },
  'trade.copy_trail_cursor_invalid': {
    title: 'That page link is not valid',
    body: 'Start the list again from the first page.',
  },
  'trade.copy_divergence_basis_unset': {
    title: 'The price difference has no basis points',
    body: 'The leader price was zero, so the difference in basis points is not shown.',
  },
  'trade.copy_slippage_exceeded': {
    title: 'That copy is too far from the leader’s price',
    body: 'The price difference is above the slippage limit you set, so the order was not placed.',
  },
  'trade.copy_concurrency_exceeded': {
    title: 'Too many copied orders are still open',
    body: 'This follow already has as many open copied orders as you allowed. Nothing new was placed.',
  },
  'trade.copy_drawdown_stop': {
    title: 'The drawdown limit stopped new copies',
    body: 'The drop from this follow’s peak result is at the limit you set. New copies were not placed. Existing positions were not closed.',
  },
  'trade.copy_limit_unevaluable': {
    title: 'That limit can’t be checked',
    body: 'A figure this limit needs is missing, so the copy was not placed. Nothing was invented in its place.',
  },
  'trade.copy_leverage_unsupported': {
    title: 'Leverage isn’t available for copy',
    body: 'Copy places spot orders only. The follow was not created.',
  },
  'trade.mark_unavailable': {
    title: 'No fresh reference price',
    body: 'Open profit is hidden until a current price is available. Closed profit is unchanged.',
  },
  fee_lookup_unwired: {
    title: 'Trading fees aren’t available',
    body: 'The fee lookup is not connected, so the fee line is empty. Nothing was charged.',
  },
};

const DEVICE: Readonly<Record<string, Words>> = {
  'device.storage_unavailable': {
    title: 'This browser can’t keep your request safe',
    body: 'Turn on site storage and use a browser that supports tabs working together, then try again. Nothing was sent.',
  },
};

const BOTS: Readonly<Record<string, Words>> = {
  'trade.algo_disabled': { title: 'Bots are switched off', body: 'New schedules can’t be created right now. Nothing was started.' },
  'trade.algo_volume_immature': {
    title: 'Not enough trading history for this bot',
    body: 'Volume-based bots need a longer record of this market’s volume. Use a time-based (TWAP) schedule instead.',
  },
  'trade.algo_unsupported_kind': { title: 'That bot type isn’t available', body: 'Choose another type.' },
  'trade.algo_insufficient_balance': {
    title: 'Not enough funds for the first slice',
    body: 'The first slice needs more than your available balance. Lower the amount or add funds, then try again. Nothing was started and nothing was held.',
  },
  'trade.algo_balance_unreadable': {
    title: 'We couldn’t check your balance',
    body: 'The balance read failed, so the schedule was not started. Nothing was held.',
  },
  'trade.algo_mark_policy_unset': {
    title: 'The price check isn’t configured',
    body: 'The mark age limit isn’t set, so a schedule can’t start. Nothing was held.',
  },
  'trade.fee_schedule_blank': {
    title: 'Trading fees aren’t set',
    body: 'A schedule can’t start until the fee schedule is published. Nothing was held.',
  },
  'trade.algo_invalid_qty': { title: 'Check the amount', body: 'The amount is too small for this market’s lot size, or not valid.' },
  'trade.algo_invalid_schedule': { title: 'Check the schedule', body: 'The gap between slices can’t be longer than the whole run.' },
  'trade.algo_market_closed': { title: 'This market isn’t open', body: 'A schedule can’t start on a closed market.' },
  'trade.algo_no_liquidity': {
    title: 'No one is trading this market right now',
    body: 'A slice can’t be placed without orders on the other side.',
  },
  'trade.algo_no_volume': { title: 'No trading volume to follow', body: 'Volume-based bots need recent trades in this market.' },
  'trade.algo_price_band': { title: 'Your limit price is outside the allowed range', body: 'Choose a price closer to the market price.' },
  'trade.algo_mark_missing': {
    title: 'No reference price right now',
    body: 'Slices pause until a price is available. Nothing was placed.',
  },
  'trade.algo_mark_invalid': { title: 'The reference price can’t be used', body: 'Slices pause until it is available again.' },
  'trade.algo_mark_unusable': { title: 'The reference price can’t be used', body: 'Slices pause until it is available again.' },
  'trade.algo_duplicate_id': { title: 'That schedule already exists', body: 'We kept the first one. Check My bots.' },
  'trade.algo_not_found': { title: 'We couldn’t find that schedule', body: 'Check the ID, or look in My bots.' },
  'trade.algo_bad_state': { title: 'That isn’t possible in this state', body: 'Refresh the schedule and check its status.' },
  'trade.algo_cancel_incomplete': {
    title: 'Some slices could not be cancelled',
    body: 'The schedule is halted. Check Open orders on the spot desk and cancel any that remain.',
  },
  'trade.algo_child_cancel_failed': { title: 'A placed slice could not be cancelled', body: 'Check Open orders on the spot desk.' },
  'trade.algo_child_refused': { title: 'A slice was refused', body: 'The schedule is halted so you can check it.' },
  'trade.algo_resume_extends_too_far': {
    title: 'It can’t run that much longer',
    body: 'The schedule would extend past the allowed time. Stop it and set up a new one.',
  },
  'trade.algo_principal_unavailable': { title: 'The schedule can’t act for you right now', body: 'Nothing was changed. Try again later.' },
};

/** Spot grid bot (svc-trade grid). A field the person left out or set out of range is named in the title. */
const GRID: Readonly<Record<string, Words>> = {
  'trade.bots_verification_insufficient': {
    title: 'Verification insufficient',
    body: 'Bots need a higher verification level than your account has. Finish verification, then set up a bot. Nothing was created.',
  },
  'trade.bots_verification_level_not_set': {
    title: 'Bots are closed: no verification level is set',
    body: 'The platform hasn’t set the verification level bots need, so no one can start a bot. Nothing was created.',
  },
  'trade.grid_request_key_invalid': { title: 'This request can’t be sent', body: 'Refresh the page and try again. Nothing was created.' },
  'trade.grid_request_conflict': {
    title: 'That request already made a different bot',
    body: 'We kept the first bot. Check My bots. Nothing new was created.',
  },
  'trade.grid_market_not_found': { title: 'That market isn’t listed', body: 'Choose a market from the list. Nothing was created.' },
  'trade.grid_market_not_spot': {
    title: 'That market isn’t open for spot trading',
    body: 'Choose an open spot market. Nothing was created.',
  },
  'trade.grid_lower_price_required': {
    title: 'Enter a Lower price',
    body: 'Lower price is required and must be above zero. Nothing was created.',
  },
  'trade.grid_upper_price_required': {
    title: 'Enter an Upper price',
    body: 'Upper price is required and must be above zero. Nothing was created.',
  },
  'trade.grid_investment_required': {
    title: 'Enter an Investment',
    body: 'Investment is required and must be above zero. Nothing was created.',
  },
  'trade.grid_count_required': { title: 'Enter Grids', body: 'Say how many grid levels to place. Nothing was created.' },
  'trade.grid_bounds_inverted': {
    title: 'Lower price must be below Upper price',
    body: 'Swap or change the bounds. Nothing was created.',
  },
  'trade.grid_count_range_not_set': {
    title: 'The allowed grid count isn’t set',
    body: 'The platform hasn’t set how many grid levels a bot may use, so no grid bot can start. Nothing was created.',
  },
  'trade.grid_count_out_of_range': {
    title: 'Grids is out of range',
    body: 'Choose a grid count inside the allowed range shown under the field. Nothing was created.',
  },
  'trade.grid_spacing_below_tick': {
    title: 'The levels are too close together',
    body: 'At this range the levels would be closer than the market’s price step. Widen the range or use fewer grids. Nothing was created.',
  },
  'trade.grid_level_below_minimum': {
    title: 'Each level would be too small',
    body: 'The investment split across the grids is below the market’s smallest order. Invest more or use fewer grids. Nothing was created.',
  },
  'trade.grid_mark_unavailable': {
    title: 'No market price right now',
    body: 'A grid is placed around the current bid and ask, and this market has none. Nothing was created.',
  },
  'trade.grid_reserve_exceeds_balance': {
    title: 'Not enough free balance',
    body: 'The investment is more than you have free after your other bots and copies. Lower it or add funds. Nothing was held.',
  },
  'trade.grid_initialization_failed': {
    title: 'The grid could not start',
    body: 'Its levels could not all be placed, so every placed order was cancelled and the reserve was released.',
  },
  'trade.grid_tick_failed': {
    title: 'The grid could not check its orders',
    body: 'It tries again on its next check. Your reserve and orders stay as they are.',
  },
  'trade.grid_not_found': { title: 'We couldn’t find that grid bot', body: 'Check My bots.' },
  'trade.grid_not_running': { title: 'This grid bot has already stopped', body: 'Refresh to see its final state.' },
  'trade.grid_unavailable': {
    title: 'Grid bots aren’t available right now',
    body: 'The grid service isn’t switched on here. Nothing was created.',
  },
};

export function roomRefusal(failure: Extract<ApiResult<unknown>, { ok: false }>): RefusalCopy & { code: string | null } {
  const code = failure.code ?? null;
  const words = code ? (COPY[code] ?? BOTS[code] ?? GRID[code] ?? DEVICE[code]) : undefined;
  if (words) return { ...words, code };
  if (failure.reason === 'unreachable') {
    return { title: 'Can’t reach the service', body: 'Nothing was changed. Check your connection and try again.', code };
  }
  if (failure.reason === 'uncertain') {
    return { title: 'We can’t tell if that went through', body: 'Check the list before trying again. Your request is remembered.', code };
  }
  if (failure.reason === 'not_mounted') {
    return {
      title: 'This service isn’t available right now',
      body: 'Nothing was changed. It is not switched on in this environment.',
      code,
    };
  }
  if (failure.reason === 'unauthorized') return { ...refusalCopy('auth.unauthorized'), code };
  return { ...refusalCopy(code ?? 'unknown'), code };
}

export const KNOWN_ROOM_CODES: readonly string[] = [...Object.keys(COPY), ...Object.keys(BOTS), ...Object.keys(GRID)];
