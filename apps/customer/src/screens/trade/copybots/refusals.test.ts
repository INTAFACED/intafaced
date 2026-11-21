import { readFileSync, readdirSync } from 'node:fs';
import {
  MARKET_SIGNALS_ARCHIVE,
  MARKET_SIGNALS_CRITERIA,
  MARKET_SIGNALS_EARNINGS,
  MARKET_SIGNALS_LIST,
  MARKET_SIGNALS_MINE,
  MARKET_SIGNALS_PUBLISH,
} from '@intafaced/contracts/market-procedures';
import { describe, expect, it } from 'vitest';
import type { CopyErrorCode } from '../../../../../../services/svc-trade/src/copy/errors';
import type { GridErrorCode } from '../../../../../../services/svc-trade/src/grid/errors';
import { KNOWN_ROOM_CODES, roomRefusal } from './refusals';

/**
 * Every code svc-trade's CopyError and GridError can carry. `satisfies Record<Code, true>` makes the type check refuse a
 * code the service adds that is missing here, and a code here the service no longer has, so these lists are the
 * services' own unions, held by the customer app's typecheck.
 */
const COPY_CODES = {
  'trade.copy_fee_share_blank': true,
  'trade.copy_jurisdiction_blank': true,
  'trade.copy_law_blank': true,
  'trade.copy_jurisdiction_blocked': true,
  'trade.copy_self_follow': true,
  'trade.copy_already_following': true,
  'trade.copy_not_following': true,
  'trade.copy_envelope_invalid': true,
  'trade.copy_limit_missing': true,
  'trade.copy_slippage_exceeded': true,
  'trade.copy_concurrency_exceeded': true,
  'trade.copy_drawdown_stop': true,
  'trade.copy_limit_unevaluable': true,
  'trade.copy_leverage_unsupported': true,
  'trade.copy_cap_exceeded': true,
  'trade.copy_market_not_permitted': true,
  'trade.copy_key_expired': true,
  'trade.copy_fee_share_killed': true,
  'trade.copy_pnl_fee_forbidden': true,
  'trade.copy_ranking_forbidden': true,
  'trade.copy_settle_refused': true,
  'trade.copy_settlement_window_required': true,
  'trade.copy_leader_fill_not_found': true,
  'trade.copy_auto_mirror_place_socket': true,
  'trade.copy_place_disabled': true,
  'trade.copy_paper_live_forbidden': true,
  'trade.copy_session_key_missing': true,
  'trade.copy_session_key_revoked': true,
  'trade.copy_paused': true,
  'trade.copy_paused_by_platform': true,
  'trade.copy_stopped': true,
  'trade.copy_detached': true,
  'trade.copy_request_key_invalid': true,
  'trade.copy_leader_resume_forbidden': true,
  'trade.copy_state_invalid': true,
  'trade.copy_flatten_refused': true,
  'trade.copy_flatten_drift': true,
  'trade.copy_flatten_unavailable': true,
  'trade.copy_flatten_partial': true,
  'trade.copy_unavailable': true,
  'trade.copy_trail_window_unset': true,
  'trade.copy_trail_window_too_wide': true,
  'trade.copy_trail_limit_unset': true,
  'trade.copy_trail_cursor_invalid': true,
  'trade.copy_divergence_basis_unset': true,
  'trade.copy_leaders_limit_unset': true,
  'trade.copy_follow_events_limit_unset': true,
  'trade.copy_leaders_cursor_invalid': true,
  'trade.copy_leader_suspended': true,
  'trade.copy_leader_delisted': true,
  'trade.copy_leader_capacity_full': true,
  'trade.copy_leader_not_found': true,
  'trade.copy_leader_identity_unset': true,
  'trade.copy_leader_evidence_unset': true,
  'trade.copy_leader_request_unset': true,
  'trade.copy_leader_request_mismatch': true,
  'trade.copy_leader_record_blank': true,
  'trade.copy_leader_state_invalid': true,
  'trade.copy_leader_state_reason_unset': true,
  'trade.copy_leader_mode_invalid': true,
  'trade.copy_leader_search_invalid': true,
  'trade.copy_leader_trades_limit_unset': true,
  'trade.copy_leader_trades_cursor_invalid': true,
  'trade.copy_fixed_size_above_cap': true,
  'trade.copy_tier_unset': true,
  'trade.tier_insufficient': true,
  'trade.copy_subaccount_refused': true,
  'trade.copy_reserve_exceeds_balance': true,
  'trade.copy_market_quote_mixed': true,
  'trade.copy_lead_name_invalid': true,
  'trade.copy_lead_application_open': true,
  'trade.copy_lead_already_leading': true,
  'trade.copy_lead_criteria_unset': true,
  'trade.copy_lead_application_decided': true,
  'trade.copy_lead_application_not_found': true,
  'trade.copy_lead_reapply_wait_unset': true,
  'trade.copy_lead_reapply_wait': true,
  'trade.copy_lead_following': true,
  'trade.copy_lead_balance_threshold_unset': true,
  'trade.copy_lead_venue_account_missing': true,
  'trade.copy_lead_venue_unreadable': true,
  'trade.copy_lead_balance_below': true,
  'trade.copy_lead_not_listed': true,
  'trade.copy_leader_instruments_not_set': true,
  'trade.copy_lead_instrument_unlisted': true,
  'trade.copy_lead_price_required': true,
  'trade.copy_pair_limit_not_set': true,
  'trade.copy_pair_holding_limit': true,
  'trade.copy_leader_limit_not_set': true,
  'trade.copy_daily_buy_cap': true,
  'trade.copy_leader_equity_below_min': true,
  'trade.copy_not_lead_order': true,
  'trade.copy_mode_owner_decision': true,
  'trade.copy_mode_locked': true,
  'trade.copy_smart_sync_unavailable': true,
  'trade.copy_min_not_set': true,
  'trade.copy_below_min_investment': true,
  'trade.copy_day_not_set': true,
  'trade.copy_market_cap_reached': true,
  'trade.copy_daily_cap_reached': true,
  'trade.copy_venue_account_not_open': true,
} as const satisfies Record<CopyErrorCode, true>;
const GRID_CODES = {
  'trade.bots_paused_by_platform': true,
  'trade.grid_request_key_invalid': true,
  'trade.grid_request_conflict': true,
  'trade.grid_market_not_found': true,
  'trade.grid_market_not_spot': true,
  'trade.bots_grid_bounds_not_set': true,
  'trade.bots_grid_bounds_band_not_set': true,
  'trade.bots_grid_bounds_out_of_band': true,
  'trade.grid_investment_required': true,
  'trade.grid_count_required': true,
  'trade.grid_bounds_inverted': true,
  'trade.grid_count_range_not_set': true,
  'trade.bots_grid_count_out_of_range': true,
  'trade.grid_spacing_below_tick': true,
  'trade.grid_level_below_minimum': true,
  'trade.grid_mark_unavailable': true,
  'trade.grid_reserve_exceeds_balance': true,
  'trade.grid_initialization_failed': true,
  'trade.grid_not_found': true,
  'trade.grid_not_running': true,
  'trade.grid_unavailable': true,
  'trade.bots_withdraw_amount_invalid': true,
  'trade.bots_withdraw_asset_mismatch': true,
  'trade.bots_withdraw_cap_unset': true,
  'trade.bots_withdraw_cap_exceeded': true,
  'trade.bots_withdraw_exceeds_profit': true,
  'trade.bots_withdraw_exceeds_balance': true,
  'trade.bots_withdraw_reserve_released': true,
  'trade.bots_withdraw_conflict': true,
  'trade.grid_request_invalid': true,
  'trade.grid_direction_not_built': true,
  'trade.grid_settlement_not_built': true,
  'trade.bots_grid_topup_amount_invalid': true,
  'trade.bots_grid_topup_quote_only': true,
  'trade.bots_grid_topup_exceeds_free': true,
  'trade.bots_grid_topup_conflict': true,
  'trade.bots_grid_trailing_shift_limit_required': true,
  'trade.bots_grid_trailing_shift_limit_invalid': true,
  'trade.bots_grid_min_count_invalid': true,
  'trade.bots_grid_min_count_above_count': true,
  'trade.bots_grid_trailing_not_built': true,
  'trade.bots_grid_rsi_source_not_set': true,
  'trade.bots_grid_exit_price_invalid': true,
  'trade.bots_grid_idle_yield_unwired': true,
  'trade.api_withdraw_not_allowed': true,
  'trade.bots_grid_wallet_required': true,
  'trade.bots_grid_agent_key_unset': true,
  'trade.bots_grid_builder_fee_unapproved': true,
  'trade.bots_grid_not_signing': true,
  'trade.bots_grid_venue_unreadable': true,
  'trade.bots_grid_withdraw_not_permitted': true,
} as const satisfies Record<GridErrorCode, true>;

