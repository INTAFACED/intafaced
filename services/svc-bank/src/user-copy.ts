/**
 * User-visible copy for svc-bank.
 *
 * Ramp / card refusals the caller reads on the wire go through `@intafaced/i18n`.
 * Catalog keys already on tip render as catalog copy. A key that is not in the
 * catalog — including every `bank.*` refusal code until a catalog PR adds it —
 * renders as the dotted key name. Never invented English (§9).
 *
 * Mode is `prod` on purpose: a missing key must not throw on a money-adjacent
 * door, and must not become a blank button. Same contract as svc-notify inbox
 * copy (`renderInboxCopy`).
 */
import { createTranslator, isMessageKey } from '@intafaced/i18n';
import type { BankErrorCode } from './errors.js';

const translator = createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined });

/** BankError codes whose TRPC `message` is resolved for a user, not an operator log. */
const USER_VISIBLE_CODES = new Set<BankErrorCode>([
  'bank.no_card_issuer',
  'bank.card_sim_not_live',
  'bank.cashback_pot_unfunded',
  'bank.rewards_issuer_unset',
  'bank.card_not_found',
  'bank.card_not_active',
  'bank.card_limit_exceeded',
  'bank.card_authorization_not_found',
  'bank.card_authorization_declined',
  'bank.card_authorization_closed',
  'bank.card_capture_exceeds_authorization',
  'bank.card_settlement_amount_conflict',
  'bank.card_settlement_kind_conflict',
  'bank.cards_disabled',
  'bank.no_ramp_rail',
  'bank.live_ramp_unset',
  'bank.no_paycheck_rail',
  'bank.fiat_ramp_socket',
  'bank.fiat_ramp_no_pay_adapter',
  'bank.no_fiat_rail',
  'bank.onramp_rate_unset',
  'bank.onramp_quote_missing',
  'bank.onramp_quote_expired',
  'bank.onramp_instruction_missing',
  'bank.offramp_fee_unset',
  'bank.offramp_fee_inconsistent',
  'bank.deposit_custody_unset',
  'bank.deposit_catalogue_invalid',
  'bank.deposit_asset_unpublished',
  'bank.deposit_pending_unbounded',
  'bank.ramp_invalid_amount',
  'bank.ramp_invalid_asset',
  'bank.ramp_invalid_destination',
  'bank.ramp_conflict',
]);

export function userCopy(key: string, params: Readonly<Record<string, string | number | bigint>> = {}): string {
  if (!isMessageKey(key)) return key;
  return translator.tUnsafe(key, params);
}

export function isUserVisibleBankCopyCode(code: BankErrorCode): boolean {
  return USER_VISIBLE_CODES.has(code);
}

/** Wire sentence for a BankError the caller is allowed to read. */
export function userFacingBankMessage(code: BankErrorCode, operatorMessage: string): string {
  return isUserVisibleBankCopyCode(code) ? userCopy(code) : operatorMessage;
}
