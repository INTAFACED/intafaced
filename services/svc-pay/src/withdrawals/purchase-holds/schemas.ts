import { z } from 'zod';

/**
 * Wire shapes for `founderAdmin.purchaseHolds.*` (W-withdraw-13). Every input object is `.strict()`. Amounts are
 * decimal strings, never numbers. A blank period is not a parse default: it is the absence of a policy row.
 */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
const holdRef = z
  .string()
  .regex(/^[A-Za-z0-9:_.-]{1,128}$/, "a hold reference is the caller's own business key, such as card:<payment id>");
const assetId = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);
const userId = z.string().guid();
const limit = z.number().int().min(1).max(200);

export const PURCHASE_RAILS = ['card', 'ach', 'paypal'] as const;

export const recordInputSchema = z
  .object({ holdRef, userId, assetId, amount, rail: z.enum(PURCHASE_RAILS), purchasedAt: z.string().datetime({ offset: true }) })
  .strict();
export type RecordInput = z.infer<typeof recordInputSchema>;

export const listInputSchema = z
  .object({ userId: userId.optional(), assetId: assetId.optional(), state: z.enum(['held', 'released']).optional(), limit })
  .strict();
export type ListInput = z.infer<typeof listInputSchema>;

/** The owner's release period in whole seconds. A positive integer or no policy at all. */
export const setPolicyInputSchema = z.object({ holdSeconds: z.number().int().min(1).max(31_536_000) }).strict();
export type SetPolicyInput = z.infer<typeof setPolicyInputSchema>;

export const releaseDueInputSchema = z.object({}).strict();

export const holdViewSchema = z.object({
  id: z.string().guid(),
  holdRef: z.string(),
  userId,
  assetId: z.string(),
  amount: z.string(),
  rail: z.enum(PURCHASE_RAILS),
  purchasedAt: z.string().datetime({ offset: true }),
  state: z.enum(['held', 'released']),
  /** When the hold ends under the current period, or null while the owner has set none. */
  releaseAt: z.string().datetime({ offset: true }).nullable(),
  releasedAt: z.string().datetime({ offset: true }).nullable(),
  recordedBy: z.string(),
  recordedAt: z.string().datetime({ offset: true }),
});
export type HoldView = z.infer<typeof holdViewSchema>;

export const policyViewSchema = z.object({
  /** Null while the owner has set no period; held funds then stay held and a withdrawal of them refuses. */
  holdSeconds: z.number().int().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});
export type PolicyView = z.infer<typeof policyViewSchema>;

export const releaseResultSchema = z.object({ released: z.array(z.string().guid()) });
export type ReleaseResult = z.infer<typeof releaseResultSchema>;

export const heldViewSchema = z.object({
  /** Sum of unreleased holds, as a decimal string. "0" when nothing is held. */
  heldAmount: z.string(),
  holds: z.number().int(),
  periodSet: z.boolean(),
  /** The earliest time any of these holds ends, or null while no period is set. */
  earliestReleaseAt: z.string().datetime({ offset: true }).nullable(),
});
export type HeldView = z.infer<typeof heldViewSchema>;
