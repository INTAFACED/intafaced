/**
 * API rate limits for keys (DV-limits-01 to 03, journey J-developer-06): the owner's tiers, the per-route cost, a key's
 * usage, and a request for a higher limit that a support reviewer grants in full, in part, or refuses.
 *
 * A key spends from one token bucket: `burst` tokens at most, refilled at `refillPerMinute`. A call spends its route's
 * cost. svc-identity owns the tiers, the grants and the requests (a key's limit travels in the key exchange); svc-edge
 * owns the route costs and the bucket. Every number is an owner value: blank tiers or a blank cost refuse with a typed
 * code and never default.
 *
 * Browser-safe: zod only.
 */
import { z } from 'zod';

/** The tiers a key can be on: live keys on `base`, sandbox keys on `sandbox`. A grant raises one key above its tier. */
export const RATE_TIER_IDS = ['base', 'sandbox'] as const;
export type RateTierId = (typeof RATE_TIER_IDS)[number];

/** Largest refill a request or a grant may name (a shape bound, not an owner ceiling). */
export const RATE_PER_MINUTE_MAX = 1_000_000_000;

const count = z.number().int().positive().max(RATE_PER_MINUTE_MAX);

const isoInstant = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}, 'ISO instant');
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const rateTierSchema = z.object({ id: z.enum(RATE_TIER_IDS), burst: count, refillPerMinute: count }).strict();
export type RateTier = z.infer<typeof rateTierSchema>;

/** `developerKeys.rateTiers`: the published tiers. An empty list means the owner has set none. */
export const rateTiersOutputSchema = z
  .object({
    asOf: isoInstant,
    tiers: z.array(rateTierSchema),
    /** The most a reviewer may grant one key, per minute. Null while the owner has set none (every grant refuses). */
    grantCeilingPerMinute: count.nullable(),
  })
  .strict();
export type RateTiersOutput = z.infer<typeof rateTiersOutputSchema>;

/**
 * One key's limit as identity hands it to the edge in the key exchange. Null: no tier applies (blank tiers), so the
 * edge refuses every call of that key with `edge.limits_unset`.
 */
export const keyRateLimitSchema = z
  .object({ tier: z.enum([...RATE_TIER_IDS, 'granted']), burst: count, refillPerMinute: count })
  .strict();
export type KeyRateLimit = z.infer<typeof keyRateLimitSchema>;

/** One row of the edge's cost table: `METHOD /path` with `*` for one segment and a trailing `**` for the rest. */
export const routeCostSchema = z
  .object({ route: z.string().regex(/^(\*|GET|POST|PUT|PATCH|DELETE) \/\S*$/), cost: count })
  .strict();
export type RouteCost = z.infer<typeof routeCostSchema>;

/** `GET /api/edge/rate-limits/costs`: the cost table, first match wins. An empty list means the owner has set none. */
export const rateCostsOutputSchema = z.object({ asOf: isoInstant, costs: z.array(routeCostSchema) }).strict();
export type RateCostsOutput = z.infer<typeof rateCostsOutputSchema>;

/** Which limit refused a call. */
export const RATE_LIMIT_REASONS = ['global', 'endpoint', 'concurrency'] as const;
export type RateLimitReason = (typeof RATE_LIMIT_REASONS)[number];

/**
 * `GET /api/edge/rate-limits/keys/:keyId/usage`, read by the key's owner in a signed-in session. `counted`: this edge
 * has counted calls of the key since `since`; `none`: it has counted none (or the key is not the caller's: the answer
 * is the same, so it tells nothing about someone else's key). A usage read is never itself counted.
 */
export const keyUsageOutputSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('counted'),
      asOf: isoInstant,
      keyId: z.string().guid(),
      since: isoInstant,
      /** Tokens spent by allowed calls since `since`. */
      used: z.number().int().min(0),
      /** Calls refused 429 since `since`. */
      refused: z.number().int().min(0),
      /** Whole tokens in the bucket at `asOf`. */
      remaining: z.number().int().min(0),
      burst: count,
      refillPerMinute: count,
    })
    .strict(),
  z.object({ state: z.literal('none'), asOf: isoInstant, keyId: z.string().guid() }).strict(),
]);
export type KeyUsageOutput = z.infer<typeof keyUsageOutputSchema>;

export const LIMIT_REQUEST_STATUSES = ['waiting', 'granted', 'granted_in_part', 'refused'] as const;
export type LimitRequestStatus = (typeof LIMIT_REQUEST_STATUSES)[number];

export const LIMIT_REQUEST_NOTE_MAX = 500;