/**
 * svc-market's signal publisher, imported at run time: its exported refusal codes. The path is a URL rather than a static
 * specifier only so this app's type program does not pull a services/ file in; the values are the module's real exports.
 */
const PUBLISHER_URL = new URL('../../../../../../services/svc-market/src/signals/signal-publisher.ts', import.meta.url).href;
const PUBLISHER_CODES = Object.values((await import(PUBLISHER_URL)) as Record<string, unknown>).filter(
  (value): value is string => typeof value === 'string' && value.startsWith('market.'),
);

/** The signal calls the rooms make; each record's refusals are the codes svc-market answers it with. */
const SIGNAL_RECORDS = [
  MARKET_SIGNALS_ARCHIVE,
  MARKET_SIGNALS_CRITERIA,
  MARKET_SIGNALS_EARNINGS,
  MARKET_SIGNALS_LIST,
  MARKET_SIGNALS_MINE,
  MARKET_SIGNALS_PUBLISH,
] as const;
/**
 * Codes the rooms do not word: the publisher's internal three, and `market.strategy_return_rank_forbidden`, which publish
 * can answer through the strategy copy-law check it runs first but which the publisher file never named itself. The
 * screens have no words for it yet.
 */
const SIGNAL_INTERNAL = new Set([
  'market.signal_vetting_missing',
  'market.signal_key_required',
  'market.signal_fee_model_invalid',
  'market.strategy_return_rank_forbidden',
]);

