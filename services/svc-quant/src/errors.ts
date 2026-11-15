export const QUANT_SANDBOX_UNWIRED = 'quant.sandbox_unwired' as const;
export const QUANT_SANDBOX_ESCAPE = 'quant.sandbox_escape' as const;
export const QUANT_SANDBOX_TIMEOUT = 'quant.sandbox_timeout' as const;
export const QUANT_SANDBOX_SYNTAX = 'quant.sandbox_syntax' as const;
export const QUANT_SANDBOX_MAX_OPS_UNSET = 'quant.sandbox_max_ops_unset' as const;
export const QUANT_SANDBOX_MAX_SOURCE_UNSET = 'quant.sandbox_max_source_unset' as const;
/** A sandbox limit of the plan (wall-clock, memory, output) the owner has not set: no run starts (AL-limits-02). */
export const QUANT_SANDBOX_LIMIT_UNSET = 'quant.sandbox_limit_unset' as const;
/** A run's variables reached the plan's memory limit: it ends before the text is made. */
export const QUANT_SANDBOX_MEMORY = 'quant.sandbox_memory' as const;
/** A run's log reached the plan's output limit: it ends with the log cut at the limit. */
export const QUANT_SANDBOX_OUTPUT = 'quant.sandbox_output' as const;
export const QUANT_VENUE_VAULT_UNSET = 'quant.venue_vault_unset' as const;
export const QUANT_STUDIO_RISK_BLOCK_REQUIRED = 'quant.studio_risk_block_required' as const;
export const QUANT_BACKTEST_LAKE_MISSING = 'quant.backtest_lake_missing' as const;
export const QUANT_BACKTEST_FILLS_MISSING = 'quant.backtest_fills_missing' as const;
export const QUANT_BACKTEST_WALK_FORWARD_REQUIRED = 'quant.backtest_walk_forward_required' as const;
export const QUANT_BACKTEST_SURFACE_REFUSED = 'quant.backtest_surface_refused' as const;
export const QUANT_ENVIRONMENT_REQUIRED = 'quant.environment_required' as const;
export const QUANT_ENVIRONMENT_UNKNOWN = 'quant.environment_unknown' as const;
export const QUANT_SIMULATED_AS_LIVE = 'quant.simulated_as_live' as const;
export const QUANT_CASH_UNSET = 'quant.cash_unset' as const;
export const QUANT_STUDIO_LIST_LIMIT_UNSET = 'quant.studio_list_limit_unset' as const;
export const QUANT_STUDIO_NOT_FOUND = 'quant.studio_not_found' as const;
export const QUANT_CLIENT_STRATEGY_ID_UNSET = 'quant.client_strategy_id_unset' as const;
export const QUANT_IDEMPOTENCY_KEY_UNSET = 'quant.idempotency_key_unset' as const;
export const QUANT_IDEMPOTENCY_CONFLICT = 'quant.idempotency_conflict' as const;
export const QUANT_STRATEGY_VERSION_UNSET = 'quant.strategy_version_unset' as const;
export const QUANT_LIST_CURSOR_INVALID = 'quant.list_cursor_invalid' as const;
export const QUANT_DATABASE_URL_UNSET = 'quant.database_url_unset' as const;
export const QUANT_DATABASE_POOL_MAX_UNSET = 'quant.database_pool_max_unset' as const;
export const QUANT_RUN_NOT_FOUND = 'quant.run_not_found' as const;
export const QUANT_RUN_IMMUTABLE = 'quant.run_immutable' as const;
/** The strategy API (J-algo-dev-14): a key's call outside it, and a key's backtest start under its Idempotency-Key. */
export const QUANT_KEY_NO_SUCH_ENDPOINT = 'quant.key_no_such_endpoint' as const;
export const QUANT_IDEMPOTENCY_KEY_REQUIRED = 'quant.idempotency_key_required' as const;
export const QUANT_IDEMPOTENCY_KEY_INVALID = 'quant.idempotency_key_invalid' as const;
export const QUANT_IDEMPOTENCY_KEY_REUSED = 'quant.idempotency_key_reused' as const;
export const QUANT_RUN_UNFINISHED = 'quant.run_unfinished' as const;
export const QUANT_RUN_NOT_SIMULATED = 'quant.run_not_simulated' as const;
export const QUANT_RUN_RESULT_CAP_UNSET = 'quant.run_result_cap_unset' as const;
export const QUANT_RUN_RESULT_TOO_LARGE = 'quant.run_result_too_large' as const;
export const QUANT_CLAIM_PNL_UNSET = 'quant.claim_pnl_unset' as const;
export const QUANT_OPS_RUNS_LIMIT_UNSET = 'quant.ops_runs_limit_unset' as const;
export const QUANT_OPS_RUNS_FROM_UNSET = 'quant.ops_runs_from_unset' as const;
export const QUANT_OPS_RUNS_TO_UNSET = 'quant.ops_runs_to_unset' as const;
export const QUANT_DISCLOSURE_UNSET = 'quant.disclosure_unset' as const;
export const QUANT_DISCLOSURE_VERSION_STALE = 'quant.disclosure_version_stale' as const;
export const QUANT_PARAM_UNSET = 'quant.param_unset' as const;
export const QUANT_PARAM_OUT_OF_RANGE = 'quant.param_out_of_range' as const;
export const QUANT_SIZING_RULE_UNSET = 'quant.sizing_rule_unset' as const;
export const QUANT_SIGNAL_RULES_SANDBOX = 'quant.signal_rules_sandbox' as const;
export const QUANT_TEMPLATE_NOT_FOUND = 'quant.template_not_found' as const;
export const QUANT_TEMPLATE_LIST_LIMIT_UNSET = 'quant.template_list_limit_unset' as const;
export const QUANT_TEMPLATE_NUMBER_SET = 'quant.template_number_set' as const;
export const QUANT_COST_UNSET = 'quant.cost_unset' as const;
export const QUANT_FILL_TIMING_UNSET = 'quant.fill_timing_unset' as const;
export const QUANT_BACKTEST_WINDOW_INVALID = 'quant.backtest_window_invalid' as const;
export const QUANT_BACKTEST_WINDOW_OPEN = 'quant.backtest_window_open' as const;
export const QUANT_BACKTEST_HISTORY_RANGE = 'quant.backtest_history_range' as const;
export const QUANT_BACKTEST_RULES_REQUIRED = 'quant.backtest_rules_required' as const;
export const QUANT_HOLDOUT_DATE_UNSET = 'quant.holdout_date_unset' as const;
export const QUANT_HOLDOUT_OVERLAP = 'quant.holdout_overlap' as const;
export const QUANT_ACCOUNT_RULE_UNSET = 'quant.account_rule_unset' as const;
export const QUANT_SHARE_RATE_UNSET = 'quant.share_rate_unset' as const;
export const QUANT_SHARE_WINDOW_UNSET = 'quant.share_window_unset' as const;
export const QUANT_SHARE_RATE_LIMITED = 'quant.share_rate_limited' as const;
export const QUANT_EMBED_ORIGINS_UNSET = 'quant.embed_origins_unset' as const;
export const QUANT_SHARE_NOT_FOUND = 'quant.share_not_found' as const;
export const QUANT_SHARE_SEQ_UNSET = 'quant.share_seq_unset' as const;
export const QUANT_SHARE_SEQ_STALE = 'quant.share_seq_stale' as const;
export const QUANT_SHARE_TOKEN_UNSET = 'quant.share_token_unset' as const;
export const QUANT_RELEASE_NOTE_LIMIT_UNSET = 'quant.release_note_limit_unset' as const;
export const QUANT_VERSION_NOT_FOUND = 'quant.version_not_found' as const;
export const QUANT_QUOTA_UNSET = 'quant.quota_unset' as const;
export const QUANT_QUOTA_EXCEEDED = 'quant.quota_exceeded' as const;
export const QUANT_QUOTA_PROFILE_UNSET = 'quant.quota_profile_unset' as const;
export const QUANT_QUOTA_REASON_UNSET = 'quant.quota_reason_unset' as const;
export const QUANT_PAPER_CASH_UNSET = 'quant.paper_cash_unset' as const;
export const QUANT_PAPER_FEE_UNSET = 'quant.paper_fee_unset' as const;
export const QUANT_PAPER_LIST_LIMIT_UNSET = 'quant.paper_list_limit_unset' as const;
export const QUANT_NOTIFY_CHANNEL_UNAVAILABLE = 'quant.notify_channel_unavailable' as const;
/** A risk cap still blank when the trading switch is turned on (AL-risk-01): the switch stays off, nothing is assumed. */
export const QUANT_RISK_CAP_UNSET = 'quant.risk_cap_unset' as const;
/** A risk cap or floor policy that does not read as one (AL-risk-01): nothing is saved. */
export const QUANT_RISK_CAP_INVALID = 'quant.risk_cap_invalid' as const;
export const QUANT_ALERT_TEMPLATE_INVALID = 'alert.template_invalid' as const;
/** A promotion gate criterion the owner has not set (AL-lifecycle-01): promotion is blocked and nothing is written. */
export const QUANT_GATE_CRITERIA_UNSET = 'quant.gate_criteria_unset' as const;
/** A stage move ENGINE LC-2 does not allow, such as promoting a version that already left `paper`. */
export const QUANT_STAGE_TRANSITION_INVALID = 'quant.stage_transition_invalid' as const;
/** An operator write of an owner criterion with no reason. */
export const QUANT_CRITERIA_REASON_UNSET = 'quant.criteria_reason_unset' as const;
/** A teammate asked for what their permission on a shared strategy does not give (J-algo-dev-08). */
export const QUANT_PERMISSION_DENIED = 'quant.permission_denied' as const;
/** Another person holds the strategy's edit lock until its stored time. */
export const QUANT_EDIT_LOCKED = 'quant.edit_locked' as const;
/** A manual order to a paper run, by a teammate with live control: a paper run trades only by its own rules. */
export const QUANT_PAPER_MANUAL_ORDER_UNSUPPORTED = 'quant.paper_manual_order_unsupported' as const;
/** The owner's edit lock length (`QUANT_EDIT_LOCK_SECONDS`) is blank: no lock can be taken, so no shared save. */
export const QUANT_EDIT_LOCK_UNSET = 'quant.edit_lock_unset' as const;
/** A collaborator who is the owner, or an id that is no account id. */
export const QUANT_TEAM_MEMBER_INVALID = 'quant.team_member_invalid' as const;
/** A support grant length outside the screen's bounds. */
export const QUANT_GRANT_INVALID = 'quant.grant_invalid' as const;

