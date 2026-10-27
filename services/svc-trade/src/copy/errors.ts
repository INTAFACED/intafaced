/**
 * Copy trading errors (trade.copy / D-S-03 / SPEC-SOVEREIGN-ROUTING-AND-COPY).
 *
 * Codes are stable for wire mapping — never invent leader_share_bps or
 * jurisdiction lists to avoid a refuse.
 */

import { logCopyResidual } from './residual-log.js';

export type CopyErrorCode =
  | 'trade.copy_fee_share_blank'
  | 'trade.copy_jurisdiction_blank'
  | 'trade.copy_law_blank'
  | 'trade.copy_jurisdiction_blocked'
  | 'trade.copy_self_follow'
  | 'trade.copy_already_following'
  | 'trade.copy_not_following'
  | 'trade.copy_envelope_invalid'
  | 'trade.copy_limit_missing'
  | 'trade.copy_slippage_exceeded'
  | 'trade.copy_concurrency_exceeded'
  | 'trade.copy_drawdown_stop'
  | 'trade.copy_limit_unevaluable'
  | 'trade.copy_leverage_unsupported'
  | 'trade.copy_cap_exceeded'
  | 'trade.copy_market_not_permitted'
  | 'trade.copy_key_expired'
  | 'trade.copy_fee_share_killed'
  | 'trade.copy_pnl_fee_forbidden'
  | 'trade.copy_ranking_forbidden'
  | 'trade.copy_settle_refused'
  | 'trade.copy_leader_fill_not_found'
  | 'trade.copy_auto_mirror_place_socket'
  | 'trade.copy_place_disabled'
  | 'trade.copy_paper_live_forbidden'
  | 'trade.copy_session_key_missing'
  | 'trade.copy_session_key_revoked'
  | 'trade.copy_paused'
  | 'trade.copy_stopped'
  | 'trade.copy_detached'
  | 'trade.copy_leader_resume_forbidden'
  | 'trade.copy_state_invalid'
  | 'trade.copy_flatten_refused'
  | 'trade.copy_flatten_drift'
  | 'trade.copy_flatten_unavailable'
  | 'trade.copy_flatten_partial'
  | 'trade.copy_unavailable'
  | 'trade.copy_trail_window_unset'
  | 'trade.copy_trail_window_too_wide'
  | 'trade.copy_trail_limit_unset'
  | 'trade.copy_trail_cursor_invalid'
  | 'trade.copy_divergence_basis_unset'
  | 'trade.copy_leaders_limit_unset'
  | 'trade.copy_follow_events_limit_unset'
  | 'trade.copy_leaders_cursor_invalid'
  | 'trade.copy_leader_suspended'
  | 'trade.copy_leader_delisted'
  | 'trade.copy_leader_capacity_full'
  | 'trade.copy_leader_not_found'
  | 'trade.copy_leader_identity_unset'
  | 'trade.copy_leader_evidence_unset'
  | 'trade.copy_leader_request_unset'
  | 'trade.copy_leader_request_mismatch'
  | 'trade.copy_leader_record_blank'
  | 'trade.copy_leader_state_invalid'
  | 'trade.copy_leader_state_reason_unset'
  | 'trade.copy_leader_mode_invalid'
  | 'trade.copy_leader_search_invalid'
  | 'trade.copy_leader_trades_limit_unset'
  | 'trade.copy_leader_trades_cursor_invalid'
  | 'trade.copy_fixed_size_above_cap'
  | 'trade.copy_tier_unset'
  | 'trade.tier_insufficient'
  | 'trade.copy_subaccount_refused'
  | 'trade.copy_reserve_exceeds_balance'
  | 'trade.copy_market_quote_mixed';

/**
 * Closed set for the customer desk and blank-law refusals.
 * TRD-0722 names no code for an unmounted copy service, so that case is `trade.copy_unavailable`.
 */
export const COPY_DESK_BLOCKER_CODES = [
  'trade.copy_fee_share_blank',
  'trade.copy_jurisdiction_blank',
  'trade.copy_place_disabled',
  'trade.copy_unavailable',
] as const;
export type CopyDeskBlockerCode = (typeof COPY_DESK_BLOCKER_CODES)[number];
export type CopyDeskBlocker = { readonly code: CopyDeskBlockerCode };

const DESK_BLOCKER_CODES = new Set<string>(COPY_DESK_BLOCKER_CODES);

function defaultDeskBlockers(code: CopyErrorCode): readonly CopyDeskBlocker[] | undefined {
  if (!DESK_BLOCKER_CODES.has(code)) return undefined;
  return [{ code: code as CopyDeskBlockerCode }];
}

export class CopyError extends Error {
  readonly blockers: readonly CopyDeskBlocker[] | undefined;

  constructor(
    message: string,
    readonly code: CopyErrorCode,
    readonly residual?: string,
    /** Placed close order ids when a later market refuses (`trade.copy_flatten_partial`). */
    readonly orderIds?: readonly string[],
    blockers?: readonly CopyDeskBlocker[],
  ) {
    super(message);
    this.name = 'CopyError';
    this.blockers = blockers ?? defaultDeskBlockers(code);
    if (residual) logCopyResidual(code, residual);
  }
}

/** Customer text when the leader fee share is unpublished. Spec id stays in the server log. */
export const COPY_FEE_SHARE_RESIDUAL = 'Copy trading is not available yet: the leader fee share is not set.';

/** Customer text when the served-region list is unpublished. */
export const COPY_JURISDICTION_RESIDUAL = 'Copy trading is not available yet: the list of served regions is not set.';

export const COPY_LAW_RESIDUAL = 'Copy trading is not available yet: the leader fee share and the list of served regions are not set.';
