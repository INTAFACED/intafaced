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

/**
 * A tool's declared shape (AG-tools-01): its input and output fields, each named with its type in words. Null is not
 * declared: the surface says so and never guesses one, and a person's agent cannot attach the tool.
 */
export const ownAgentToolShapeSchema = z.object({
  input: z.record(z.string(), z.string()),
  output: z.record(z.string(), z.string()),
});
export type OwnAgentToolShape = z.infer<typeof ownAgentToolShapeSchema>;

/** One tool a draft may be offered: its module, whether it moves money, its declared shape and the refusals it returns. */
export const ownAgentToolSchema = z.object({
  name: z.string(),
  module: z.string(),
  movesMoney: z.boolean(),
  /** The class of data the tool touches (AG-guardrails-01); null for a money tool, which is never attached. */
  dataClass: z.enum(['own_data', 'market_data', 'draft_write', 'live_write']).nullable().default(null),
  // Defaults keep an older service's catalogue readable: its tools read as shape not declared.
  shape: ownAgentToolShapeSchema.nullable().default(null),
  refusals: z.array(z.string()).default([]),
});

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
  /** The owner's overage grace: how much usage may stay unpaid and runs still start. Null is blank: none at all. */
  overageGrace: z.string().nullable(),
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

/**
 * `own.runs`: every engine call asked of the agent, newest first. A refused one carries its code and costs 0. `task` is
 * the routing task the call was priced as (a blank rate refuses under it); null only on a row logged without one.
 */
export const ownAgentRunRowSchema = z.object({
  sessionId: z.string().uuid(),
  sequence: z.number().int(),
  status: z.enum(['executed', 'refused', 'failed']),
  task: z.string().nullable(),
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

/**
 * `own.usageByDay`: the sealed usage of every agent the person built, one row per agent, UTC day and task, each the
 * exact sum of the sealed windows it covers (`windows` of them), so the rows of one agent add up to its sealed windows.
 * A window holds one day; `task` names every task its usage ran as. Amounts are decimal strings in `assetId`.
 */
export const ownAgentUsageDaySchema = z.object({
  agentId: z.string().uuid(),
  agentName: z.string(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  task: z.string(),
  amount: z.string(),
  windows: z.number().int().positive(),
  assetId: z.string(),
});
export type OwnAgentUsageDay = z.infer<typeof ownAgentUsageDaySchema>;

/** The classes of data a tool touches; the first use of each by an agent asks the person's consent (AG-guardrails-01). */
export const OWN_AGENT_DATA_CLASSES = ['own_data', 'market_data', 'draft_write', 'live_write'] as const;
export type OwnAgentDataClass = (typeof OWN_AGENT_DATA_CLASSES)[number];

/** A standing rule's choice, strictest first (AG-guardrails-02). */
export const OWN_AGENT_RULE_CHOICES = ['hand_off', 'ask_before', 'act_on_request', 'act_without_asking'] as const;
export type OwnAgentRuleChoice = (typeof OWN_AGENT_RULE_CHOICES)[number];

/** `own.rules.list` / `own.rules.save`: the person's standing rule for one tool of their agent. */
export const ownAgentRuleSchema = z.object({
  id: z.string().uuid(),
  tool: z.string(),
  choice: z.enum(OWN_AGENT_RULE_CHOICES),
  updatedAt: z.string(),
});
export type OwnAgentRule = z.infer<typeof ownAgentRuleSchema>;

/** `own.consents.*`: the person's consent to one class of tools for one agent; a withdrawn one keeps its revoke time. */
export const ownAgentConsentSchema = z.object({
  dataClass: z.enum(OWN_AGENT_DATA_CLASSES),
  state: z.enum(['granted', 'withdrawn']),
  grantedAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type OwnAgentConsent = z.infer<typeof ownAgentConsentSchema>;

/** A tool call a rule held for the person: the tool has not run (the request AG-approvals-01 decides). */
export const ownAgentApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  tool: z.string(),
  input: z.record(z.string(), z.string()),
  status: z.literal('waiting'),
  ruleId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type OwnAgentApprovalRequest = z.infer<typeof ownAgentApprovalRequestSchema>;

/**
 * `own.tool.try`: one tool call of the person's own agent in its session. `ran` is the tool's answer as its door gave
 * it; `waiting` is an approval request and the tool has not run. A refusal answers with its code as the error message.
 */
export const ownAgentToolCallSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ran'), tool: z.string(), dataClass: z.enum(OWN_AGENT_DATA_CLASSES), result: z.unknown() }),
  z.object({
    outcome: z.literal('waiting'),
    tool: z.string(),
    dataClass: z.enum(OWN_AGENT_DATA_CLASSES),
    request: ownAgentApprovalRequestSchema,
  }),
]);
export type OwnAgentToolCall = z.infer<typeof ownAgentToolCallSchema>;
