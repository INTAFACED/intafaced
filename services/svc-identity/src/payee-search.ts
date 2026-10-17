/**
 * PAYEE SEARCH — exact email or phone, same no-enumeration shape as `resolveHandle`.
 *
 * Privacy decision for BANKPAY item 15 (the item names the rules): a person is
 * findable by email or by phone only after they opt in. The flags default off.
 * Malformed, unknown, frozen, closed and "did not consent" are one answer,
 * `{ found: false }`. The SQL is `=` on the stored value. Nothing here is a
 * pattern, and the phone and email are never returned or written to a log.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;

/** One exact email, or null when the string could not be an address. */
export function normalisePayeeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 320 || !EMAIL.test(email)) return null;
  return email;
}

/** One E.164 phone, or null. Spaces and dashes are not rewritten into a match. */
export function normalisePayeePhone(raw: string): string | null {
  const phone = raw.trim();
  return PHONE.test(phone) ? phone : null;
}
