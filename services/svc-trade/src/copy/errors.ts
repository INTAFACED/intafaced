/**
 * Copy trading errors (trade.copy / D-S-03 / SPEC-SOVEREIGN-ROUTING-AND-COPY).
 *
 * Codes are stable for wire mapping — never invent leader_share_bps or
 * jurisdiction lists to avoid a refuse.
 */

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
  | 'trade.copy_flatten_partial';

export class CopyError extends Error {
  constructor(
    message: string,
    readonly code: CopyErrorCode,
    readonly residual?: string,
    /** Placed close order ids when a later market refuses (`trade.copy_flatten_partial`). */
    readonly orderIds?: readonly string[],
  ) {
    super(message);
    this.name = 'CopyError';
  }
}

/** Customer text when the leader fee share is unpublished. Spec id stays in the server log. */
export const COPY_FEE_SHARE_RESIDUAL = 'Copy trading is not available yet: the leader fee share is not set.';

/** Customer text when the served-region list is unpublished. */
export const COPY_JURISDICTION_RESIDUAL = 'Copy trading is not available yet: the list of served regions is not set.';

export const COPY_LAW_RESIDUAL = 'Copy trading is not available yet: the leader fee share and the list of served regions are not set.';
