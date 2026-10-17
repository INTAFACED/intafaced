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
  'trade.copy_ranking_forbidden': { title: 'Ranking by profit isn’t allowed', body: 'Leaders aren’t ranked by how much they earned.' },
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
    title: 'Not enough funds for this schedule',
    body: 'Lower the amount or add funds, then try again.',
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

export function roomRefusal(failure: Extract<ApiResult<unknown>, { ok: false }>): RefusalCopy & { code: string | null } {
  const code = failure.code ?? null;
  const words = code ? (COPY[code] ?? BOTS[code] ?? DEVICE[code]) : undefined;
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

export const KNOWN_ROOM_CODES: readonly string[] = [...Object.keys(COPY), ...Object.keys(BOTS)];
