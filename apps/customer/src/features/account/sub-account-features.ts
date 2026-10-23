// hand-declared-ok: the subAccounts.getFeatures, setFeatures and assets answers are declared in svc-identity, not in packages/contracts yet
import { z } from 'zod';

export const FEATURES = ['spot', 'convert', 'futures', 'algo', 'copy'] as const;
export type Feature = (typeof FEATURES)[number];

export const featuresView = z.object({
  kind: z.string(),
  frozen: z.boolean(),
  published: z.boolean(),
  features: z.array(z.object({ feature: z.enum(FEATURES), offered: z.boolean(), enabled: z.boolean() })),
});
export const featureResult = z.object({ feature: z.enum(FEATURES), enabled: z.boolean(), changed: z.boolean() });
export const assetsView = z.object({ balances: z.array(z.object({ assetId: z.string(), amount: z.string() })) });

/** Typed refusals the card words itself; any other code falls through to the shared failure view. */
export const FEATURE_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  'identity.sub_account_features_unset': 'refusedUnset',
  'identity.sub_account_feature_not_offered': 'refusedNotOffered',
  'identity.sub_account_feature_unavailable': 'refusedUnavailable',
  'identity.sub_account_frozen': 'refusedFrozen',
  'identity.sub_account_revoked': 'refusedRevoked',
  'identity.sub_account_not_found': 'refusedNotFound',
  'identity.sub_account_features_delegated': 'refusedDelegated',
  'identity.sub_account_check_unavailable': 'assetsUnavailable',
};
