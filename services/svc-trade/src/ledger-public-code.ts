import { InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';

/**
 * The one place a ledger refusal becomes the code svc-trade publishes (DV-errors-02).
 *
 * svc-ledger's platform-wide posting freeze answers `ledger.frozen` wherever it stops a post. What that means for the
 * caller depends on WHERE the post was:
 *   - the order's first hold, before the engine saw the order: the order is gone and nothing is held. Published as
 *     `posting_frozen`, a refusal (never svc-identity's `account_frozen`, which is one account).
 *   - anywhere after the engine accepted, filled or cancelled the order (a fill, a release, a close's hold): the order
 *     exists and its settlement is not confirmed. Published as `trade.settlement_pending`, an unknown outcome the
 *     caller resolves by reading the order, never a refusal.
 * Only a site that has proven the first case marks the error (`refusedBeforeEngine`); an unmarked freeze is the second
 * case, so a freeze nobody classified can never read as "nothing happened". Every surface that publishes a ledger code
 * (the CCXT error body, a replace outcome's `reasonCode`, the tRPC error cause) maps it here; internal decisions (hold
 * classification, fee fallback) keep reading the ledger's own code.
 */
export const POSTING_FROZEN = 'posting_frozen';
export const SETTLEMENT_PENDING = 'trade.settlement_pending';

const LEDGER_FROZEN = 'ledger.frozen';

/**
 * The ledger's `ledger.frozen`, proven to have refused the order's first hold before the order reached the engine.
 * Still a `LedgerError` with the ledger's own code, so every internal check reads it as before; the ledger's error is
 * kept as `cause`.
 */
export class FrozenBeforeEngineError extends LedgerError {
  constructor(readonly original: LedgerError) {
    super(original.message, original.code);
    this.name = 'LedgerError';
    this.cause = original;
  }
}

/**
 * Called only where the order's first hold was refused before commit and before any engine call (the pending row is
 * deleted): a posting-freeze refusal is marked as such. Any other error comes back unchanged.
 */
export function refusedBeforeEngine(err: unknown): unknown {
  if (!(err instanceof LedgerError) || err instanceof InsufficientFundsError || err instanceof FrozenBeforeEngineError) return err;
  return err.code === LEDGER_FROZEN ? new FrozenBeforeEngineError(err) : err;
}

/** The published code for a ledger error; every code but the posting freeze passes through unchanged. */
export function publicLedgerCode(err: LedgerError): string {
  if (err.code !== LEDGER_FROZEN) return err.code;
  return err instanceof FrozenBeforeEngineError ? POSTING_FROZEN : SETTLEMENT_PENDING;
}
