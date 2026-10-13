import { LedgerError } from '@intafaced/ledger-client';

/**
 * Refusals the ledger makes BEFORE committing anything, by a typed code.
 *
 * Both ledger engines check idempotency before validating the body, so a post
 * whose key already committed returns the original transaction instead of
 * refusing. A typed refusal therefore proves nothing committed under that key:
 * the claim may be released.
 *
 * `ledger.idempotency_conflict` (the same key with a DIFFERENT body, in `refuse` mode) is
 * deliberately NOT listed: it proves the key already committed something, so the claim must
 * stay pending as an unknown outcome, never be released. Every other failure (a transport error, a 5xx, an
 * untyped body, a code not listed here) can follow a remote commit, and the
 * claim must stay pending with its original terms.
 */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  'ledger.insufficient_funds',
  'ledger.invalid_entry',
  'ledger.unbalanced',
  'ledger.owner_identity_space',
]);

export function isDefiniteLedgerRefusal(err: unknown): boolean {
  return err instanceof LedgerError && DEFINITE_REFUSALS.has(err.code);
}
