import { KYC_TIERS, checkAccess, tierSatisfies, type KycTier, type ModuleId } from '@intafaced/config';
import {
  KYC_LADDER_FEATURES,
  kycRequirementKeySchema,
  type KycLadderFeature,
  type KycLadderFeatureState,
  type KycLevelRequirements,
  type KycLevelsDescribeOutput,
  type KycRequirementKey,
} from '@intafaced/contracts';

/**
 * I-kyc-compliance-04/05: the verification ladder (`kyc.levels.describe`).
 *
 * WHERE EACH FEATURE'S RULE COMES FROM. A feature is the module whose guard serves it, read with the same `checkAccess`
 * the guard calls, for the region the edge stamped on this request. A guard that changes its module changes the row
 * here in the same PR, or this page promises what the service refuses:
 *   - deposit: svc-bank `deposits.address` (`module: 'bank'`)
 *   - withdraw: svc-pay `withdrawal.create` (`module: 'ledger'`, the module that holds the balance)
 *   - trade: svc-trade's custodial place (`module: 'trade'`, after its own `basic` floor, `tier.insufficient`)
 *   - card: svc-bank `cards.issue` (`module: 'bank'`)
 *   - earn: svc-bank `earn.deposit` (`module: 'bank'`)
 *   - rewards: svc-campaigns `claim` (`module: 'campaigns'`); each reward also names its own level (`perOffer`)
 */
export const KYC_FEATURE_GUARDS: Readonly<Record<KycLadderFeature, { module: ModuleId; floor?: KycTier; perOffer?: true }>> = {
  deposit: { module: 'bank' },
  withdraw: { module: 'ledger' },
  trade: { module: 'trade', floor: 'basic' },
  card: { module: 'bank' },
  earn: { module: 'bank' },
  rewards: { module: 'campaigns', perOffer: true },
};

/** The owner's published settings this read shows. Parsed once at start; blank is unpublished, never a default. */
export interface KycLadderSettings {
  readonly requirements: ReadonlyMap<KycTier, readonly KycRequirementKey[]>;
  readonly reviewHours: ReadonlyMap<KycTier, number>;
}

export const EMPTY_KYC_LADDER_SETTINGS: KycLadderSettings = { requirements: new Map(), reviewHours: new Map() };

const MAX_REVIEW_HOURS = 8760;

function tierOf(raw: string, setting: string): KycTier {
  const tier = raw.trim();
  if (!(KYC_TIERS as readonly string[]).includes(tier)) throw new Error(`${setting}: "${tier}" is not a verification level`);
  return tier as KycTier;
}

/**
 * `IDENTITY_KYC_REQUIREMENTS_BY_LEVEL`: a JSON object, level -> list of requirement keys, for example
 * `{"basic":["legal_name","date_of_birth","id_document"]}`. A level left out is unpublished. An empty list is refused:
 * "needs nothing" and "not published" must not look the same, so the owner leaves the level out instead. Unknown keys,
 * repeats and malformed JSON stop the service.
 */
export function parseKycRequirementsByLevel(raw: string | undefined): ReadonlyMap<KycTier, readonly KycRequirementKey[]> {
  const setting = 'IDENTITY_KYC_REQUIREMENTS_BY_LEVEL';
  const out = new Map<KycTier, readonly KycRequirementKey[]>();
  if (raw === undefined || raw.trim() === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${setting} must be a JSON object of level -> requirement keys`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${setting} must be a JSON object`);
  // JSON.parse keeps the last of two equal keys without a word. A level named twice is a mistake to stop on, not to
  // resolve: level names never appear as requirement keys, so counting them as object keys in the raw text is exact.
  for (const tier of KYC_TIERS)
    if ((raw.match(new RegExp(`"${tier}"\\s*:`, 'g')) ?? []).length > 1) throw new Error(`${setting}: ${tier} is set twice`);
  for (const [level, keys] of Object.entries(parsed)) {
    const tier = tierOf(level, setting);
    if (!Array.isArray(keys) || keys.length === 0) throw new Error(`${setting}: ${tier} must list at least one requirement`);
    const list: KycRequirementKey[] = [];
    for (const key of keys) {
      const ok = kycRequirementKeySchema.safeParse(key);
      if (!ok.success) throw new Error(`${setting}: ${tier} names an unknown requirement ${JSON.stringify(key)}`);
      if (list.includes(ok.data)) throw new Error(`${setting}: ${tier} names ${ok.data} twice`);
      list.push(ok.data);
    }
    out.set(tier, list);
  }
  return out;
}

/**
 * `IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL`: `level=hours` pairs, comma separated, for example `basic=24,full=72`. Whole hours,
 * 1 to 8760. A level left out has no stated review time. Malformed values stop the service.
 */
export function parseKycReviewHoursByLevel(raw: string | undefined): ReadonlyMap<KycTier, number> {
  const setting = 'IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL';
  const out = new Map<KycTier, number>();
  if (raw === undefined || raw.trim() === '') return out;
  for (const part of raw.split(',')) {
    const [level, hours, extra] = part.split('=');
    if (level === undefined || hours === undefined || extra !== undefined) throw new Error(`${setting}: "${part}" is not level=hours`);
    const tier = tierOf(level, setting);
    if (out.has(tier)) throw new Error(`${setting}: ${tier} is set twice`);
    if (!/^\d+$/.test(hours.trim())) throw new Error(`${setting}: ${tier} must be whole hours`);
    const n = Number(hours.trim());
    if (n < 1 || n > MAX_REVIEW_HOURS) throw new Error(`${setting}: ${tier} must be 1 to ${MAX_REVIEW_HOURS} hours`);
    out.set(tier, n);
  }
  return out;
}

/** One feature at one level, as its guard would decide it for a caller holding exactly that level. */
export function featureAt(feature: KycLadderFeature, level: KycTier, region: string): KycLadderFeatureState {
  const guard = KYC_FEATURE_GUARDS[feature];
  const perOffer = guard.perOffer === true;
  const decision = checkAccess({ module: guard.module, plane: 'fiat', region, kycTier: level });
  const floor = guard.floor ?? 'none';
  if (decision.allowed && tierSatisfies(level, floor)) return { feature, state: 'allowed', perOffer };
  if (decision.allowed || decision.code === 'denied.kyc_required') {
    const required = decision.allowed ? floor : (decision.requiredTier ?? floor);
    const needs = tierSatisfies(required, floor) ? required : floor;
    return { feature, state: 'needs_level', level: needs, perOffer };
  }
  return { feature, state: 'blocked', code: decision.code, perOffer };
}

export function requirementsFor(settings: KycLadderSettings, level: KycTier): KycLevelRequirements {
  const keys = settings.requirements.get(level);
  return keys ? { published: true, keys: [...keys] } : { published: false };
}

export function describeLevels(input: {
  held: KycTier;
  region: string;
  regionResolved: boolean;
  settings: KycLadderSettings;
}): KycLevelsDescribeOutput {
  return {
    held: input.held,
    region: input.region,
    regionResolved: input.regionResolved,
    levels: KYC_TIERS.map((level) => ({
      level,
      current: level === input.held,
      features: KYC_LADDER_FEATURES.map((feature) => featureAt(feature, level, input.region)),
      requirements: requirementsFor(input.settings, level),
      reviewHours: input.settings.reviewHours.get(level) ?? null,
    })),
  };
}
