/**
 * Merchant-facing failure text.
 *
 * The code is one of a fixed catalog. The message is the sentence stored next
 * to that code here, not the rail's free-text reason and not an exception
 * stack. A code this catalog does not name collapses to `pay.failed`, so a
 * provider payload that landed in a failure field cannot ride out on the wire.
 */

const FAILURE_CATALOG: Readonly<Record<string, string>> = {
  'pay.failed': 'The payment could not be completed.',
  'pay.settlement_released': 'This settlement was released before it paid out.',
  'card.declined': 'The card was declined.',
  'acquirer.unavailable': 'The card network could not take the payment.',
  'authorize.invalid_amount': 'The amount could not be authorized.',
  'capture.not_authorized': 'The payment was not authorized to capture.',
  'rail.failed': 'The payment could not be completed.',
  'rail.not_sent': 'The payout was confirmed not sent.',
  'rail.unknown_reference': 'The payment reference was not recognized.',
  'chain.wrong_asset': 'The transfer used a different asset.',
  'chain.underpaid': 'The transfer was less than the amount due.',
  'chain.insufficient_confirmations': 'The transfer does not have enough confirmations yet.',
  'chain.broadcast_failed': 'The payout could not be sent.',
  'chain.unavailable': 'The network could not be reached.',
  'chain.not_configured': 'This payout network is not configured.',
  'refund.destination_missing': 'The refund has no destination.',
  'refund.destination_ambiguous': 'The payment came from more than one address, so the refund has no single destination.',
  'refund.invalid_amount': 'The refund amount is not valid.',
  'refund.exceeds_captured': 'The refund is larger than the captured amount.',
  'payout.invalid_amount': 'The payout amount is not valid.',
  'payout.no_destination': 'The payout has no destination.',
  'bank.not_configured': 'Bank payout is not configured.',
  'bank.rejected': 'The payout was rejected.',
  'rail.health_stale': 'The payment rail has not confirmed it is up. Nothing was sent.',
  'rail.probe_failed': 'The payment rail did not answer a health check. Nothing was sent.',
  'rail.marked_down': 'The payment rail is marked down. Nothing was sent.',
};

export interface MerchantFailure {
  readonly code: string;
  readonly message: string;
}

/** `null` when nothing failed. Otherwise a catalog pair, never the raw provider string. */
export function safeFailure(raw: string | null | undefined): MerchantFailure | null {
  if (raw == null || raw.trim() === '') return null;
  const message = FAILURE_CATALOG[raw];
  if (message) return { code: raw, message };
  return { code: 'pay.failed', message: FAILURE_CATALOG['pay.failed']! };
}
