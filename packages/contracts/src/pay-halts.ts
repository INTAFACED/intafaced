import { z } from 'zod';
import { payMerchantIdSchema, payReasonSchema, payRequestIdSchema, payTimestampSchema, payVersionSchema } from './merchant-control.js';

/**
 * GRANULAR PAY HALTS — wire contract (workstream W0, built by W5).
 *
 * A halt is one switch with two coordinates: WHAT it stops (intake, conversion,
 * payout, settlement) and WHO it covers (everyone, or one merchant). Halting one
 * scope leaves the others running. The store is shared by every replica and an
 * unreadable store means HALTED, so `readable: false` is a refusal, never "not
 * halted".
 */

export const PAY_HALT_SCOPES = ['intake', 'conversion', 'payout', 'settlement'] as const;
export type PayHaltScope = (typeof PAY_HALT_SCOPES)[number];
export const payHaltScopeSchema = z.enum(PAY_HALT_SCOPES);

export const payHaltTargetSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('global') }).strict(),
  z.object({ level: z.literal('merchant'), merchantId: payMerchantIdSchema }).strict(),
]);
export type PayHaltTarget = z.infer<typeof payHaltTargetSchema>;

export const payHaltStateSchema = z
  .object({
    scope: payHaltScopeSchema,
    target: payHaltTargetSchema,
    halted: z.boolean(),
    reason: z.string().nullable(),
    /** `operator` = a founder set it; `auto_trip` = consecutive venue or rail failures tripped it. */
    source: z.enum(['operator', 'auto_trip']).nullable(),
    actorUserId: z.string().uuid().nullable(),
    version: payVersionSchema,
    changedAt: payTimestampSchema.nullable(),
  })
  .strict();
export type PayHaltState = z.infer<typeof payHaltStateSchema>;

/**
 * What a MERCHANT may see of one halt: whether it is on, and since when. The
 * operator's free-text reason, the founder's user id and the trip source are
 * founder-only (isolation suite G10), so they are not in this shape at all.
 */
export const payHaltMerchantStateSchema = payHaltStateSchema.pick({ scope: true, target: true, halted: true, changedAt: true }).strict();

/** Effective status for one merchant: the global switch and the merchant switch per scope. */
export const payHaltStatusInputSchema = z.object({ merchantId: payMerchantIdSchema.optional() }).strict();
export const payHaltStatusSchema = z
  .object({
    /** False when the store could not be read. Treat every scope as halted. */
    readable: z.boolean(),
    states: z.array(payHaltMerchantStateSchema),
  })
  .strict();
export type PayHaltStatus = z.infer<typeof payHaltStatusSchema>;

/** The same status with operator fields, for `founderAdmin.*` only. */
export const payHaltOperatorStatusSchema = z.object({ readable: z.boolean(), states: z.array(payHaltStateSchema) }).strict();
export type PayHaltOperatorStatus = z.infer<typeof payHaltOperatorStatusSchema>;

/** The actor comes from founder authentication, never this body. */
export const payHaltSetInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    scope: payHaltScopeSchema,
    target: payHaltTargetSchema,
    halted: z.boolean(),
    reason: payReasonSchema,
    expectedVersion: payVersionSchema,
  })
  .strict();
export type PayHaltSetInput = z.infer<typeof payHaltSetInputSchema>;

export const payHaltSetResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    outcome: z.enum(['changed', 'noop', 'conflict']),
    state: payHaltStateSchema,
  })
  .strict();

export const payHaltHistoryInputSchema = z
  .object({ scope: payHaltScopeSchema.optional(), target: payHaltTargetSchema.optional(), limit: z.number().int().min(1).max(200) })
  .strict();
