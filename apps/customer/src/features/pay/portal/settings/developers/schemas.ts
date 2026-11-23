import { z } from 'zod';
import { endpointSchema, deliveryStatuses, deliverySchema } from '@intafaced/contracts/pay-merchant-ops-procedures';
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
export type Endpoint = z.infer<typeof endpointSchema>;
export const createdEndpointSchema = z.object({ endpoint: endpointSchema, secret: z.string() });
export const rotatedEndpointSchema = z.object({ endpoint: endpointSchema, secret: z.string().nullable(), rotated: z.boolean() });

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
export { endpointSchema, deliveryStatuses };
