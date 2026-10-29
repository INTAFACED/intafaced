/**
 * User-visible copy for svc-token refuse paths.
 *
 * Every TokenError code has a plain sentence here. Catalog keys that are not
 * token codes (error.*, ledger.*) still render through `@intafaced/i18n`.
 * A key this module does not own stays the dotted name: missing copy must
 * not invent a sentence, and must not come out blank.
 *
 * Emission magnitudes and supply figures are never written here.
 */
import { createTranslator } from '@intafaced/i18n';
import type { TokenError } from './token-service.js';

const translator = createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined });

/** Ledger / generic keys that already have a catalog sentence. */
const CATALOG_ALIAS: Readonly<Record<string, string>> = {
  'ledger.insufficient_funds': 'error.insufficientFunds',
};

/**
 * One sentence per svc-token refusal code. No amounts, no invented schedule.
 * `token.params_unset` names the missing column only when the caller passes it.
 */
export const TOKEN_REFUSAL_COPY = {
  'token.stake_not_found': 'We could not find that stake.',
  'token.stake_locked': 'This stake is still locked.',
  'token.stake_closed': 'This stake is already closed.',
  'token.stake_conflict': 'That stake is already being changed. Try again.',
  'token.stake_id_required': 'A stake needs an id from you before it can be opened.',
  'token.stake_claim_missing': 'The stake could not be confirmed. Try again.',
  'token.stake_ledger_mismatch': 'This stake does not match the ledger, so it cannot be used.',
  'token.epoch_closed': 'That emission period is already closed.',
  'token.epoch_too_early': 'A new emission period cannot start yet.',
  'token.supply_exhausted': 'No further tokens can be issued under the current schedule.',
  'token.nothing_to_distribute': 'There is nothing to distribute for this period.',
  'token.yield_source_underfunded': 'There is not enough fee revenue to pay that distribution.',
  'token.yield_window_mismatch': 'This distribution period does not match the amount already recorded.',
  'token.yield_job_unset': 'Yield distribution is not turned on.',
  'token.emissions_tick_unset': 'The emission timer is not set.',
  'token.buyback_window_overlap': 'That revenue period is already used by another buyback.',
  'token.buyback_window_invalid': 'That buyback period is not valid.',
  'token.buyback_run_conflict': 'That buyback is already in progress.',
  'token.buyback_revenue_invalid': 'The buyback revenue figure is not valid.',
  'token.buyback_tokens_unmoved': 'Those tokens were not bought, so nothing was burned.',
  'token.buyback_job_unset': 'Buybacks are not turned on.',
  'token.buyback_book_empty': 'There is nothing on the book to buy.',
  'token.params_missing': 'Token settings are not installed.',
  'token.params_invalid': 'Those token settings are not valid.',
  'token.params_unset': 'Token settings are not set.',
  'token.fee_discount_stale': 'The fee discount schedule changed since this was approved. Read it again and approve the new change.',
  'token.fee_discount_invalid': 'That fee discount schedule is not valid.',
  'token.proposal_not_found': 'We could not find that proposal.',
  'token.proposal_not_open': 'That proposal is not open.',
  'token.proposal_window': 'That proposal is outside its voting window.',
  'token.proposal_not_allowed': 'You do not have access to this.',
  'token.already_voted': 'You have already voted on this proposal.',
  'token.no_voting_weight': 'You have no voting weight.',
  'token.proposal_list_limit_unset': 'The proposal list size is not set.',
  'token.stakes_list_limit_unset': 'The stake list size is not set.',
  'token.governance_quorum_unset': 'The vote threshold is not set.',
  'token.governance_snapshot_missing': 'This proposal has no voting power record, so it cannot be voted on or closed.',
  'token.governance_execute_unwired': 'This proposal can be counted, but it cannot be carried out yet.',
  'token.staking_asset_unpublished': 'The staking asset is not published.',
  'token.stake_tier_unknown': 'That stake term is not one this service offers.',
  'token.stake_amount_invalid': 'The stake amount must be positive.',
  'token.history_list_limit_unset': 'The history list size is not set.',
  'token.history_cursor_invalid': 'That history page marker is not valid.',
  'token.emission_schedule_count_unset': 'The emission schedule length is not set.',
  'token.ledger_tx_unread': 'That payout is not on the ledger.',
  'token.delegation_delegatee_unset': 'The person to delegate to is not set.',
  'token.delegation_delegatee_invalid': 'That delegation target is not a member.',
  'token.delegation_unavailable': 'There is no chain service and no on-chain delegate registry.',
  'token.treasury_figure_unreadable': 'A treasury figure recorded by this service could not be read.',
  'token.proposer_rule_unset': 'Who may open a proposal is not set.',
  'token.proposal_limit_unset': 'The proposal limit is not set.',
  'token.proposal_limit_reached': 'You have reached the proposal limit for this period.',
  'token.proposal_not_editable': 'That proposal can no longer be edited.',
  'token.proposal_title_invalid': 'That proposal title is not valid.',
  'token.proposal_handle_invalid': 'That proposal request is not valid.',
  'token.ballot_invalid': 'That ballot does not fit this proposal.',
  'token.voting_type_unsupported': 'That voting type is not supported.',
  'token.vote_rule_unset': 'Who may vote is not set.',
  'token.vote_rule_not_met': 'Your voting power for this proposal is below the vote rule.',
  'token.signed_vote_unavailable':
    'Your signed vote could not be checked: no wallet is linked to your account, or the check is unavailable. Nothing was saved.',
  'token.vote_signature_required': 'Sign your vote with the wallet linked to your account. Unsigned votes are not accepted.',
  'token.vote_signature_invalid': 'That signature is not from a wallet linked to your account, so the vote was not saved.',
} as const satisfies Record<TokenError['code'], string>;

/** Refusal codes that are not TokenError: job HMAC, emissions switch, ready honesty. */
export const TOKEN_WIRE_COPY = {
  'token.unauthenticated': 'Service credentials are required.',
  'token.forbidden': 'You do not have access to this.',
  'token.emissions_disabled': 'Token issuance is turned off.',
  'token.ledger_unwired': 'The ledger is not connected.',
  'token.ledger_unprobed': 'The ledger connection has not been checked.',
} as const;

const REFUSAL_COPY: Readonly<Record<string, string>> = { ...TOKEN_REFUSAL_COPY, ...TOKEN_WIRE_COPY };

type RefusalCode = keyof typeof TOKEN_REFUSAL_COPY | keyof typeof TOKEN_WIRE_COPY;

const CONFIG_NAME = /^token_params\.[A-Za-z0-9_.]+$/;

export function userCopy(key: string, params: Readonly<Record<string, string | number | bigint>> = {}): string {
  if (key === 'token.params_unset') {
    const base = TOKEN_REFUSAL_COPY['token.params_unset'];
    const config = params.config;
    if (typeof config === 'string' && CONFIG_NAME.test(config)) return `${base} Missing ${config}.`;
    return base;
  }
  if (Object.prototype.hasOwnProperty.call(REFUSAL_COPY, key)) {
    return REFUSAL_COPY[key as RefusalCode]!;
  }
  return translator.tUnsafe(CATALOG_ALIAS[key] ?? key, params);
}
