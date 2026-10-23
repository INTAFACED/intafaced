import { ACCOUNT_TIER_TERM_KEYS, accountTierSchema, type AccountTier, type AccountTierTerms } from '@intafaced/contracts';

/**
 * The account product tiers on offer (J-ops-console-04 #11), from the owner setting `IDENTITY_ACCOUNT_TIERS`: a JSON list
 * of `{ id, name, terms: { ratePercent, monthlyFee, feeAssetId, dailyLimit, clearingDays } }`, each term a decimal string
 * or null. NO DEFAULT. Blank, not JSON, an invalid tier, a repeated id or more than 50 tiers all mean unset: the list
 * answers `identity.account_tiers_unset` and no account can be moved. A tier with a null term is listed, and moving an
 * account onto it refuses `identity.tier_terms_unset` naming the blank terms; nothing fills them in.
 */
export function parseAccountTiers(raw: string | undefined): readonly AccountTier[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50) return undefined;
  const tiers: AccountTier[] = [];
  for (const item of parsed) {
    const tier = accountTierSchema.safeParse(item);
    if (!tier.success || tiers.some((seen) => seen.id === tier.data.id)) return undefined;
    tiers.push(tier.data);
  }
  return tiers;
}

/** The terms of a tier the owner left blank, in their fixed order. Empty: the tier can be assigned. */
export function blankTierTerms(terms: AccountTierTerms): Array<(typeof ACCOUNT_TIER_TERM_KEYS)[number]> {
  return ACCOUNT_TIER_TERM_KEYS.filter((key) => terms[key] === null);
}
