/**
 * User-visible copy for `svc-ledger` posting / freeze / recipe refuse paths.
 *
 * Every string a client reads from a refuse or status path goes through
 * `@intafaced/i18n`. Mode is `prod` on purpose: a missing key must not throw
 * on a live freeze refuse, and must not invent English — `tUnsafe` renders
 * the dotted key name, which is greppable and not blank.
 *
 * Catalog keys that already exist on tip are aliased from ledger error codes.
 * Codes with no catalog row stay the code itself until a catalog PR adds copy.
 * Balances and amounts are never invented here (decimal strings stay on the
 * structured error fields, not in copy).
 */
import { createTranslator } from '@intafaced/i18n';

const translator = createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined });

/**
 * Ledger refuse codes that already have a catalog sentence. Unlisted codes
 * are passed through as keys — missing → dotted name, never invented copy.
 */
const CATALOG_ALIAS: Readonly<Record<string, string>> = {
  'ledger.insufficient_funds': 'error.insufficientFunds',
  'ledger.unauthenticated': 'error.unauthorized',
  'ledger.custody_layer_off': 'error.custodyLayerOff',
};

export function userCopy(key: string, params: Readonly<Record<string, string | number | bigint>> = {}): string {
  return translator.tUnsafe(CATALOG_ALIAS[key] ?? key, params);
}
