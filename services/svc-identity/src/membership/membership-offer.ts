/**
 * W-balances-04. Membership subscription tier, decision-gated.
 *
 * Price, tiers and perks are owner values (IDENTITY_MEMBERSHIP_TIERS, a JSON list). Blank means
 * "Membership is not offered": the read says so and nothing can be bought. No price, tier name or
 * perk is ever defaulted here. Prices are decimal strings; this module never turns one into a number.
 */
import { z } from 'zod';

export const MEMBERSHIP_NOT_OFFERED = 'identity.membership_not_offered' as const;

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'price must be a decimal string');

const tierSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    name: z.string().min(1).max(64),
    price: decimal,
    assetId: z.string().min(1).max(16),
    /** Renewal period in whole days. */
    periodDays: z.number().int().min(1).max(366),
    perks: z.array(z.string().min(1).max(200)).max(50),
  })
  .strict();

export type MembershipTier = z.infer<typeof tierSchema>;

export type MembershipOffer =
  { offered: false; code: typeof MEMBERSHIP_NOT_OFFERED } | { offered: true; tiers: MembershipTier[]; current: null };

/** Owner JSON list. Blank lists nothing (not offered); malformed JSON or a bad row refuses to boot. */
export function parseMembershipTiers(raw: string | undefined): readonly MembershipTier[] {
  if (raw === undefined || raw.trim() === '') return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('IDENTITY_MEMBERSHIP_TIERS must be a JSON list of tiers');
  }
  const parsed = z.array(tierSchema).safeParse(json);
  if (!parsed.success) throw new Error(`IDENTITY_MEMBERSHIP_TIERS is invalid: ${parsed.error.issues[0]?.message ?? 'bad tier'}`);
  const ids = parsed.data.map((t) => t.id);
  if (new Set(ids).size !== ids.length) throw new Error('IDENTITY_MEMBERSHIP_TIERS has a repeated tier id');
  return parsed.data;
}

/**
 * The page read. `current` is null: no subscription store exists yet, so no one holds a tier and
 * none is invented. An empty owner list is "not offered", never a free default tier.
 */
export function membershipOffer(tiers: readonly MembershipTier[]): MembershipOffer {
  if (tiers.length === 0) return { offered: false, code: MEMBERSHIP_NOT_OFFERED };
  return { offered: true, tiers: [...tiers], current: null };
}