/** The strategy library (J-algo-dev-09). The owner's licence list (`QUANT_LIBRARY_LICENCES`) is blank: nothing is listed. */
export const QUANT_LIBRARY_LICENCES_UNSET = 'quant.library_licences_unset' as const;
/** The owner's realism checklist (`QUANT_REALISM_CHECKLIST`) is blank: nothing is listed. */
export const QUANT_REALISM_CHECKLIST_UNSET = 'quant.realism_checklist_unset' as const;
/** Publish without every item of the current realism checklist accepted. */
export const QUANT_REALISM_CHECKLIST_UNACCEPTED = 'quant.realism_checklist_unaccepted' as const;
/** A publish check failed; the message names the check and what failed. Nothing is listed. */
export const QUANT_LISTING_CHECK_FAILED = 'quant.listing_check_failed' as const;
/** A publish of a version that is no longer the strategy's newest: it needs a new check of the new version. */
export const QUANT_LISTING_STALE = 'quant.listing_stale' as const;
export const QUANT_LISTING_NOT_FOUND = 'quant.listing_not_found' as const;
/** An invite-only listing the caller holds no grant to. */
export const QUANT_LISTING_ACCESS_DENIED = 'quant.listing_access_denied' as const;
/** A clone of a protected listing: its source never leaves the owner. */
export const QUANT_LISTING_SOURCE_PROTECTED = 'quant.listing_source_protected' as const;
/** A review by someone whose own clone of the listing has no finished run. */
export const QUANT_REVIEW_NEEDS_RUN = 'quant.review_needs_run' as const;
/** Library moderation (J-algo-dev-10). The owner's queue page size (`library.queuePageSize`) is blank: the queue refuses. */
export const QUANT_LIBRARY_QUEUE_LIMIT_UNSET = 'quant.library_queue_limit_unset' as const;
/** A moderation action or a dispute without a reason: nothing is written. */
export const QUANT_MODERATION_REASON_REQUIRED = 'quant.moderation_reason_required' as const;
/** A dispute without its support ticket reference: nothing is written. */
export const QUANT_DISPUTE_TICKET_REQUIRED = 'quant.dispute_ticket_required' as const;
/** An action the listing's state does not take (hide a hidden one, unhide a listed one, anything on a removed one). */
export const QUANT_MODERATION_STATE_INVALID = 'quant.moderation_state_invalid' as const;
export const QUANT_DISPUTE_NOT_FOUND = 'quant.dispute_not_found' as const;

