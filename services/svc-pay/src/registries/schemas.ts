import { z } from 'zod';
import { payAmountStringSchema, payAssetCodeSchema } from '@intafaced/contracts';
import { looksLikeSecret } from './secret-guard.js';

/**
 * Wire shapes for `founderAdmin.registries.*`.
 *
 * EVERY input object is `.strict()`: an unknown field such as `apiKey` or
 * `secret` is a parse error, not something silently dropped, and no schema here
 * names a credential field. Free text additionally passes the secret tripwire.
 */

export const VENUE_MODES = ['disabled', 'testnet', 'live'] as const;
export const venueModeSchema = z.enum(VENUE_MODES);
export type VenueMode = (typeof VENUE_MODES)[number];

export const FEE_ESTIMATE_SOURCES = ['fixed', 'venue_quote', 'chain_estimate'] as const;
export const feeEstimateSourceSchema = z.enum(FEE_ESTIMATE_SOURCES);
export type FeeEstimateSource = (typeof FEE_ESTIMATE_SOURCES)[number];

export const REGISTRIES = ['venue', 'network', 'wallet_route'] as const;
export const registryKindSchema = z.enum(REGISTRIES);
export type RegistryKind = (typeof REGISTRIES)[number];

const noSecret = (value: string) => !looksLikeSecret(value);
const NO_SECRET_MESSAGE = 'registries.secret_like_value: credentials are never stored in a registry';

/** Human text: names and reasons. Letters, digits and light punctuation only. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} ._()&/+-]+$/u, 'letters, digits, spaces and . _ ( ) & / + - only')
  .refine(noSecret, NO_SECRET_MESSAGE);
export const reasonSchema = z.string().trim().min(3).max(500).refine(noSecret, NO_SECRET_MESSAGE);

export const venueIdSchema = z
  .string()
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'venue ids are lowercase words joined by hyphens');
export const networkIdSchema = z
  .string()
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'network ids are lowercase words joined by hyphens');
export const assetCodeSchema = payAssetCodeSchema.regex(/^[A-Z0-9]{1,16}$/, 'asset codes are upper-case letters and digits');
/** `BASE/QUOTE`, e.g. `USDT/USD`. */
export const pairSchema = z.string().regex(/^[A-Z0-9]{2,16}\/[A-Z0-9]{2,16}$/, 'pairs look like BASE/QUOTE');
export const merchantIdSchema = z.string().guid();

const versionSchema = z.number().int().min(1).max(2_147_483_647);
const approvalFields = {
  /** Identity-issued second-founder approval, bound to the exact change (see `preview`). */
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
};

// ── venues ──────────────────────────────────────────────────────────────────
export const venueSaveInputSchema = z
  .object({
    venueId: venueIdSchema,
    displayName: displayNameSchema,
    mode: venueModeSchema,
    priority: z.number().int().min(0).max(100_000),
    enabled: z.boolean(),
    /** Blank (null) means "not configured": the venue is never routed to. */
    minOrder: payAmountStringSchema.nullable(),
    maxOrder: payAmountStringSchema.nullable(),
    supportedPairs: z.array(pairSchema).max(200),
    /** null creates the entry; otherwise the version this edit is based on. */
    expectedVersion: versionSchema.nullable(),
    reason: reasonSchema,
    ...approvalFields,
  })
  .strict();
export type VenueSaveInput = z.infer<typeof venueSaveInputSchema>;

// ── networks ────────────────────────────────────────────────────────────────
export const networkSaveInputSchema = z
  .object({
    networkId: networkIdSchema,
    displayName: displayNameSchema,
    assetCodes: z.array(assetCodeSchema).max(100),
    confirmationsRequired: z.number().int().min(1).max(100_000).nullable(),
    enabled: z.boolean(),
    feeEstimateSource: feeEstimateSourceSchema.nullable(),
    /** Only with source `fixed`. */
    feeEstimateAmount: payAmountStringSchema.nullable(),
    expectedVersion: versionSchema.nullable(),
    reason: reasonSchema,
    ...approvalFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.feeEstimateSource === 'fixed' && v.feeEstimateAmount === null) {
      ctx.addIssue({ code: 'custom', path: ['feeEstimateAmount'], message: 'a fixed fee source needs an amount' });
    }
    if (v.feeEstimateSource !== 'fixed' && v.feeEstimateAmount !== null) {
      ctx.addIssue({ code: 'custom', path: ['feeEstimateAmount'], message: 'an amount belongs only to the fixed fee source' });
    }
  });
