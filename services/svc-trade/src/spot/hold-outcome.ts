import { LedgerError } from '@intafaced/ledger-client';
import { TradeError } from './types.js';

/**
 * Refusals the ledger makes BEFORE committing anything, by a typed code (the same list svc-bank keeps in
 * `ledger-outcome.ts`).
 *
 * Both ledger engines check idempotency before validating the body, so a post whose key already committed returns the
 * original transaction instead of refusing. A typed refusal therefore proves nothing committed under that key: the
 * pending order row may be removed.
 *
 * Not listed, on purpose: `ledger.idempotency_conflict` (proves the key already committed something) and
 * `ledger.frozen` (svc-bank does not treat a platform halt as a proof either; the row stays and reconcile or a retry
 * settles it once the halt lifts). Every other failure (a timeout, the call's deadline, a network error, a 5xx, a
 * malformed acknowledgement, an untyped body) can follow a remote commit.
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

/** The hold post of an order ended without a verdict. The order row stays; a same-key retry re-drives the hold. */
export function ledgerOutcomeUnknown(orderId: string, cause: unknown): TradeError {
  const error = new TradeError(
    `order ${orderId}: the ledger did not confirm the hold, so it may or may not be booked; retry with the same clientOrderId`,
    'trade.ledger_outcome_unknown',
  );
  (error as { cause?: unknown }).cause = cause;
  return error;
}
