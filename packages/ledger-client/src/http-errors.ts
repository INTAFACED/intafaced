import type { AmountString } from './money.js';
import { InsufficientFundsError, LedgerError } from './types.js';

/** Wire decimal as sent. Missing/empty is not a balance — never pad `'0'`. */
function wireAmount(value: unknown): AmountString | null {
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return null;
  return value as AmountString;
}

/**
 * Map svc-ledger HTTP error bodies back to typed ledger errors.
 *
 * Production service clients used to `throw new Error(text)`, which dropped
 * `instanceof InsufficientFundsError` and broke fail-closed void paths (P2P-01).
 * s2s-http now emits structured `code` + amount fields when possible.
 *
 * THAT FIX WAS ONE CODE WIDE.
 *
 * `s2s-http.httpError` deliberately puts `code` on the wire for five distinct
 * cases and gives four of them their own status: `ledger.insufficient_funds`
 * (400), `ledger.owner_identity_space` (400), `ledger.unauthenticated` (401),
 * `ledger.frozen` (412), and any other `LedgerError` (500). This function
 * rebuilt exactly one of them, so every other code arrived at the caller as a
 * bare `Error` — no `code`, and `instanceof LedgerError` false.
 *
 * Five services call through here: svc-pay, svc-token, svc-agents, svc-trade,
 * svc-bank. What it cost them, in their own code:
 *
 *     rejection_code = ${err instanceof LedgerError ? err.code : 'bank.post_failed'}
 *       — svc-bank card-service.ts:589 and :734, loans/loan-service.ts:1601
 *
 * A card cashback or a loan disbursement refused because THE LEDGER WAS FROZEN
 * was written to the database, permanently, as `bank.post_failed`. The operator
 * reading rejection codes could not tell a deliberate platform halt from a post
 * that failed for an unknown reason — which is the same class of loss as a freeze
 * overwriting the previous freeze's reason (#1055): the reason a money movement
 * was refused, recorded wrongly. `svc-bank/router.ts:198` degrades the same way,
 * turning a 412 into a generic 500 for the end user.
 *
 * So: any structured `code` now rebuilds a `LedgerError` carrying it.
 *
 * `LedgerError` and not the specific subclass, on purpose. `InsufficientFundsError`
 * is rebuilt only when the code is `ledger.insufficient_funds`, or when no
 * structured code was sent and the text matches the funds sentence, and both
 * `requested` and `availableBalance` are actually on the wire (fields or the
 * message regex). A different structured code is kept as that code: the funds
 * sentence in the body must not drop what svc-ledger sent. Missing amounts are
 * not `'0'`: empty is not failed is not zero. `UnbalancedTransactionError`
 * carries `perAsset`, which is NOT on the wire, and `OwnerIdentitySpaceError`
 * carries the owner type and id, which are not either. Constructing those
 * with invented or empty fields would hand a caller a typed error whose data
 * is fabricated — worse
 * than an honest base class, because it looks trustworthy. Callers branch on
 * `instanceof LedgerError` and on `.code`, and both of those are now true and
 * correct.
 */
export function rehydrateLedgerHttpError(path: string, status: number, detail: string): Error {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(detail) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const code = typeof parsed?.code === 'string' ? parsed.code : null;
  const message = typeof parsed?.message === 'string' ? parsed.message : detail;
  const blob = `${code ?? ''} ${message} ${detail}`;

  // `blob` includes the structured code. The funds regex applies only when
  // that code is absent; otherwise a 400 that merely reads
  // "Insufficient <asset>: requested …, available …" would be rebuilt as
  // InsufficientFundsError and the code svc-ledger sent would be dropped.
  const fundsText = /insufficient_funds|Insufficient \w+:/;
  const unnamedFunds = code === null && fundsText.test(blob);
  if (status === 400 && (code === 'ledger.insufficient_funds' || unnamedFunds)) {
    const fromMsg = message.match(/Insufficient (\S+): requested (\S+), available (\S+)/);
    const requested = wireAmount(fromMsg?.[2]) ?? wireAmount(parsed?.requested);
    const availableBalance = wireAmount(fromMsg?.[3]) ?? wireAmount(parsed?.availableBalance);
    if (requested !== null && availableBalance !== null) {
      const assetId = typeof parsed?.assetId === 'string' ? parsed.assetId : 'UNKNOWN';
      const accountId = typeof parsed?.accountId === 'string' ? parsed.accountId : 'unknown';
      return new InsufficientFundsError(accountId, fromMsg?.[1] ?? assetId, requested, availableBalance);
    }
  }

  // Any other code svc-ledger names, kept as a code. The message is the
  // service's own; the path and status go in only when there is nothing better,
  // because a caller that logs `err.message` should see what the ledger said,
  // not our envelope around it.
  if (code) return new LedgerError(message, code);

  // No structured body at all — a proxy error page, a truncated response, a
  // handler that threw before `httpError` ran. There is no code to carry, and
  // inventing one would be worse than saying so.
  return new Error(`svc-ledger ${path} failed (${status}): ${detail}`);
}
