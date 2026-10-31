/**
 * Field rules shared by the desk requests and the screens that build them. A leaf module (no imports), so the packet reader,
 * the staff requests and the staff pages use one copy of each rule.
 */

/** A desk reason: trimmed, 12 to 500 characters. */
export const REASON_MIN = 12;
export const REASON_MAX = 500;

export function validReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= REASON_MIN && value.length <= REASON_MAX;
}

/** An opaque id a service hands out (a staff or role id, a page cursor): printable ASCII, no spaces, 1 to 128 characters. */
const OPAQUE_ID = /^[\x21-\x7e]{1,128}$/;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}
