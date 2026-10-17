import { z } from 'zod';
import { decimalSchema } from '../../../../../shared/money';

// mirrors origin/feat/pay-portal-be-profile-analytics:packages/contracts/src/merchant-portal.ts; import from @intafaced/contracts after merge
// Parsed tolerantly: unknown keys are ignored.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const freshness = z.object({ asOf: z.string().nullable(), lagSeconds: z.number().int().min(0).nullable() });

export const volumePointSchema = z.object({ period: day, assetCode: z.string(), count: z.number().int().min(0), volume: decimalSchema });
export type VolumePoint = z.infer<typeof volumePointSchema>;
export const volumeSchema = z.object({
  bucket: z.enum(['day', 'week']),
  from: day,
  to: day,
  freshness,
  items: z.array(volumePointSchema),
  nextCursor: z.string().nullable(),
});
export type VolumePage = z.infer<typeof volumeSchema>;

export const feePointSchema = z.object({
  period: day,
  assetCode: z.string(),
  gross: decimalSchema,
  fees: decimalSchema,
  net: decimalSchema,
  refunded: decimalSchema,
});
export type FeePoint = z.infer<typeof feePointSchema>;
export const feesSchema = z.object({
  bucket: z.enum(['day', 'week']),
  from: day,
  to: day,
  freshness,
  items: z.array(feePointSchema),
  nextCursor: z.string().nullable(),
  // Null until the service aggregates the pricing rules it stored with each fee. The browser never works one out.
  effectiveRate: z.unknown().nullable().optional(),
  effectiveRateReason: z.string().optional(),
  conversionCost: z.unknown().nullable().optional(),
});
export type FeesPage = z.infer<typeof feesSchema>;
