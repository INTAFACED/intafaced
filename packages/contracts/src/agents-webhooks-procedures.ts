import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-agents' run webhooks (AG-sessions-04; J-agents-12 #5): a person's own code registers an endpoint with their API
 * key, and every run they started in their own session that ends afterwards is delivered to it once, signed. A key with
 * `agents:read` may register, list and read deliveries: none of these starts or changes a run.
 */

const AGENTS_READ = { caller: 'scope', scope: 'agents:read', module: 'agents' } as const;
const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

export const runWebhookEndpointSchema = z.object({
  id: z.string().guid(),
  url: z.string(),
  createdAt: z.string().datetime(),
  /** The signing secret, shown once: on the register that made the endpoint, null on every other read. */
  secret: z.string().nullable(),
});

export const runWebhookDeliverySchema = z.object({
  /** The event's business key, also the post's `x-intafaced-event-id` and `idempotency-key`. */
  eventId: z.string(),
  endpointId: z.string().guid(),
  runId: z.string().guid(),
  kind: z.enum(['run', 'background']),
  /** The state the run ended in. */
  runState: z.string(),
  state: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number().int().nonnegative(),
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().datetime().nullable(),
});

const ENDPOINT_ID = '33333333-3333-4333-8333-333333333333';

export const AGENTS_WEBHOOK_REGISTER = defineProcedure({
  ...base,
  name: 'agents.webhook.register',
  kind: 'mutation',
  path: 'webhook.register',
  access: AGENTS_READ,
  refusals: Object.freeze({
    'agents.webhook_url_invalid': 'BAD_REQUEST',
    'agents.webhook_endpoint_conflict': 'CONFLICT',
    'agents.webhooks_unwired': 'PRECONDITION_FAILED',
  }) satisfies Refusals,
  input: z.object({ endpointId: z.string().guid(), url: z.string().min(1).max(2048) }).strict(),
  output: runWebhookEndpointSchema,
  samples: [
    { verdict: 'accept', input: { endpointId: ENDPOINT_ID, url: 'https://hooks.example.com/agents' } },
    { verdict: 'refuse', input: { endpointId: 'not-an-id', url: 'https://hooks.example.com/agents' } },
    { verdict: 'refuse', input: { endpointId: ENDPOINT_ID } },
  ],
});

export const AGENTS_WEBHOOK_LIST = defineProcedure({
  ...base,
  name: 'agents.webhook.list',
  kind: 'query',
  path: 'webhook.list',
  access: AGENTS_READ,
  refusals: Object.freeze({ 'agents.webhooks_unwired': 'PRECONDITION_FAILED' }) satisfies Refusals,
  input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  output: z.array(runWebhookEndpointSchema),
  samples: [
    { verdict: 'accept', input: { limit: 10 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const AGENTS_WEBHOOK_DELIVERIES = defineProcedure({
  ...base,
  name: 'agents.webhook.deliveries',
  kind: 'query',
  path: 'webhook.deliveries',
  access: AGENTS_READ,
  refusals: Object.freeze({ 'agents.webhooks_unwired': 'PRECONDITION_FAILED' }) satisfies Refusals,
  input: z
    .object({ endpointId: z.string().guid().optional(), runId: z.string().guid().optional(), limit: z.number().int().min(1).max(500) })
    .strict(),
  output: z.array(runWebhookDeliverySchema),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'accept', input: { endpointId: ENDPOINT_ID, limit: 50 } },
    { verdict: 'refuse', input: { limit: 501 } },
  ],
});