const failure = (
  code: string | undefined,
  message = 'DIRECTION §8 / D26-P0-02 leader_share_bps is owner-only',
  reason: 'error' | 'uncertain' = 'error',
) => ({ ok: false as const, reason, message, ...(code ? { code } : {}) });

describe('roomRefusal', () => {
  it('maps every code the signal calls refuse with (J-copy-bots-otc-22)', () => {
    // The refusals svc-market mounts each signal call with (mountRecord reads them from these records).
    const codes = SIGNAL_RECORDS.flatMap((record) => Object.keys(record.refusals)).filter((code) =>
      /^market\.(?:provider|price|signal|subscription|strategy)_[a-z_]+$/.test(code),
    );
    expect(codes.length).toBeGreaterThan(8);
    for (const code of new Set(codes)) if (!SIGNAL_INTERNAL.has(code)) expect(KNOWN_ROOM_CODES, code).toContain(code);
    // And the publisher's own named codes, which the records may not all declare.
    expect(PUBLISHER_CODES.length).toBeGreaterThan(8);
    for (const code of PUBLISHER_CODES) expect(KNOWN_ROOM_CODES, code).toContain(code);
  });
  it('maps every copy and algo code the service throws', () => {
    const copyCodes = Object.keys(COPY_CODES);
    expect(copyCodes.length).toBeGreaterThan(25);
    for (const code of copyCodes) expect(KNOWN_ROOM_CODES, code).toContain(code);
  });
  it('maps every grid code the service throws, and the bot verification codes', () => {
    const gridCodes = Object.keys(GRID_CODES);
    expect(gridCodes.filter((code) => code.startsWith('trade.grid_')).length).toBeGreaterThan(15);
    expect(gridCodes.filter((code) => code.startsWith('trade.bots_withdraw_')).length).toBeGreaterThan(6);
    for (const code of [
      ...gridCodes,
      'trade.bots_verification_insufficient',
      'trade.bots_verification_level_not_set',
      'identity.step_up_required',
      'identity.step_up_unavailable',
    ])
      expect(KNOWN_ROOM_CODES, code).toContain(code);
  });
  it('never repeats the service sentence', () => {
    const shown = roomRefusal(failure('trade.copy_jurisdiction_blank'));
    expect(JSON.stringify(shown)).not.toMatch(/DIRECTION|D26-P0|leader_share_bps|owner-only|residual/i);
    const unknown = roomRefusal(failure('trade.some_new_code'));
    expect(JSON.stringify(unknown)).not.toMatch(/DIRECTION|D26-P0|leader_share_bps|owner-only/i);
  });
  it('has plain words for the algo creation-gate codes', () => {
    for (const code of [
      'trade.algo_insufficient_balance',
      'trade.algo_balance_unreadable',
      'trade.algo_price_band',
      'trade.algo_volume_immature',
      'trade.algo_mark_policy_unset',
      'trade.fee_schedule_blank',
    ]) {
      const shown = roomRefusal(failure(code, 'AlgoMarkPolicy.maxAgeSeconds is unset — TRADE_FEE_SCHEDULE'));
      expect(shown.title.length, code).toBeGreaterThan(0);
      expect(JSON.stringify(shown), code).not.toMatch(/AlgoMarkPolicy|TRADE_FEE_SCHEDULE|unset —/);
    }
  });
  it('says a lost reply is unknown, not failed', () => {
    expect(roomRefusal(failure(undefined, 'x', 'uncertain')).title).toMatch(/can’t tell/);
  });
});

describe('screens never print a service sentence', () => {
  it('has no .residual, .statusLine or .message rendered from a service reply', () => {
    const dir = new URL('./', import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.tsx'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(text, file).not.toMatch(/\.(residual|statusLine|residuals)\b/);
      expect(text, file).not.toMatch(/failure\.message|result\.message|\.message\}/);
    }
  });
});
