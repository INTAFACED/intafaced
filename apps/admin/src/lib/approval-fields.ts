/**
 * The field shapes an approval request shares between the desk, which reads every request, and the features and screens
 * that build one in the browser. Pure: no server-only import, so both sides check a field the same way.
 */

/** A founder's written reason, in characters. */
export const REASON_MIN = 12;
export const REASON_MAX = 500;
/** The platform's ids: a user, a freeze, a control and the like. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A case reference as svc-ops stores it with an operator reversal: printable, no space at either end, up to 128. */
export const CASE_REF = /^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/;
/** svc-pay's network id and deposit address shapes (`custody/deposits/freezes.ts`). */
export const NETWORK_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const DEPOSIT_ADDRESS = /^\S{1,256}$/;
/** svc-ledger's account metadata key rule (`account_metadata_key_ck`, 0029). */
export const METADATA_KEY = /^[a-z][a-z0-9_.:-]{0,63}$/;
