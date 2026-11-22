import { kycTierSchema } from '@intafaced/contracts/identity';
import { z } from 'zod';
import { assetId, limitFiguresSchema, limitViewSchema } from '@intafaced/contracts/pay-founder-admin-procedures';

const reason = z.string().trim().min(3).max(500);

export const limitChangeInputSchema = z
  .object({
    tier: kycTierSchema,
    assetId,
    limit: limitFiguresSchema.nullable(),
    /** `null` creates the entry; otherwise the version the founder loaded. */
    expectedVersion: z.number().int().min(1).max(2_147_483_647).nullable(),
    reason,
    /** Identity-issued second-founder approval, bound to the exact change (see `preview`). */
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  })
  .strict();
export type LimitChangeInput = z.infer<typeof limitChangeInputSchema>;

export const limitPreviewInputSchema = limitChangeInputSchema.omit({ approvalId: true, operationId: true });
export type LimitPreviewInput = z.infer<typeof limitPreviewInputSchema>;

export type LimitView = z.infer<typeof limitViewSchema>;

export const limitPreviewSchema = z
  .object({
    needsDualControl: z.boolean(),
    reasons: z.array(z.string()),
    actionType: z.string(),
    payloadHash: z.string(),
  })
  .strict();

export const limitHistoryInputSchema = z
  .object({ tier: kycTierSchema.optional(), assetId: assetId.optional(), limit: z.number().int().min(1).max(200) })
  .strict();

export const limitEventViewSchema = z
  .object({
    id: z.string(),
    seq: z.string(),
    tier: z.string(),
    assetId: z.string(),
    action: z.enum(['set', 'clear']),
    actorId: z.string(),
    approverId: z.string().nullable(),
    dualControl: z.boolean(),
    before: limitFiguresSchema.nullable(),
    after: limitFiguresSchema.nullable(),
    reason: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type LimitEventView = z.infer<typeof limitEventViewSchema>;
export { limitViewSchema };
