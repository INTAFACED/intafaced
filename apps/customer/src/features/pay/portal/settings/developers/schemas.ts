import { z } from 'zod';
import { stamp } from '../b-shared';
import { healthSchema, attemptsSchema, policySchema, guideSchema } from '@intafaced/contracts/pay-merchant-ops-procedures';

// Authorities on main: services/identity apiKeys.*, setApiKeyRequestSigning, rotateSigningSecret, bind/unbindApiKeyIpAllowlist,
// and services/svc-pay/src/merchant-ops/webhooks.ts (#4826). Unknown keys are ignored.

const keySchema = z.object({
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

export type Attempts = z.infer<typeof attemptsSchema>;

export type Policy = z.infer<typeof policySchema>;

export const catalogueSchema = z.object({
  events: z.array(z.object({ type: z.string(), summary: z.string(), payloadSchema: z.unknown() })),
  ordering: z.string(),
  duplicates: z.string(),
});
export type Catalogue = z.infer<typeof catalogueSchema>;

export type Guide = z.infer<typeof guideSchema>;

export type Health = z.infer<typeof healthSchema>;
