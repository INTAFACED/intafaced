/**
 * Published staking terms.
 *
 * Lock tiers come from `STAKE_TIERS`, the same table `stake` writes into
 * `multiplier_bps` and `unlocks_at`. Nothing here is copied.
 *
 * `TOKEN_ASSET_ID` in env.ts defaults to IFC. A default is not a publication:
 * `published` is true only when the variable is set to a non-blank value.
 */
import { STAKE_TIERS, type StakeTier } from './economics/staking.js';

export const STAKING_ASSET_UNPUBLISHED = 'staking_asset_unpublished' as const;
export const STAKE_MINIMUM_UNPUBLISHED = 'stake_minimum_unpublished' as const;

export interface PublishedStakeTier {
  readonly name: StakeTier;
  /** Display name on the tier constant (`label`). */
  readonly label: string;
  readonly lockDays: number;
  /** Basis points stored on the stake row. 10000 = 1x. Not a float. */
  readonly multiplierBps: number;
  /**
   * The stake path has no per-tier minimum constant. Null, never an invented 0.
   */
  readonly minimumStake: null;
  readonly minimumStakeReason: typeof STAKE_MINIMUM_UNPUBLISHED;
}

export type StakingAssetPublication =
  | { readonly assetId: string; readonly published: true }
  | { readonly assetId: null; readonly published: false; readonly reason: typeof STAKING_ASSET_UNPUBLISHED };

const TIER_ORDER: readonly StakeTier[] = ['flex', 'm3', 'm12'];

/** One row per lock tier, in the order the stake path names them. */
export function publishedStakeTiers(): PublishedStakeTier[] {
  return TIER_ORDER.map((name) => {
    const spec = STAKE_TIERS[name];
    return {
      name,
      label: spec.label,
      lockDays: spec.lockDays,
      multiplierBps: spec.multiplierBps,
      minimumStake: null,
      minimumStakeReason: STAKE_MINIMUM_UNPUBLISHED,
    };
  });
}

/**
 * Explicit `TOKEN_ASSET_ID` only. Missing, blank, or whitespace is unpublished.
 * Does not read the zod default in `env.ts`.
 */
export function stakingAssetPublication(source: NodeJS.ProcessEnv = process.env): StakingAssetPublication {
  const raw = source.TOKEN_ASSET_ID;
  if (typeof raw !== 'string') {
    return { assetId: null, published: false, reason: STAKING_ASSET_UNPUBLISHED };
  }
  const assetId = raw.trim();
  if (assetId.length === 0) {
    return { assetId: null, published: false, reason: STAKING_ASSET_UNPUBLISHED };
  }
  return { assetId, published: true };
}
