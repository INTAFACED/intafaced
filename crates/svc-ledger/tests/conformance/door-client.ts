/**
 * What a caller sees of a door's answer, the same for both doors: a refusal as the HTTP client rebuilds it
 * (`rehydrateLedgerHttpError`), `ledger.invalid_entry` as the class it names, stamped with the one attempt made.
 */
import {
  InvalidEntryError,
  LedgerError,
  rehydrateLedgerHttpError,
  stampPostAttempts,
} from '../../../../packages/ledger-client/dist/index.js';
import { httpError } from '../../../../services/svc-ledger/src/s2s-http.ts';

/** Who a direct engine call claims to be under the shared secret: a name on no allowlist, never mistaken for a grant. */
export const DIRECT = 'svc-conformance';

/** A refusal as the caller's client hands it on. */
export function asClientError(err: unknown): Error {
  const code = err instanceof LedgerError ? err.code : null;
  if (code === 'ledger.invalid_entry') return new InvalidEntryError(err instanceof Error ? err.message : String(err));
  return err instanceof Error ? err : new Error(String(err));
}

/** What the TypeScript door threw, as it reaches a caller over HTTP after one attempt. */
export function overTheWire(err: unknown): Error {
  const { status, body } = httpError(err);
  const refused = asClientError(rehydrateLedgerHttpError('/trpc/post', status, JSON.stringify(body)));
  stampPostAttempts(refused, 1);
  return refused;
}

/** The engine options only the TypeScript engine takes; the Rust door reads its clock and bound from its env. */
export function refuseUnoffered(options: { clockSkewBoundMs?: unknown; now?: unknown; readDatabaseNow?: unknown }): void {
  if (options.clockSkewBoundMs != null || options.now || options.readDatabaseNow) {
    throw new Error('a clock or skew bound is not offered through the door: both doors read it from their own settings');
  }
}
