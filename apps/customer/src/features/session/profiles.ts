/**
 * Which profile the person is looking at: Personal, or one of the businesses they belong to (HM-navigation-01).
 *
 * This is a view choice. No service reads it and the server authorises every call from the signed principal, so nothing here
 * grants anything. The stored choice (`activeProfile`, saved on the account with the rest of the view record) is checked
 * against the person's real business accounts every time they are read: a business that is gone, never existed or could not
 * be read shows Personal, never an error and never a business the person does not belong to.
 */
import { UI_ACTIVE_PROFILE_PATTERN } from '@intafaced/contracts/ui-view-preferences';
import type { z } from 'zod';
import type { bankReads } from '../money/contracts';

export const PERSONAL_PROFILE = 'personal';
export const businessProfileId = (accountId: string): string => `business:${accountId}`;

export interface BusinessProfile {
  /** The profile id, `business:<account id>`. */
  id: string;
  accountId: string;
  name: string;
}

type BusinessRows = z.infer<(typeof bankReads)['business.list']>;

/** The businesses that can be picked: open accounts whose id fits the stored form, once each, in the order the bank gave. */
export function businessProfiles(rows: BusinessRows): BusinessProfile[] {
  const seen = new Set<string>();
  const out: BusinessProfile[] = [];
  for (const row of rows) {
    const id = businessProfileId(row.id);
    if (row.status !== 'active' || !UI_ACTIVE_PROFILE_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, accountId: row.id, name: row.name });
  }
  return out;
}

export type ProfileNotice = 'gone';

/**
 * The profile to show. `businesses` is null while the list is loading or could not be read: Personal is shown, with no
 * notice, because the stored choice has not been proved wrong. A stored business that is not in a read list shows Personal
 * with a notice.
 */
export function resolveProfile(
  stored: string,
  businesses: readonly BusinessProfile[] | null,
): { active: string; business: BusinessProfile | null; notice: ProfileNotice | null } {
  if (stored === PERSONAL_PROFILE || businesses === null) return { active: PERSONAL_PROFILE, business: null, notice: null };
  const match = businesses.find((row) => row.id === stored);
  return match
    ? { active: match.id, business: match, notice: null }
    : { active: PERSONAL_PROFILE, business: null, notice: stored.startsWith('business:') ? 'gone' : null };
}
