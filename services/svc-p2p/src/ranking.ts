/**
 * P-ads-merchant-10. The board's ranking policy: owner data, never a default.
 *
 * `P2P_RANK_WEIGHTS` is a JSON object of factor to weight, each weight a positive decimal string. The one factor
 * weighed today is `completionRate30d`, the maker's 30-day completion rate (`completion-rate.ts`, the same definition
 * the profile shows). With one factor, setting it turns on the tiebreak at an equal price (the higher rate first); the
 * weight's size changes nothing until a second factor exists to weigh it against, and the policy read says so by naming
 * the order. The rate is read live, so a trade that finishes between two pages can move an ad across the page edge:
 * keyset paging never repeats a row within one stable board, but a rate that changes mid-paging can. Blank is "rule
 * off": the ranked board is the price order (price, then creation, then id), and the policy read says so. Anything
 * that is not a full, known table is `invalid` and also ranks by price alone, never by a guessed weight.
 */

export const RANK_FACTORS = ['completionRate30d'] as const;
export type RankFactor = (typeof RANK_FACTORS)[number];

export type RankingPolicy =
  | { status: 'off'; weights: null }
  | { status: 'invalid'; weights: null }
  | { status: 'active'; weights: Readonly<Record<RankFactor, string>> };

const WEIGHT = /^(?=.*[1-9])\d{1,6}(\.\d{1,6})?$/;

export function parseRankWeights(raw: string | null | undefined): RankingPolicy {
  if (raw == null || raw.trim() === '') return { status: 'off', weights: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', weights: null };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid', weights: null };
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== RANK_FACTORS.length) return { status: 'invalid', weights: null };
  const weights: Partial<Record<RankFactor, string>> = {};
  for (const [key, value] of entries) {
    if (!(RANK_FACTORS as readonly string[]).includes(key) || typeof value !== 'string' || !WEIGHT.test(value)) {
      return { status: 'invalid', weights: null };
    }
    weights[key as RankFactor] = value;
  }
  return { status: 'active', weights: weights as Record<RankFactor, string> };
}

/** The order the ranked board reads in, as the policy read names it. */
export function rankOrder(policy: RankingPolicy): string[] {
  return policy.status === 'active' ? ['price', 'completionRate30d', 'createdAt', 'id'] : ['price', 'createdAt', 'id'];
}
