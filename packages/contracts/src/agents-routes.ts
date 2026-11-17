import { z } from 'zod';

/**
 * svc-agents' routing table desk (`routes.desk`, `routes.propose`, `routes.withdraw`, `routes.confirm`; J-agents-20):
 * what the service answers, in one place, so the service declares its output and the founder console reads it from the
 * same file. Rates are decimal strings per million tokens, null when not set; nothing here is a balance.
 */

export const routeChangeSchema = z.object({
  id: z.string(),
  task: z.string(),
  maxOutputTokens: z.number().int(),
  inputPerMillion: z.string().nullable(),
  outputPerMillion: z.string().nullable(),
  status: z.enum(['pending', 'applied', 'withdrawn']),
  proposedBy: z.string(),
  confirmedBy: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type RouteChange = z.infer<typeof routeChangeSchema>;

export const routeSnapshotSchema = z.object({
  maxOutputTokens: z.number().int(),
  inputPerMillion: z.string().nullable(),
  outputPerMillion: z.string().nullable(),
});

export const routeDeskRowSchema = z.object({
  task: z.string(),
  capability: z.enum(['complete', 'stream', 'embed']),
  providerId: z.string(),
  model: z.string(),
  /** Provider and model alias are configuration's alone: a provider swap is a configuration change. */
  providerSource: z.literal('configuration'),
  maxOutputTokens: z.number().int(),
  inputPerMillion: z.string().nullable(),
  outputPerMillion: z.string().nullable(),
  /** A confirmed rate that takes effect at the start of the next usage window. */
  nextRate: z.object({ inputPerMillion: z.string().nullable(), outputPerMillion: z.string().nullable(), from: z.string() }).nullable(),
  assetId: z.string(),
  engine: z.enum(['sandbox', 'live', 'unknown']),
  metered: z.boolean(),
  pending: routeChangeSchema.nullable(),
  lastChange: routeChangeSchema.nullable(),
});

export const routeAuditRowSchema = z.object({
  id: z.string(),
  at: z.string(),
  changeId: z.string(),
  task: z.string(),
  action: z.enum(['propose', 'withdraw', 'confirm']),
  operatorId: z.string(),
  proposedBy: z.string(),
  before: routeSnapshotSchema,
  after: routeSnapshotSchema,
});

export const routeDeskSchema = z.object({
  routes: z.array(routeDeskRowSchema),
  audit: z.array(routeAuditRowSchema),
});
export type RouteDesk = z.infer<typeof routeDeskSchema>;