/** `developerKeys.limitRequests.create`: a higher refill for one of the caller's live keys, with an optional spike window. */
export const limitRequestCreateInputSchema = z
  .object({
    keyId: z.string().guid(),
    askedPerMinute: count,
    spikeStartsOn: isoDay.nullable(),
    spikeEndsOn: isoDay.nullable(),
    note: z.string().max(LIMIT_REQUEST_NOTE_MAX),
    /** The client's id for this one submission; a repeat returns the same record. */
    requestId: z.string().min(8).max(128),
  })
  .strict();
export type LimitRequestCreateInput = z.infer<typeof limitRequestCreateInputSchema>;

export const limitRequestSchema = z
  .object({
    id: z.string().guid(),
    keyId: z.string().guid(),
    keyName: z.string(),
    askedPerMinute: count,
    /** The key's refill when the request was made. */
    currentPerMinute: count,
    spikeStartsOn: isoDay.nullable(),
    spikeEndsOn: isoDay.nullable(),
    note: z.string(),
    status: z.enum(LIMIT_REQUEST_STATUSES),
    grantedPerMinute: count.nullable(),
    createdAt: isoInstant,
    reviewedAt: isoInstant.nullable(),
  })
  .strict();
export type LimitRequest = z.infer<typeof limitRequestSchema>;

export const limitRequestListOutputSchema = z.object({ asOf: isoInstant, requests: z.array(limitRequestSchema) }).strict();
export type LimitRequestListOutput = z.infer<typeof limitRequestListOutputSchema>;

/** Typed refusals of the request door. */
export const LIMIT_REQUEST_REFUSALS = [
  'identity.rate_limits_unset',
  'identity.key_not_found',
  'identity.key_not_live',
  'identity.limit_not_higher',
  'identity.limit_spike_invalid',
  'identity.limit_request_open',
  'identity.delegated_refused',
] as const;
export type LimitRequestRefusal = (typeof LIMIT_REQUEST_REFUSALS)[number];

/** The support desk's view of one request: the customer's record plus whose it is. */
export const limitRequestQueueRowSchema = limitRequestSchema.extend({ userId: z.string().guid(), keyPrefix: z.string() }).strict();
export type LimitRequestQueueRow = z.infer<typeof limitRequestQueueRowSchema>;

export const LIMIT_REVIEW_REASON_MIN = 4;
export const LIMIT_REVIEW_REASON_MAX = 500;

/** `limitRequestsDesk.review`: grant `grantedPerMinute` (all or part of the ask), or refuse. The reviewer is the session. */
export const limitReviewInputSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('grant'),
      id: z.string().guid(),
      grantedPerMinute: count,
      reason: z.string().trim().min(LIMIT_REVIEW_REASON_MIN).max(LIMIT_REVIEW_REASON_MAX),
    })
    .strict(),
  z
    .object({
      decision: z.literal('refuse'),
      id: z.string().guid(),
      reason: z.string().trim().min(LIMIT_REVIEW_REASON_MIN).max(LIMIT_REVIEW_REASON_MAX),
    })
    .strict(),
]);
export type LimitReviewInput = z.infer<typeof limitReviewInputSchema>;

/** Typed refusals of the review door. */
export const LIMIT_REVIEW_REFUSALS = [
  'identity.rate_limits_unset',
  'identity.rate_grant_ceiling_unset',
  'identity.rate_grant_above_ceiling',
  'identity.limit_grant_invalid',
  'identity.limit_request_decided',
  'identity.limit_request_not_found',
  'identity.limit_review_own',
  'identity.key_not_live',
] as const;
export type LimitReviewRefusal = (typeof LIMIT_REVIEW_REFUSALS)[number];

/** One audit entry: one per decision, written in the same transaction as the decision. */
export const limitAuditEntrySchema = z
  .object({
    id: z.string().guid(),
    requestId: z.string().guid(),
    keyId: z.string().guid(),
    keyName: z.string(),
    actorId: z.string().guid(),
    decision: z.enum(['granted', 'granted_in_part', 'refused']),
    askedPerMinute: count,
    previousPerMinute: count,
    grantedPerMinute: count.nullable(),
    reason: z.string(),
    at: isoInstant,
  })
  .strict();
export type LimitAuditEntry = z.infer<typeof limitAuditEntrySchema>;

export const limitDeskOutputSchema = z
  .object({
    asOf: isoInstant,
    requests: z.array(limitRequestQueueRowSchema),
    audit: z.array(limitAuditEntrySchema),
    grantCeilingPerMinute: count.nullable(),
  })
  .strict();
export type LimitDeskOutput = z.infer<typeof limitDeskOutputSchema>;

/** Whether a grant of `granted` on an ask of `asked` is the whole ask or part of it. */
export function grantStatus(asked: number, granted: number): 'granted' | 'granted_in_part' {
  return granted >= asked ? 'granted' : 'granted_in_part';
}
