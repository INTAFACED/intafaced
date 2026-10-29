/**
 * AGENTS A PERSON BUILDS (AG-builder-01) — what svc-agents `own.*` answers. Browser-safe: zod only.
 *
 * A draft is the person's own and moves no value. Its tools come only from the service's addable catalogue; a tool
 * that moves money is listed with `movesMoney: true` so a builder can offer it and refuse it, and is never stored. A
 * blank per-session cap stays `null`, never zero or a default: the finding `agents.spend.cap_unset` blocks publishing.
 */

import { z } from 'zod';

export const OWN_AGENT_STATES = ['draft', 'published'] as const;

/** Something that stops a draft being published, as a code the surface words. */
export const ownAgentFindingSchema = z.object({ code: z.string(), blocksPublishing: z.boolean() });

export const ownAgentSchema = z.object({
  id: z.string().uuid(),
  template: z.string(),
  name: z.string(),
  instructions: z.string(),
  tools: z.array(z.string()),
  /** Canonical decimal string in the fee asset, or null while the person has not set it. */
  perSessionCap: z.string().nullable(),
  version: z.number().int().positive(),
  state: z.enum(OWN_AGENT_STATES),
  findings: z.array(ownAgentFindingSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OwnAgent = z.infer<typeof ownAgentSchema>;

export const ownAgentToolSchema = z.object({ name: z.string(), module: z.string(), movesMoney: z.boolean() });

/** `own.catalogue`: the templates a draft starts from and the tools it may be offered. */
export const ownAgentCatalogueSchema = z.object({
  templates: z.array(z.object({ id: z.string(), tools: z.array(z.string()) })),
  tools: z.array(ownAgentToolSchema),
});
export type OwnAgentCatalogue = z.infer<typeof ownAgentCatalogueSchema>;

/**
 * `own.limits.get` / `own.limits.set`: the caps a person sets for one of their own agents (AG-spend-01). Every amount
 * is a decimal string in the fee asset. `limits` is null until all three are set; `effectivePerSession` is the lower of
 * the person's per-session value and the agent's own cap, and null while either is unset. `assetId` is the fee asset.
 */
export const ownAgentLimitsSchema = z.object({
  limits: z.object({ perCall: z.string(), perSession: z.string(), perPeriod: z.string(), period: z.literal('month') }).nullable(),
  agentCap: z.string().nullable(),
  effectivePerSession: z.string().nullable(),
  assetId: z.string(),
});
export type OwnAgentLimits = z.infer<typeof ownAgentLimitsSchema>;

/** `own.session.open`: a session of the person's own agent, bound to its tools and caps as they stood at open. */
export const ownAgentSessionSchema = z.object({ sessionId: z.string().uuid(), agentId: z.string() });
export type OwnAgentSession = z.infer<typeof ownAgentSessionSchema>;

/** `own.run`: one admitted run. A refused run answers with its refusal code as the error message instead. */
export const ownAgentRunResultSchema = z.object({
  text: z.string(),
  cost: z.string(),
  assetId: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
});
export type OwnAgentRunResult = z.infer<typeof ownAgentRunResultSchema>;

/** `own.runs`: every engine call asked of the agent, newest first. A refused one carries its code and costs 0. */
export const ownAgentRunRowSchema = z.object({
  sessionId: z.string().uuid(),
  sequence: z.number().int(),
  status: z.enum(['executed', 'refused', 'failed']),
  refusalCode: z.string().nullable(),
  cost: z.string(),
  assetId: z.string(),
  occurredAt: z.string(),
});
export type OwnAgentRunRow = z.infer<typeof ownAgentRunRowSchema>;

/** `own.session.close`: the session closed once every window of it is paid. An unpaid one refuses `agents.window_unpaid`. */
export const ownAgentSessionClosedSchema = z.object({ sessionId: z.string().uuid(), status: z.literal('closed'), closedAt: z.string() });
export type OwnAgentSessionClosed = z.infer<typeof ownAgentSessionClosedSchema>;

/**
 * `own.usage`: the usage windows of the agent's sessions, newest first. `open` is still taking usage (no amount yet);
 * `unpaid` is sealed at `amount` but the ledger refused the charge, retried on the same `chargeKey`; `settled` is paid
 * (or had nothing to bill). Amounts are decimal strings in `assetId`.
 */
export const ownAgentUsageWindowSchema = z.object({
  sessionId: z.string().uuid(),
  windowId: z.string(),
  state: z.enum(['open', 'unpaid', 'settled']),
  amount: z.string().nullable(),
  chargeKey: z.string().nullable(),
  assetId: z.string(),
  openedAt: z.string(),
});
export type OwnAgentUsageWindow = z.infer<typeof ownAgentUsageWindowSchema>;
