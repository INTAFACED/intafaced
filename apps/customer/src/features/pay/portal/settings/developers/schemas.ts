import { z } from 'zod';
import { stamp } from '../b-shared';

// Authorities on main: services/identity apiKeys.*, setApiKeyRequestSigning, rotateSigningSecret, bind/unbindApiKeyIpAllowlist,
// and services/svc-pay/src/merchant-ops/webhooks.ts (#4826). Unknown keys are ignored.

export const keySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
  mode: z.enum(['live', 'sandbox']),
  requireSignature: z.boolean(),
  requireNonEmptyIpAllowlist: z.boolean(),
  ipAllowlist: z.array(z.string()),
});
export type ApiKey = z.infer<typeof keySchema>;
export const createdKeySchema = z.object({ id: z.string(), key: z.string(), prefix: z.string(), mode: z.enum(['live', 'sandbox']) });
export const revokedSchema = z.object({ revoked: z.boolean() });
export const signingSchema = z.object({
  id: z.string(),
  requireSignature: z.boolean(),
  requireNonEmptyIpAllowlist: z.boolean(),
  signingSecret: z.string().nullable(),
});
export type SigningResult = z.infer<typeof signingSchema>;
export const rotatedSigningSchema = z.object({ id: z.string(), signingSecret: z.string() });
export const ipListSchema = z.object({ id: z.string(), ipAllowlist: z.array(z.string()) });

export const endpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  status: z.enum(['active', 'disabled']),
  disabledReason: z.string().nullish(),
  consecutiveFailures: z.number().int().min(0),
  /** The event types it subscribed to. An older service that does not send them is read as every type. */
  eventTypes: z.array(z.string()).optional(),
  /** While a rolled secret still signs beside the new one: when it stops. */
  previousSecretUntil: stamp.nullish(),
  createdAt: stamp,
  updatedAt: stamp,
});
export type Endpoint = z.infer<typeof endpointSchema>;
export const createdEndpointSchema = z.object({ endpoint: endpointSchema, secret: z.string() });
export const rotatedEndpointSchema = z.object({ endpoint: endpointSchema, secret: z.string().nullable(), rotated: z.boolean() });

export const deliveryStatuses = ['pending', 'delivered', 'failed', 'dead', 'unknown'] as const;
export const deliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.string().optional(),
  eventType: z.string(),
  status: z.enum(deliveryStatuses),
  attempts: z.number().int().min(0),
  lastStatusCode: z.number().int().nullable(),
  latencyMs: z.number().nullish(),
  nextAttemptAt: stamp.nullish(),
  createdAt: stamp,
  deliveredAt: stamp.nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const retriedSchema = z.object({ retried: z.boolean(), delivery: deliverySchema });
export const recoveredSchema = z.object({ recovered: z.boolean(), queued: z.number().int().min(0) });

export const attemptsSchema = z.object({
  deliveryId: z.string(),
  attempts: z.array(
    z.object({
      attemptNo: z.number().int().min(1),
      at: stamp,
      outcome: z.enum(['delivered', 'failed', 'unknown']),
      statusCode: z.number().int().nullable(),
      error: z.string().nullable(),
      durationMs: z.number().min(0),
      resend: z.boolean(),
    }),
  ),
});
export type Attempts = z.infer<typeof attemptsSchema>;

/** The owner's webhook values; each null is not set. */
export const policySchema = z.object({
  endpointCap: z.number().int().nullable(),
  overlapMaxSeconds: z.number().int().nullable(),
  resendWindowSeconds: z.number().int().nullable(),
  retryScheduleSeconds: z.array(z.number().int()).nullable(),
  resendRate: z.object({ maxPerWindow: z.number().int(), windowMs: z.number().int() }).nullable(),
});
export type Policy = z.infer<typeof policySchema>;

export const catalogueSchema = z.object({
  events: z.array(z.object({ type: z.string(), summary: z.string(), payloadSchema: z.unknown() })),
  ordering: z.string(),
  duplicates: z.string(),
});
export type Catalogue = z.infer<typeof catalogueSchema>;

export const guideSchema = z.object({
  headers: z.object({ timestamp: z.string(), signature: z.string(), eventId: z.string() }),
  algorithm: z.string(),
  toleranceSeconds: z.number().int().nullable(),
  senderIps: z.array(z.string()).nullable(),
  vector: z.object({ secret: z.string(), timestamp: z.string(), body: z.string(), signature: z.string() }),
});
export type Guide = z.infer<typeof guideSchema>;

export const healthSchema = z.object({
  asOf: stamp,
  endpoints: z.array(
    z.object({
      endpointId: z.string(),
      status: z.enum(['active', 'disabled']),
      consecutiveFailures: z.number().int().min(0),
      deliveries: z.object({
        pending: z.number().int().min(0),
        delivered: z.number().int().min(0),
        failed: z.number().int().min(0),
        dead: z.number().int().min(0),
        unknown: z.number().int().min(0).optional(),
      }),
      lastDeliveredAt: stamp.nullable(),
    }),
  ),
});
export type Health = z.infer<typeof healthSchema>;
