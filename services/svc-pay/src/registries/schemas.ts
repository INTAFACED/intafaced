import { z } from 'zod';
import {
  REGISTRIES,
  registryEventViewSchema,
  VENUE_MODES,
  venueModeSchema,
  reasonSchema,
  venueSaveInputSchema,
  assetCodeSchema,
  FEE_ESTIMATE_SOURCES,
  feeEstimateSourceSchema,
  networkSaveInputSchema,
  walletRouteSaveInputSchema,
  registryPreviewInputSchema,
  registryPreviewSchema,
} from '@intafaced/contracts/pay-founder-admin-procedures';

export type VenueMode = (typeof VENUE_MODES)[number];

export type FeeEstimateSource = (typeof FEE_ESTIMATE_SOURCES)[number];

export type RegistryKind = (typeof REGISTRIES)[number];

// ── venues ──────────────────────────────────────────────────────────────────
export type VenueSaveInput = z.infer<typeof venueSaveInputSchema>;

// ── networks ────────────────────────────────────────────────────────────────
export type NetworkSaveInput = z.infer<typeof networkSaveInputSchema>;

// ── wallet routes ───────────────────────────────────────────────────────────
export type WalletRouteSaveInput = z.infer<typeof walletRouteSaveInputSchema>;

// ── preview and history ─────────────────────────────────────────────────────
export type RegistryPreviewInput = z.infer<typeof registryPreviewInputSchema>;

export const listInputSchema = z.object({}).strict();

// ── views ───────────────────────────────────────────────────────────────────
const stamp = { version: z.number().int(), updatedAt: z.string(), updatedBy: z.string() };
const missing = { routable: z.boolean(), missing: z.array(z.string()) };

const venueHealthViewSchema = z
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

export type RegistryEventView = z.infer<typeof registryEventViewSchema>;
export { reasonSchema, venueSaveInputSchema, assetCodeSchema, networkSaveInputSchema, walletRouteSaveInputSchema };
