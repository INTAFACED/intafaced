import { LedgerError } from '@intafaced/ledger-client';

/**
 * Typed write-block reasons this architecture can detect (OPS-ledger-desk-04, ops-console-ledger-desk-008).
 *
 * The posting freeze (`ledger.frozen`, with its reason such as `reconcile_unproven`) and the env switch already refuse
 * with their own codes. What was missing: a post that fails because the STORE cannot take a write surfaced as an
 * untyped 500. Two store conditions are now named so the panel and callers can tell them apart:
 *
 *   - `ledger.writes_blocked_store_disk_full`: Postgres SQLSTATE class 53 disk_full (53100).
 *   - `ledger.writes_blocked_store_unavailable`: connection failures (SQLSTATE class 08, admin shutdown 57P01-57P03,
 *     read-only standby 25006) and socket errors before Postgres answered.
 *
 * Only the classification is new. Nothing is retried, repaired or frozen here: the post failed, nothing was booked
 * (the engine's transaction did not commit), and the caller retries with the SAME business key.
 */

export const WRITES_BLOCKED_STORE_DISK_FULL = 'ledger.writes_blocked_store_disk_full' as const;
export const WRITES_BLOCKED_STORE_UNAVAILABLE = 'ledger.writes_blocked_store_unavailable' as const;
/** App clock and database clock differ by more than the owner-set bound. Not a SQLSTATE. */
export const WRITES_BLOCKED_CLOCK_SKEW = 'ledger.writes_blocked_clock_skew' as const;
export type WriteBlockCode =
  typeof WRITES_BLOCKED_STORE_DISK_FULL | typeof WRITES_BLOCKED_STORE_UNAVAILABLE | typeof WRITES_BLOCKED_CLOCK_SKEW;

const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '25006']);
const UNAVAILABLE_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

/** The write-block code for a store error, or null when the error is not a store condition (it is rethrown as is). */
export function classifyWriteBlock(err: unknown): WriteBlockCode | null {
  if (err instanceof LedgerError || err === null || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  if (code === '53100') return WRITES_BLOCKED_STORE_DISK_FULL;
  if (code.startsWith('08') && code.length === 5) return WRITES_BLOCKED_STORE_UNAVAILABLE;
  if (UNAVAILABLE_SQLSTATES.has(code) || UNAVAILABLE_SOCKET_CODES.has(code)) return WRITES_BLOCKED_STORE_UNAVAILABLE;
  return null;
}

/** Wrap a store error as a typed `LedgerError`; anything else is returned unchanged. */
export function toWriteBlockError(err: unknown): unknown {
  const code = classifyWriteBlock(err);
  if (!code) return err;
  const detail = err instanceof Error ? err.message : String(err);
  const wrapped = new LedgerError(`ledger writes are blocked: ${code} (${detail})`, code);
  (wrapped as { cause?: unknown }).cause = err;
  return wrapped;
}

export function isWriteBlockCode(code: string): code is WriteBlockCode {
  return code === WRITES_BLOCKED_STORE_DISK_FULL || code === WRITES_BLOCKED_STORE_UNAVAILABLE || code === WRITES_BLOCKED_CLOCK_SKEW;
}
