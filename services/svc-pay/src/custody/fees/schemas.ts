import { z } from 'zod';
import { looksLikeSecret } from '../../registries/secret-guard.js';

/**
 * Wire shapes for `founderAdmin.custody.fees.*` and `founderAdmin.custody.gas.*` (W-custody-ops-10). Every input object
 * is `.strict()`. A fee cap and every gas figure are required positive decimal strings: a blank one is a parse error, so
 * no magnitude is ever defaulted. Nothing here is a balance.
 */
const decimal = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places')
  .refine((v) => /[1-9]/.test(v), 'amounts are positive');
const networkId = z.string().min(1).max(64);
const limit = z.number().int().min(1).max(200);
const reason = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .refine((v) => !looksLikeSecret(v), 'custody_fees.secret_like_value: credentials are never stored as a reason');
const ref = z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/, "a reference is the caller's own business key");
/** What the cap and the estimate are measured in, as the estimator names it (for example a gas price unit). */
const feeUnit = z.string().trim().min(1).max(32);

export const FEE_LEVELS = ['low', 'medium', 'high'] as const;
export const feeLevelSchema = z.enum(FEE_LEVELS);
export type FeeLevel = (typeof FEE_LEVELS)[number];

export const GAS_FEE_PAYERS = ['self', 'station', 'relay'] as const;

export const feeSetInputSchema = z
  .object({ networkId, feeLevel: feeLevelSchema, feeCap: decimal, feeUnit, managedNonce: z.boolean(), reason })
  .strict();
export type FeeSetInput = z.infer<typeof feeSetInputSchema>;
export const networkKeyInputSchema = z.object({ networkId }).strict();
export const feeListInputSchema = z.object({ limit, after: networkId.optional() }).strict();
export const feeHistoryInputSchema = z.object({ networkId, limit }).strict();
export const feeCheckInputSchema = z.object({ networkId, level: feeLevelSchema.optional() }).strict();

export const feeSettingViewSchema = z.object({
  networkId: z.string(),
  /** False while no setting was ever recorded; the figures are then null and a send refuses. */
  configured: z.boolean(),
  feeLevel: feeLevelSchema.nullable(),
  feeCap: z.string().nullable(),
  feeUnit: z.string().nullable(),
  managedNonce: z.boolean().nullable(),
  reason: z.string().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});
export type FeeSettingView = z.infer<typeof feeSettingViewSchema>;

export const feeEstimateViewSchema = z.object({
  networkId: z.string(),
  unit: z.string(),
  asOf: z.string(),
  tiers: z.object({ low: z.string(), medium: z.string(), high: z.string() }),
  /** Per tier: inside the cap, or null when no cap is set or its unit differs from the estimate's. */
  withinCap: z.object({ low: z.boolean().nullable(), medium: z.boolean().nullable(), high: z.boolean().nullable() }),
});
export type FeeEstimateView = z.infer<typeof feeEstimateViewSchema>;

export const feeCheckViewSchema = z.object({
  networkId: z.string(),
  level: feeLevelSchema,
  fee: z.string(),
  cap: z.string(),
  unit: z.string(),
  managedNonce: z.boolean(),
});
export type FeeCheckView = z.infer<typeof feeCheckViewSchema>;

/** The execution this module cannot do on its own: a refuel or a gasless relay runs behind the crypto rail. */
export const GAS_EXECUTION_BLOCKER = 'rail.crypto';

export const gasSetInputSchema = z
  .object({
    networkId,
    feePayer: z.enum(GAS_FEE_PAYERS),
    gasThreshold: decimal,
    gasCap: decimal,
    maxGasPrice: decimal,
    autoTopUp: z.boolean(),
    reason,
  })
  .strict();
export type GasSetInput = z.infer<typeof gasSetInputSchema>;

export const gasPolicyViewSchema = z.object({
  networkId: z.string(),
  configured: z.boolean(),
  feePayer: z.enum(GAS_FEE_PAYERS).nullable(),
  gasThreshold: z.string().nullable(),
  gasCap: z.string().nullable(),
  maxGasPrice: z.string().nullable(),
  autoTopUp: z.boolean().nullable(),
  reason: z.string().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
  /** Why an automatic top-up or a relayed send does not run from here. */
  executionBlocker: z.literal(GAS_EXECUTION_BLOCKER),
});
export type GasPolicyView = z.infer<typeof gasPolicyViewSchema>;

export const refuelRecordInputSchema = z.object({ refuelRef: ref, networkId, amount: decimal, txRef: ref, reason }).strict();
export type RefuelRecordInput = z.infer<typeof refuelRecordInputSchema>;
export const refuelListInputSchema = z.object({ networkId: networkId.optional(), limit }).strict();
export const refuelViewSchema = z.object({
  refuelRef: z.string(),
  networkId: z.string(),
  amount: z.string(),
  txRef: z.string(),
  reason: z.string(),
  recordedBy: z.string(),
  recordedAt: z.string().datetime({ offset: true }),
});
export type RefuelView = z.infer<typeof refuelViewSchema>;
