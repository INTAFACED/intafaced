/**
 * The one place a ledger refusal code becomes the code svc-trade publishes (DV-errors-02).
 *
 * svc-ledger's platform-wide posting freeze answers `ledger.frozen`. The trade API names it `posting_frozen`, so a
 * client never mistakes it for svc-identity's freeze of one account (`account_frozen`). Every surface that puts a
 * ledger code in a reply (the CCXT error body, a replace or amend outcome's `reasonCode`, the tRPC error cause) maps
 * it here; internal decisions (hold classification, fee fallback) keep reading the ledger's own code.
 */
export const POSTING_FROZEN = 'posting_frozen';

const PUBLIC_LEDGER_CODES: Readonly<Record<string, string>> = { 'ledger.frozen': POSTING_FROZEN };

/** The published code for a ledger code; any code that is not a renamed ledger code passes through unchanged. */
export function publicLedgerCode(code: string): string;
export function publicLedgerCode(code: string | null): string | null;
export function publicLedgerCode(code: string | null): string | null {
  if (code === null) return null;
  return PUBLIC_LEDGER_CODES[code] ?? code;
}
