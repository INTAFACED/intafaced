import { z } from 'zod';
import { rankPerksSchema, rankStateSchema } from '@intafaced/contracts/identity';
import { contractProcedure } from '../../shared/contract-call';

const xpCount = z.string().regex(/^(0|[1-9]\d*)$/);
// The mounted producer emits Date.toISOString(), not an arbitrary display date.
const rankDate = rankStateSchema.shape.updatedAt.refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const rank = rankStateSchema.extend({
  rank: rankStateSchema.shape.rank.safe(),
  xp: xpCount,
  seasonXp: xpCount,
  nextRankAt: xpCount.nullable(),
  updatedAt: rankDate,
});
export function rankForOwner(owner: string) {
  return rank.refine((value) => value.userId === owner, 'Rank belongs to another account');
}
export const accountPerks = rankPerksSchema.extend({
  p2pLimitMultiplier: rankPerksSchema.shape.p2pLimitMultiplier.finite(),
  copyFollowerCap: rankPerksSchema.shape.copyFollowerCap.safe(),
  launchpadTier: rankPerksSchema.shape.launchpadTier.safe(),
});
/** `identity.rank.get` and `identity.rank.perks`: self-only reads whose output schemas are the service's own, narrowed above. */
export const rankGetFor = (owner: string) => contractProcedure('identity', 'rank.get', { output: rankForOwner(owner) });
export const rankPerksGet = contractProcedure('identity', 'rank.perks', { output: accountPerks });
export type AccountRank = z.infer<typeof rank>;
export type AccountPerks = z.infer<typeof accountPerks>;

export function formatXp(value: string, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(value));
}
