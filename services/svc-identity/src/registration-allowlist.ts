import { z } from 'zod';

/**
 * The invited-list gate's addresses (REGISTRATION_EMAIL_ALLOWLIST): comma-separated, matched case-insensitively.
 * Blank / unset → no list. A value that is not an address fails boot, so a typo never looks like a shut door.
 */
export function parseRegistrationAllowlist(raw: string): ReadonlySet<string> | undefined {
  const items = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  if (items.length === 0) return undefined;
  for (const item of items) {
    if (!z.string().email().safeParse(item).success)
      throw new Error(`REGISTRATION_EMAIL_ALLOWLIST holds a value that is not an email address`);
  }
  return new Set(items);
}
