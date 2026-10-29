/**
 * Plain words for the typed refusals these rooms meet (UI-SPEC 4.3). The customer reads a title and one sentence that
 * names the real reason; the service code sits underneath as small support text. No promises of later availability, no service names.
 * Codes this file does not know fall through to the shared `refusalCopy`, so a new code never shows raw JSON.
 */
import { classifyRefusal } from '../../../data';
import { refusalCopy, refusalSupportCode } from './ui';

export interface Words {
  title: string;
  body: string;
  code?: string;
}

const KNOWN: Readonly<Record<string, { title: string; body: string }>> = {
  'trade.otc_desk_law_blank': {
    title: 'The quote desk is not open',
    body: 'The desk spread, stake rule and counterparty are not published, so no firm price can be given.',
  },
  'trade.otc_stake_gate': {
    title: 'A stake is needed for the quote desk',
    body: 'This desk is open to accounts that hold the required stake.',
  },
  'trade.otc_stake_unavailable': {
    title: 'Stake could not be checked',
    body: 'The desk could not read your stake, so it did not quote. Nothing was held.',
  },
  'trade.otc_quote_expired': { title: 'That quote has expired', body: 'Ask for a new price. An expired quote holds nothing.' },
  'trade.otc_quote_missing': { title: "We couldn't find that quote", body: 'Check the quote id. You can only open your own quotes.' },
  'trade.otc_not_owner': { title: "We couldn't find that quote", body: 'Check the quote id. You can only open your own quotes.' },
  'trade.otc_last_look_forbidden': {
    title: 'The price must match the quote',
    body: 'The desk fills at the quoted price only. Nothing was accepted.',
  },
  'trade.otc_no_reference_price': {
    title: 'No reference price right now',
    body: 'The desk has no fresh mid price for this pair, so it did not quote.',
  },
  'trade.rfq_missing_price': {
    title: 'No reference price right now',
    body: 'The desk has no fresh mid price for this pair, so it did not quote.',
  },
  'trade.otc_bad_spread': { title: 'The desk spread is not set', body: 'The desk cannot price this pair until its spread is published.' },
  'trade.otc_settle_refused': {
    title: 'Settlement was refused',
    body: 'The accepted quote did not settle. Your hold stays as reported; check the quote status.',
  },
  'trade.rfq_window_passed': {
    title: 'The settlement window has closed',
    body: 'This accepted quote can no longer settle. Nothing was settled or held; ask for a new price.',
  },
  'trade.otc_makers_unset': {
    title: 'No providers set',
    body: 'The desk has no provider list, so a request cannot be sent. Nothing was priced or held.',
  },
  'trade.otc_provider_required': { title: 'Pick a provider', body: 'Pick at least one provider to ask. Nothing was priced or held.' },
  'trade.otc_assets_unset': {
    title: 'No assets set',
    body: 'The desk has no asset list, so a request cannot be sent. Nothing was priced or held.',
  },
  'trade.otc_provider_unknown': {
    title: 'Provider not on the list',
    body: "A provider picked is not on the desk's provider list. Pick again from the list; nothing was priced or held.",
  },
  'trade.rfq_size_not_set': {
    title: 'The desk minimum is not set',
    body: 'The desk cannot price a request in this asset until its minimum size is published. Nothing was priced or held.',
  },
  'trade.rfq_already_bound': { title: 'That quote is already accepted', body: 'It can be settled, but not expired or accepted again.' },
  'trade.rfq_allocation_refused': {
    title: 'Allocation is not open',
    body: 'Splitting a quote across accounts waits for an owner-published rule that names the accounts.',
  },
  'trade.rfq_give_up_refused': {
    title: 'Give-up is not open',
    body: 'Passing a quote to a carrying account waits for an owner-published rule that names the account.',
  },
  'trade.algo_volume_immature': {
    title: 'Not enough trading history for this schedule',
    body: 'VWAP and participation schedules need recent volume for this market. Use a TWAP schedule instead.',
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
  'trade.algo_cancel_incomplete': {
    title: 'The last cancel did not finish',
    body: 'Some child orders are still open. Cancel again; the schedule cannot resume until it finishes.',
  },
  'trade.algo_not_found': { title: "We couldn't find that schedule", body: 'Check the schedule id. You can only open your own schedules.' },
  'trade.options_settlement_law_unset': {
    title: 'Live options are not open',
    body: 'The settlement asset rule is not published, so no live option can be traded.',
  },
  'trade.options_fixing_unconfigured': {
    title: 'No settlement price source',
    body: 'The fixing source for option expiry is not configured.',
  },
  'trade.options_terms_incomplete': {
    title: 'This contract is missing terms',
    body: 'A strike, expiry or style is missing, so it cannot be traded.',
  },
  'trade.unsettled_asset_class_listing': {
    title: 'Live options are not open',
    body: 'The settlement asset rule is not published, so only paper option markets can take orders.',
  },
  'trade.market_kind_unsupported': {
    title: 'Live options are not open',
    body: 'The live options engine is not enabled. Paper markets only.',
  },
  'trade.greeks_native_unlinked': {
    title: 'Greeks are not available here',
    body: 'The pricing library is not linked in this environment, so no Greeks are shown rather than guessed ones.',
  },
  'trade.batch_outcome_unknown': {
    title: 'This order may have been placed',
    body: 'The service could not confirm the outcome. Check status before placing it again.',
  },
  'trade.price_band': {
    title: 'Price is too far from the market',
    body: 'The price is outside the range this market accepts around the current price. Move it closer and try again.',
  },
  'trade.client_order_id_conflict': {
    title: 'That order id was used for a different order',
    body: 'Nothing new was placed. Start a new ladder.',
  },
  'trade.system_overload': {
    title: 'New orders are paused',
    body: 'The order door is overloaded, so a new position is refused. An order that only reduces a position can still be sent.',
  },
  'trade.cancel_not_close': {
    title: 'That does not close the position',
    body: 'Deleting a position does not close it or release its margin. Use close. Nothing was changed.',
  },
  'trade.scale_child_refused': {
    title: 'The ladder was not placed',
    body: 'One level was refused, so the levels already placed in this request were cancelled. No order from this ladder is still open.',
  },
  'trade.scale_rollback_incomplete': {
    title: 'The ladder cancel did not finish',
    body: 'One level was refused and a cancel of an earlier level failed. The message names the order ids that are still open.',
  },
};

/**
 * Refusals whose sentence from the desk names the owner's number (the desk minimum, CB-otc-07; the provider cap,
 * CB-otc-01), so the customer sees the limit they hit. The service sentence is kept and the next step follows it.
 */
const NAMES_ITS_LIMIT: Readonly<Record<string, { title: string; fallback: string; after: string }>> = {
  'trade.rfq_below_minimum': {
    title: 'Below the desk minimum',
    fallback: 'This request is below the desk minimum',
    after: 'Ask for a larger size; nothing was priced or held.',
  },
  'trade.otc_provider_cap': {
    title: 'Too many providers',
    fallback: 'More providers were picked than the desk allows',
    after: 'Pick fewer; nothing was priced or held.',
  },
  'trade.otc_asset_unlisted': {
    title: 'Asset not on the desk',
    fallback: "That asset is not on the desk's asset list",
    after: 'Pick a pair whose asset the desk lists; nothing was priced or held.',
  },
};

export interface RefusalInput {
  reason?: string;
  message?: string;
  code?: string;
}

export function roomWords(input: RefusalInput): Words {
  const code = input.code?.trim();
  // A write that may have gone through is never described as refused or unchanged, whatever code came with it. The code
  // stays only as a reference for support.
  if (input.reason === 'uncertain')
    return {
      title: "We couldn't confirm that",
      body: 'The connection dropped before an answer arrived. Check status before trying again.',
      ...(code ? { code: refusalSupportCode(code) } : {}),
    };
  if (code) {
    const known = KNOWN[code];
    if (known) return { ...known, code: refusalSupportCode(code) };
    const named = NAMES_ITS_LIMIT[code];
    if (named)
      return {
        title: named.title,
        body: `${input.message?.trim().replace(/\.$/, '') || named.fallback}. ${named.after}`,
        code: refusalSupportCode(code),
      };
    if (code.startsWith('trade.greeks_')) return { ...KNOWN['trade.greeks_native_unlinked']!, code: refusalSupportCode(code) };
    const shared = refusalCopy(code);
    // A trade.* code nobody here has words for keeps the service's own sentence, so the real blocker is never replaced by a generic line.
    // Other families (auth, scope, internal) keep the shared words, so no service wording leaks.
    const message = input.message?.trim();
    if (message && code.startsWith('trade.') && classifyRefusal(code) === 'unknown')
      return { title: shared.title, body: message, code: refusalSupportCode(code) };
    return { title: shared.title, body: shared.body, code: refusalSupportCode(code) };
  }
  if (input.reason === 'unauthorized') return { title: 'Sign in again', body: 'Your session ended. Sign in to carry on.' };
  if (input.reason === 'unreachable' || input.reason === 'uncertain')
    return {
      title: "We couldn't confirm that",
      body: 'The connection dropped before an answer arrived. Check status before trying again.',
    };
  return {
    title: "This can't be done right now",
    body: input.message?.trim() || 'Try again later. If it keeps happening, contact support.',
  };
}

/** True when the service said it does not offer this (so a retry cannot help). */
export function isRefusedClosed(code: string | undefined): boolean {
  return code !== undefined && code in KNOWN;
}
