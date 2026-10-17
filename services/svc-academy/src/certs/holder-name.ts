/**
 * Holder name stored on a grant only after the holder consents.
 *
 * This module does not read a display name from identity. Control characters
 * are rejected. The length cap is a storage bound so a write cannot be
 * unbounded; the owner has not published a display-length rule.
 */

import { AcademyError } from '../errors.js';

export const HOLDER_NAME_MAX_LENGTH = 200;

const CONTROL = /[\u0000-\u001F\u007F\u0080-\u009F]/;

/** Null clears the name. A string is trimmed. Empty or control characters refuse. */
export function normaliseHolderName(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > HOLDER_NAME_MAX_LENGTH || CONTROL.test(trimmed)) {
    throw new AcademyError('holder name is empty, too long, or contains a control character', 'academy.holder_name_invalid');
  }
  return trimmed;
}
