import { z } from 'zod';

/**
 * M-bill-04 (spec merchant-disp-bill-rep): subscription retry schedule, final action, manual retry,
 * subscription event catalogue and subscription search. Wire shapes only; svc-pay implements them.
 *
 * OWNER VALUES. Retry attempts, spacing and the final action are owner decisions ("Retry policy numbers
 * need a decision from the lead before enabling"). Nothing here defaults them: a policy with any of the
 * three unset reads `status: 'unset'`, and enabling auto-retry on it refuses
 * `pay.subscription_retry_policy_unset`.
 *
 * A retry never pulls money. It re-issues the crypto invoice link through the normal charge path and notifies.
 */

/**
 * The attempt ceiling a merchant may choose. It mirrors svc-pay's operational bound
 * `MAX_ATTEMPTS_PER_CYCLE = 3` (services/svc-pay/src/subscriptions/charge-cycle.ts). A merchant value above it
 * would never run, so the schema refuses it. Raising it needs the lead's ruling on that bound first.
 */
export const SUBSCRIPTION_RETRY_ATTEMPTS_MAX = 3;

/** What happens to the subscription when the last attempt of a cycle fails. Applied once per subscription and cycle. */
export const SUBSCRIPTION_RETRY_FINAL_ACTIONS = ['cancel', 'mark_unpaid', 'leave_past_due'] as const;
export type SubscriptionRetryFinalAction = (typeof SUBSCRIPTION_RETRY_FINAL_ACTIONS)[number];

export const SUBSCRIPTION_RETRY_CODES = [
  'pay.subscription_retry_policy_unset',
  'pay.subscription_retry_policy_invalid',
  'pay.subscription_retry_policy_conflict',
  'pay.subscription_retry_attempt_not_found',
  'pay.subscription_retry_checking',
] as const;
export type SubscriptionRetryCode = (typeof SUBSCRIPTION_RETRY_CODES)[number];

const uuid = z.string().uuid();

/** The three owner values. Each is null until the merchant sets it; there is no default. */
export const subscriptionRetryValuesSchema = z
  .object({
    attempts: z.number().int().min(1).max(SUBSCRIPTION_RETRY_ATTEMPTS_MAX).nullable(),
    /** Hours between attempts within one cycle. */
    spacingHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .nullable(),
    finalAction: z.enum(SUBSCRIPTION_RETRY_FINAL_ACTIONS).nullable(),
  })
  .strict();
export type SubscriptionRetryValues = z.infer<typeof subscriptionRetryValuesSchema>;

export const subscriptionRetryPolicyViewSchema = z
  .object({
    merchantId: uuid,
    /** `unset` while any owner value is null; auto-retry cannot be enabled then. */
    status: z.enum(['unset', 'set']),
    values: subscriptionRetryValuesSchema,
    autoRetry: z.boolean(),
    /** 0 before the first write. Every write must name the version it read. */
    version: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SubscriptionRetryPolicyView = z.infer<typeof subscriptionRetryPolicyViewSchema>;

export const subscriptionRetryPolicyGetInputSchema = z.object({ merchantId: uuid }).strict();

/** Versioned write. `autoRetry: true` refuses `pay.subscription_retry_policy_unset` unless all three values are set. */
export const subscriptionRetryPolicySetInputSchema = z
  .object({
    merchantId: uuid,
    values: subscriptionRetryValuesSchema,
    autoRetry: z.boolean(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export type SubscriptionRetryPolicySetInput = z.infer<typeof subscriptionRetryPolicySetInputSchema>;

/** Manual retry of one failed cycle attempt (an execution row). */
export const subscriptionRetryNowInputSchema = z
  .object({
    executionId: uuid,
    /** The attempt number being asked for: the attempt count the caller saw, plus one. A repeat returns the first. */
    attempt: z
      .number()
      .int()
      .min(2)
      .max(SUBSCRIPTION_RETRY_ATTEMPTS_MAX + 1),
  })
  .strict();

/**
 * - `reissued`: a new attempt re-issued the invoice link and notified.
 * - `already_attempted`: a second call for the same attempt returns the first attempt's result.
 * - `already_paid`: the invoice is paid; nothing was done.
 * - `checking`: the previous attempt's result is unknown; this call waits and does nothing.
 * - `rejected`: the new attempt ran the charge path and failed again.
 * - `final_action_applied`: the policy's attempts are spent; the final action was applied (once per cycle).
 */
export const subscriptionRetryNowResultSchema = z
  .object({
    executionId: uuid,
    outcome: z.enum(['reissued', 'rejected', 'already_attempted', 'already_paid', 'checking', 'final_action_applied']),
    attempt: z.number().int().min(1),
    paymentId: uuid.nullable(),
    /** Set when the policy's attempts are spent: the final action recorded for this cycle (applied once). */
    finalAction: z.enum(SUBSCRIPTION_RETRY_FINAL_ACTIONS).nullable(),
  })
  .strict();
export type SubscriptionRetryNowResult = z.infer<typeof subscriptionRetryNowResultSchema>;

/** Subscription events a merchant can pick on webhook setup. */
export const SUBSCRIPTION_EVENT_TYPES = [
  'subscription.created',
  'subscription.updated',
  'subscription.paused',
  'subscription.resumed',
  'subscription.trial_ending',
  'subscription.cancelled',
  'subscription.payment_failed',
  'subscription.recovered',
] as const;
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number];
export const subscriptionEventTypeSchema = z.enum(SUBSCRIPTION_EVENT_TYPES);

export const SUBSCRIPTION_SEARCH_STATUSES = ['active', 'paused', 'cancelled', 'completed', 'past_due', 'unpaid'] as const;

export const subscriptionSearchInputSchema = z
  .object({
    merchantId: uuid,
    customerId: z.string().trim().min(1).max(200).optional(),
    status: z.enum(SUBSCRIPTION_SEARCH_STATUSES).optional(),
    /** Created-at window, inclusive from, exclusive to. */
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from < v.to, { message: 'from must be before to', path: ['to'] });
export type SubscriptionSearchInput = z.infer<typeof subscriptionSearchInputSchema>;

/** True only when every owner value is set. */
export function subscriptionRetryValuesComplete(
  v: SubscriptionRetryValues,
): v is { attempts: number; spacingHours: number; finalAction: SubscriptionRetryFinalAction } {
  return v.attempts !== null && v.spacingHours !== null && v.finalAction !== null;
}
