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
  createdAt: stamp,
  updatedAt: stamp,
});
export type Endpoint = z.infer<typeof endpointSchema>;
export const createdEndpointSchema = z.object({ endpoint: endpointSchema, secret: z.string() });
export const rotatedEndpointSchema = z.object({ endpoint: endpointSchema, secret: z.string().nullable(), rotated: z.boolean() });

export const deliveryStatuses = ['pending', 'delivered', 'failed', 'dead'] as const;
export const deliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventType: z.string(),
  status: z.enum(deliveryStatuses),
  attempts: z.number().int().min(0),
  lastStatusCode: z.number().int().nullable(),
  latencyMs: z.number().nullish(),
  createdAt: stamp,
  deliveredAt: stamp.nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export const retriedSchema = z.object({ retried: z.boolean(), delivery: deliverySchema });

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
      }),
      lastDeliveredAt: stamp.nullable(),
    }),
  ),
});
export type Health = z.infer<typeof healthSchema>;
