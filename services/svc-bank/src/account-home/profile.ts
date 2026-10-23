/**
 * The profile a bank call is made for (BK-acct-01, J-bank-01 #7): Personal, or one business the caller belongs to.
 *
 * The customer app keeps the chosen profile as a view preference and sends it on every account read and write it makes
 * (`profile: 'personal' | 'business:<account id>'`). Nothing here trusts it: the caller is the edge-signed principal, and a
 * business profile is checked against that caller's own membership on every call. A business that does not exist, is
 * closed or does not have the caller as a member is one answer, `bank.profile_not_held`, before anything is read or
 * written, so a refused switch changes nothing and does not say which of the three it was.
 *
 * A business has no account of its own in this build (there is no company principal and no company ledger account), so a
 * held business profile reads its own name and the caller's role, and its terms, currencies and details refuse
 * `bank.company_account_unwired`. Personal money is never shown as company money.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BankError } from '../errors.js';

export const PERSONAL_PROFILE = 'personal';
const BUSINESS_PROFILE = /^business:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Optional on the wire, so a caller that sends none is Personal, as every call was before profiles. */
export const profileField = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => value === PERSONAL_PROFILE || BUSINESS_PROFILE.test(value), 'Expected "personal" or "business:<account id>"')
  .optional();

export type HeldProfile =
  | { readonly kind: 'personal'; readonly profile: typeof PERSONAL_PROFILE }
  | {
      readonly kind: 'business';
      readonly profile: string;
      readonly accountId: string;
      readonly name: string;
      readonly role: string;
    };

export const profileOutput = z.object({
  profile: z.string(),
  kind: z.enum(['personal', 'business']),
  business: z.object({ accountId: z.string(), name: z.string(), role: z.string() }).nullable(),
});

export function profileView(held: HeldProfile): z.infer<typeof profileOutput> {
  return held.kind === 'personal'
    ? { profile: held.profile, kind: 'personal', business: null }
    : { profile: held.profile, kind: 'business', business: { accountId: held.accountId, name: held.name, role: held.role } };
}

const notHeld = () => new BankError('This profile is not one you hold', 'bank.profile_not_held');

export class ProfileService {
  constructor(private readonly sql: Sql) {}

  /** The profile, proved held by this caller, or `bank.profile_not_held`. Reads only; writes nothing either way. */
  async resolve(userId: string, profile: string | undefined): Promise<HeldProfile> {
    if (profile === undefined || profile === PERSONAL_PROFILE) return { kind: 'personal', profile: PERSONAL_PROFILE };
    const accountId = BUSINESS_PROFILE.exec(profile)?.[1];
    if (!accountId) throw notHeld();
    const rows = await this.sql<Array<{ name: string; role: string }>>`
      SELECT a.name, m.role::text AS role
        FROM bank.business_accounts a
        JOIN bank.business_members m ON m.account_id = a.id AND m.user_id = ${userId}
       WHERE a.id = ${accountId}::uuid AND a.status = 'active'
    `;
    const row = rows[0];
    if (!row) throw notHeld();
    return { kind: 'business', profile, accountId, name: row.name, role: row.role };
  }

  /** For the account reads and writes that only a personal account has: a held business refuses, an unheld one too. */
  async personalOnly(userId: string, profile: string | undefined): Promise<void> {
    const held = await this.resolve(userId, profile);
    if (held.kind === 'business') {
      throw new BankError(
        'A business profile has no company account of its own in this build, so personal money is not shown as company money',
        'bank.company_account_unwired',
      );
    }
  }
}
