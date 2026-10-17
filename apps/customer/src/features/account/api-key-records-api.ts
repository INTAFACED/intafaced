import { z } from 'zod';
import type { ApiClient } from '../../shared/api';

export const apiKeyReadWindows = [50, 100, 150, 200] as const;
export type ApiKeyReadWindow = (typeof apiKeyReadWindows)[number];

// The mounted producer publishes Date.toISOString(); syntax alone cannot prove
// a finite, renderable date or reject a calendar rollover.
const lastUsed = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const record = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    lastUsedAt: lastUsed.nullable(),
    revoked: z.boolean(),
    mode: z.enum(['live', 'sandbox']),
    requireSignature: z.boolean(),
    requireNonEmptyIpAllowlist: z.boolean(),
    ipAllowlist: z.array(z.string()),
  })
  .strict();
export type ApiKeyRecord = z.infer<typeof record>;

export function apiKeyRecordsFor(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid API-key read window');
  return z
    .array(record)
    .max(limit)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, 'Duplicate API-key records');
}

export function readApiKeyRecords(api: ApiClient, limit: ApiKeyReadWindow, signal: AbortSignal) {
  // Ownership is the service's ctx.principal.userId predicate, never a client
  // owner/company argument or an authority inferred from returned metadata.
  return api.query('identity', 'apiKeys.list', { limit }, apiKeyRecordsFor(limit), { signal });
}