export type NetworkSaveInput = z.infer<typeof networkSaveInputSchema>;

// ── wallet routes ───────────────────────────────────────────────────────────
export const walletRouteSaveInputSchema = z
  .object({
    assetCode: assetCodeSchema,
    networkId: networkIdSchema,
    payoutAllowed: z.boolean(),
    /** Empty allow list means "no per-merchant restriction"; deny always wins. */
    merchantAllow: z.array(merchantIdSchema).max(1000),
    merchantDeny: z.array(merchantIdSchema).max(1000),
    maxSinglePayout: payAmountStringSchema.nullable(),
    expectedVersion: versionSchema.nullable(),
    reason: reasonSchema,
    ...approvalFields,
  })
  .strict();
export type WalletRouteSaveInput = z.infer<typeof walletRouteSaveInputSchema>;

// ── preview and history ─────────────────────────────────────────────────────
export const registryPreviewInputSchema = z.discriminatedUnion('registry', [
  z.object({ registry: z.literal('venue'), change: venueSaveInputSchema }).strict(),
  z.object({ registry: z.literal('network'), change: networkSaveInputSchema }).strict(),
  z.object({ registry: z.literal('wallet_route'), change: walletRouteSaveInputSchema }).strict(),
]);
export type RegistryPreviewInput = z.infer<typeof registryPreviewInputSchema>;

export const registryPreviewSchema = z
  .object({
    needsDualControl: z.boolean(),
    reasons: z.array(z.string()),
    /** What the second founder's approval must be issued for. */
    actionType: z.string(),
    payloadHash: z.string(),
  })
  .strict();

export const registryHistoryInputSchema = z
  .object({
    registry: registryKindSchema,
    entryKey: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(200),
  })
  .strict();

export const listInputSchema = z.object({}).strict();

// ── views ───────────────────────────────────────────────────────────────────
const stamp = { version: z.number().int(), updatedAt: z.string(), updatedBy: z.string() };
const missing = { routable: z.boolean(), missing: z.array(z.string()) };

export const venueHealthViewSchema = z
  .object({ healthy: z.boolean(), latencyMs: z.number(), lastUpdate: z.string(), reason: z.string().optional() })
  .strict();
export type VenueHealthView = z.infer<typeof venueHealthViewSchema>;

export const venueViewSchema = z
  .object({
    venueId: z.string(),
    displayName: z.string(),
    mode: venueModeSchema,
    priority: z.number().int(),
    enabled: z.boolean(),
    minOrder: z.string().nullable(),
    maxOrder: z.string().nullable(),
    supportedPairs: z.array(z.string()),
    /** From venue-adapter when a provider is wired; null is "unknown", never "healthy". */
    health: venueHealthViewSchema.nullable(),
    ...stamp,
    ...missing,
  })
  .strict();
export type VenueView = z.infer<typeof venueViewSchema>;

export const networkViewSchema = z
  .object({
    networkId: z.string(),
    displayName: z.string(),
    assetCodes: z.array(z.string()),
    confirmationsRequired: z.number().int().nullable(),
    enabled: z.boolean(),
    feeEstimateSource: feeEstimateSourceSchema.nullable(),
    feeEstimateAmount: z.string().nullable(),
    ...stamp,
    ...missing,
  })
  .strict();
export type NetworkView = z.infer<typeof networkViewSchema>;

export const walletRouteViewSchema = z
  .object({
    routeId: z.string().guid(),
    assetCode: z.string(),
    networkId: z.string(),
    payoutAllowed: z.boolean(),
    merchantAllow: z.array(z.string()),
    merchantDeny: z.array(z.string()),
    maxSinglePayout: z.string().nullable(),
    ...stamp,
    ...missing,
  })
  .strict();
export type WalletRouteView = z.infer<typeof walletRouteViewSchema>;

export const registryEventViewSchema = z
  .object({
    id: z.string().guid(),
    seq: z.string(),
    registry: registryKindSchema,
    entryKey: z.string(),
    action: z.enum(['create', 'update']),
    actorId: z.string(),
    approverId: z.string().nullable(),
    dualControl: z.boolean(),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()),
    reason: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type RegistryEventView = z.infer<typeof registryEventViewSchema>;
