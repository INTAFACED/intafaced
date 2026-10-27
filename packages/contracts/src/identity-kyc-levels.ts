import { z } from 'zod';

/**
 * I-kyc-compliance-04/05: the verification ladder a customer reads on /verification (`identity` `kyc.levels.describe`).
 *
 * Each level lists what it unlocks, worked out with the same `checkAccess` call the money services' own guards make for
 * the caller's region, so the page cannot promise what a service will refuse. A feature's state at a level is
 * `allowed`, `needs_level` (the level that unlocks it) or `blocked` (the region or the module refuses it at every level,
 * with the matrix's code). The data each level asks for and the review time the owner states are owner settings with no
 * default: a level the owner has not published reads `published: false`, never an empty list, and an unstated review
 * time is `null`. Read only: nothing here changes a tier. Withdrawal limits per level are svc-pay's figures (D-148).
 */
/** Lowest first. Mirrors `KYC_TIERS` in `@intafaced/config` (pinned by svc-identity's levels test), kept here so the app imports no config. */
export const KYC_LADDER_LEVELS = ['none', 'basic', 'full', 'institutional'] as const;
export const kycLadderLevelSchema = z.enum(KYC_LADDER_LEVELS);
export type KycLadderLevel = z.infer<typeof kycLadderLevelSchema>;

/** The features the ladder describes, each checked against the module whose guard serves it. */
export const KYC_LADDER_FEATURES = ['deposit', 'withdraw', 'trade', 'card', 'earn', 'rewards'] as const;
export const kycLadderFeatureSchema = z.enum(KYC_LADDER_FEATURES);
export type KycLadderFeature = z.infer<typeof kycLadderFeatureSchema>;

/**
 * What a level may ask for. The owner publishes which of these each level needs
 * (`IDENTITY_KYC_REQUIREMENTS_BY_LEVEL`); the list itself is the vocabulary, not a requirement.
 */
export const KYC_REQUIREMENT_KEYS = [
  'email',
  'phone',
  'legal_name',
  'date_of_birth',
  'residential_address',
  'nationality',
  'occupation',
  'tax_id',
  'id_document',
  'face_photo',
  'liveness',
  'proof_of_address',
  'questionnaire',
  'tax_certification',
  'source_of_funds',
] as const;
export const kycRequirementKeySchema = z.enum(KYC_REQUIREMENT_KEYS);
export type KycRequirementKey = z.infer<typeof kycRequirementKeySchema>;

export const kycLadderFeatureStateSchema = z.discriminatedUnion('state', [
  z.object({ feature: kycLadderFeatureSchema, state: z.literal('allowed'), perOffer: z.boolean() }).strict(),
  z
    .object({ feature: kycLadderFeatureSchema, state: z.literal('needs_level'), level: kycLadderLevelSchema, perOffer: z.boolean() })
    .strict(),
  z
    .object({ feature: kycLadderFeatureSchema, state: z.literal('blocked'), code: z.string().min(1).max(64), perOffer: z.boolean() })
    .strict(),
]);
export type KycLadderFeatureState = z.infer<typeof kycLadderFeatureStateSchema>;

export const kycLevelRequirementsSchema = z.discriminatedUnion('published', [
  z.object({ published: z.literal(false) }).strict(),
  z.object({ published: z.literal(true), keys: z.array(kycRequirementKeySchema).min(1).max(KYC_REQUIREMENT_KEYS.length) }).strict(),
]);
export type KycLevelRequirements = z.infer<typeof kycLevelRequirementsSchema>;

export const kycLadderRungSchema = z
  .object({
    level: kycLadderLevelSchema,
    /** The level the caller holds now. Exactly one rung is current. */
    current: z.boolean(),
    features: z.array(kycLadderFeatureStateSchema).length(KYC_LADDER_FEATURES.length),
    requirements: kycLevelRequirementsSchema,
    /** The owner's stated review time for this level, in hours. `null` = no review time is stated. */
    reviewHours: z.number().int().positive().nullable(),
  })
  .strict();
export type KycLadderRung = z.infer<typeof kycLadderRungSchema>;

export const kycLevelsDescribeOutputSchema = z
  .object({
    held: kycLadderLevelSchema,
    /** The region the rules were read for (the one the edge stamped on this request). */
    region: z.string().min(1).max(8),
    /** False when the edge could not resolve the region; the general rules are shown then. */
    regionResolved: z.boolean(),
    levels: z.array(kycLadderRungSchema).length(KYC_LADDER_LEVELS.length),
  })
  .strict()
  .refine((v) => v.levels.every((rung, i) => rung.level === KYC_LADDER_LEVELS[i]), 'levels are in ladder order')
  .refine(
    (v) => v.levels.filter((rung) => rung.current).length === 1 && v.levels.find((r) => r.current)?.level === v.held,
    'one current rung',
  );
export type KycLevelsDescribeOutput = z.infer<typeof kycLevelsDescribeOutputSchema>;
