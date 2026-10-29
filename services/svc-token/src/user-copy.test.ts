import { describe, expect, it } from 'vitest';
import type { TokenError } from './token-service.js';
import { TOKEN_REFUSAL_COPY, TOKEN_WIRE_COPY, userCopy } from './user-copy.js';

/**
 * Every svc-token refusal code the customer can be shown has a sentence.
 * An unknown key stays the dotted name. No supply figure is written here.
 */

const TOKEN_ERROR_CODES = [
  'token.stake_not_found',
  'token.stake_locked',
  'token.stake_closed',
  'token.stake_conflict',
  'token.stake_id_required',
  'token.stake_claim_missing',
  'token.stake_ledger_mismatch',
  'token.epoch_closed',
  'token.epoch_too_early',
  'token.supply_exhausted',
  'token.nothing_to_distribute',
  'token.yield_source_underfunded',
  'token.yield_window_mismatch',
  'token.yield_job_unset',
  'token.emissions_tick_unset',
  'token.buyback_window_overlap',
  'token.buyback_window_invalid',
  'token.buyback_run_conflict',
  'token.buyback_revenue_invalid',
  'token.buyback_tokens_unmoved',
  'token.buyback_job_unset',
  'token.buyback_book_empty',
  'token.params_missing',
  'token.params_invalid',
  'token.params_unset',
  'token.fee_discount_stale',
  'token.fee_discount_invalid',
  'token.proposal_not_found',
  'token.proposal_not_open',
  'token.proposal_window',
  'token.proposal_not_allowed',
  'token.already_voted',
  'token.no_voting_weight',
  'token.proposal_list_limit_unset',
  'token.stakes_list_limit_unset',
  'token.governance_quorum_unset',
  'token.governance_snapshot_missing',
  'token.governance_execute_unwired',
  'token.staking_asset_unpublished',
  'token.stake_tier_unknown',
  'token.stake_amount_invalid',
  'token.history_list_limit_unset',
  'token.history_cursor_invalid',
  'token.emission_schedule_count_unset',
  'token.ledger_tx_unread',
  'token.delegation_delegatee_unset',
  'token.delegation_delegatee_invalid',
  'token.delegation_unavailable',
  'token.treasury_figure_unreadable',
  'token.proposer_rule_unset',
  'token.proposal_limit_unset',
  'token.proposal_limit_reached',
  'token.proposal_not_editable',
  'token.proposal_title_invalid',
  'token.proposal_handle_invalid',
  'token.ballot_invalid',
  'token.voting_type_unsupported',
  'token.vote_rule_unset',
  'token.vote_rule_not_met',
  'token.signed_vote_unavailable',
  'token.vote_signature_required',
  'token.vote_signature_invalid',
] as const satisfies readonly TokenError['code'][];

type Missing = Exclude<TokenError['code'], (typeof TOKEN_ERROR_CODES)[number]>;
const _everyTokenErrorCodeListed: [Missing] extends [never] ? true : Missing = true;
void _everyTokenErrorCodeListed;

describe('userCopy — one plain sentence per refusal code', () => {
  it('resolves catalog keys that are not token codes', () => {
    expect(userCopy('error.notFound')).toBe('We could not find that.');
    expect(userCopy('ledger.insufficient_funds')).toBe('Insufficient balance.');
    expect(userCopy('error.generic')).toBe('Something went wrong. Try again.');
    expect(userCopy('error.forbidden')).toBe('You do not have access to this.');
  });

  it('gives every refusal code a sentence and leaves an unknown key as the key', () => {
    const codes = [...Object.keys(TOKEN_REFUSAL_COPY), ...Object.keys(TOKEN_WIRE_COPY)] as Array<
      keyof typeof TOKEN_REFUSAL_COPY | keyof typeof TOKEN_WIRE_COPY
    >;
    for (const code of codes) {
      const sentence = userCopy(code);
      expect(sentence, code).not.toBe(code);
      expect(sentence, code).toMatch(/ /);
      expect(sentence, code).not.toMatch(/\d/);
      expect(sentence, code).not.toMatch(/136000|max supply|epoch reward|halving/i);
    }

    const missing = 'token.stake.this.key.does.not.exist';
    expect(userCopy(missing)).toBe(missing);
  });

  it('names the missing token_params column and does not echo an invented value', () => {
    expect(userCopy('token.params_invalid')).toBe('Those token settings are not valid.');
    expect(userCopy('token.params_unset')).toBe('Token settings are not set.');
    expect(userCopy('token.params_unset', { config: 'token_params.fee_discount_schedule' })).toBe(
      'Token settings are not set. Missing token_params.fee_discount_schedule.',
    );
    expect(userCopy('token.params_unset', { config: '1000000' })).toBe('Token settings are not set.');
    expect(userCopy('token.proposal_list_limit_unset')).not.toMatch(/50/);
    expect(userCopy('token.stakes_list_limit_unset')).not.toMatch(/50/);
  });
});