/** The platform's live switch is off (`live.enabled` blank): every live deploy refuses before anything is written. */
export const QUANT_LIVE_DISABLED = 'quant.live_disabled' as const;
/** A version the live runner cannot trade in this build (signal rules), named at the compile check. */
export const QUANT_LIVE_PLAN_UNSUPPORTED = 'quant.live_plan_unsupported' as const;
/** An order type a live deploy refuses (a stop loss or take profit), named at the compile check. */
export const QUANT_LIVE_ORDER_TYPE_UNSUPPORTED = 'trade.order_type_unsupported' as const;
/** Live is on and the version compiles, but the funding move and the live run after it are not built here yet. */
export const QUANT_LIVE_DEPLOY_UNAVAILABLE = 'quant.live_deploy_unavailable' as const;

export type QuantCode =
  | typeof QUANT_SANDBOX_UNWIRED
  | typeof QUANT_SANDBOX_ESCAPE
  | typeof QUANT_SANDBOX_TIMEOUT
  | typeof QUANT_SANDBOX_SYNTAX
  | typeof QUANT_SANDBOX_MAX_OPS_UNSET
  | typeof QUANT_SANDBOX_MAX_SOURCE_UNSET
  | typeof QUANT_SANDBOX_LIMIT_UNSET
  | typeof QUANT_SANDBOX_MEMORY
  | typeof QUANT_SANDBOX_OUTPUT
  | typeof QUANT_VENUE_VAULT_UNSET
  | typeof QUANT_STUDIO_RISK_BLOCK_REQUIRED
  | typeof QUANT_BACKTEST_LAKE_MISSING
  | typeof QUANT_BACKTEST_FILLS_MISSING
  | typeof QUANT_BACKTEST_WALK_FORWARD_REQUIRED
  | typeof QUANT_BACKTEST_SURFACE_REFUSED
  | typeof QUANT_ENVIRONMENT_REQUIRED
  | typeof QUANT_ENVIRONMENT_UNKNOWN
  | typeof QUANT_SIMULATED_AS_LIVE
  | typeof QUANT_CASH_UNSET
  | typeof QUANT_STUDIO_LIST_LIMIT_UNSET
  | typeof QUANT_STUDIO_NOT_FOUND
  | typeof QUANT_CLIENT_STRATEGY_ID_UNSET
  | typeof QUANT_IDEMPOTENCY_KEY_UNSET
  | typeof QUANT_IDEMPOTENCY_CONFLICT
  | typeof QUANT_STRATEGY_VERSION_UNSET
  | typeof QUANT_LIST_CURSOR_INVALID
  | typeof QUANT_DATABASE_URL_UNSET
  | typeof QUANT_DATABASE_POOL_MAX_UNSET
  | typeof QUANT_RUN_NOT_FOUND
  | typeof QUANT_RUN_IMMUTABLE
  | typeof QUANT_RUN_UNFINISHED
  | typeof QUANT_RUN_NOT_SIMULATED
  | typeof QUANT_RUN_RESULT_CAP_UNSET
  | typeof QUANT_RUN_RESULT_TOO_LARGE
  | typeof QUANT_CLAIM_PNL_UNSET
  | typeof QUANT_OPS_RUNS_LIMIT_UNSET
  | typeof QUANT_OPS_RUNS_FROM_UNSET
  | typeof QUANT_OPS_RUNS_TO_UNSET
  | typeof QUANT_DISCLOSURE_UNSET
  | typeof QUANT_DISCLOSURE_VERSION_STALE
  | typeof QUANT_PARAM_UNSET
  | typeof QUANT_PARAM_OUT_OF_RANGE
  | typeof QUANT_SIZING_RULE_UNSET
  | typeof QUANT_SIGNAL_RULES_SANDBOX
  | typeof QUANT_TEMPLATE_NOT_FOUND
  | typeof QUANT_TEMPLATE_LIST_LIMIT_UNSET
  | typeof QUANT_TEMPLATE_NUMBER_SET
  | typeof QUANT_COST_UNSET
  | typeof QUANT_FILL_TIMING_UNSET
  | typeof QUANT_BACKTEST_WINDOW_INVALID
  | typeof QUANT_BACKTEST_WINDOW_OPEN
  | typeof QUANT_BACKTEST_HISTORY_RANGE
  | typeof QUANT_BACKTEST_RULES_REQUIRED
  | typeof QUANT_HOLDOUT_DATE_UNSET
  | typeof QUANT_HOLDOUT_OVERLAP
  | typeof QUANT_ACCOUNT_RULE_UNSET
  | typeof QUANT_SHARE_RATE_UNSET
  | typeof QUANT_SHARE_WINDOW_UNSET
  | typeof QUANT_SHARE_RATE_LIMITED
  | typeof QUANT_EMBED_ORIGINS_UNSET
  | typeof QUANT_SHARE_NOT_FOUND
  | typeof QUANT_SHARE_SEQ_UNSET
  | typeof QUANT_SHARE_SEQ_STALE
  | typeof QUANT_SHARE_TOKEN_UNSET
  | typeof QUANT_RELEASE_NOTE_LIMIT_UNSET
  | typeof QUANT_VERSION_NOT_FOUND
  | typeof QUANT_QUOTA_UNSET
  | typeof QUANT_QUOTA_EXCEEDED
  | typeof QUANT_QUOTA_PROFILE_UNSET
  | typeof QUANT_QUOTA_REASON_UNSET
  | typeof QUANT_PAPER_CASH_UNSET
  | typeof QUANT_PAPER_FEE_UNSET
  | typeof QUANT_PAPER_LIST_LIMIT_UNSET
  | typeof QUANT_NOTIFY_CHANNEL_UNAVAILABLE
  | typeof QUANT_ALERT_TEMPLATE_INVALID
  | typeof QUANT_RISK_CAP_UNSET
  | typeof QUANT_RISK_CAP_INVALID
  | typeof QUANT_GATE_CRITERIA_UNSET
  | typeof QUANT_STAGE_TRANSITION_INVALID
  | typeof QUANT_CRITERIA_REASON_UNSET
  | typeof QUANT_PERMISSION_DENIED
  | typeof QUANT_EDIT_LOCKED
  | typeof QUANT_PAPER_MANUAL_ORDER_UNSUPPORTED
  | typeof QUANT_EDIT_LOCK_UNSET
  | typeof QUANT_TEAM_MEMBER_INVALID
  | typeof QUANT_GRANT_INVALID
  | typeof QUANT_LIBRARY_LICENCES_UNSET
  | typeof QUANT_REALISM_CHECKLIST_UNSET
  | typeof QUANT_REALISM_CHECKLIST_UNACCEPTED
  | typeof QUANT_LISTING_CHECK_FAILED
  | typeof QUANT_LISTING_STALE
  | typeof QUANT_LISTING_NOT_FOUND
  | typeof QUANT_LISTING_ACCESS_DENIED
  | typeof QUANT_LISTING_SOURCE_PROTECTED
  | typeof QUANT_REVIEW_NEEDS_RUN
  | typeof QUANT_LIBRARY_QUEUE_LIMIT_UNSET
  | typeof QUANT_MODERATION_REASON_REQUIRED
  | typeof QUANT_DISPUTE_TICKET_REQUIRED
  | typeof QUANT_MODERATION_STATE_INVALID
  | typeof QUANT_DISPUTE_NOT_FOUND
  | typeof QUANT_LIVE_DISABLED
  | typeof QUANT_LIVE_PLAN_UNSUPPORTED
  | typeof QUANT_LIVE_ORDER_TYPE_UNSUPPORTED
  | typeof QUANT_LIVE_DEPLOY_UNAVAILABLE
  | typeof QUANT_KEY_NO_SUCH_ENDPOINT
  | typeof QUANT_IDEMPOTENCY_KEY_REQUIRED
  | typeof QUANT_IDEMPOTENCY_KEY_INVALID
  | typeof QUANT_IDEMPOTENCY_KEY_REUSED
  | 'quant.params_invalid';

export class QuantError extends Error {
  readonly code: QuantCode;

  constructor(code: QuantCode, detail: string) {
    super(`${code} — ${detail}`);
    this.name = 'QuantError';
    this.code = code;
  }
}
