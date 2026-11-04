/**
 * AGENTS A PERSON BUILDS (AG-builder-01) — what svc-agents `own.*` answers. Browser-safe: zod only.
 *
 * A draft is the person's own and moves no value. Its tools come only from the service's addable catalogue; a tool
 * that moves money is listed with `movesMoney: true` so a builder can offer it and refuse it, and is never stored. A
 * blank per-session cap stays `null`, never zero or a default: the finding `agents.spend.cap_unset` blocks publishing.
 */

import { z } from 'zod';

/** The classes of data a tool touches; the first use of each by an agent asks the person's consent (AG-guardrails-01). */
export const OWN_AGENT_DATA_CLASSES = ['own_data', 'market_data', 'draft_write', 'live_write'] as const;
export type OwnAgentDataClass = (typeof OWN_AGENT_DATA_CLASSES)[number];

/** A standing rule's choice, strictest first (AG-guardrails-02). */
export const OWN_AGENT_RULE_CHOICES = ['hand_off', 'ask_before', 'act_on_request', 'act_without_asking'] as const;
export type OwnAgentRuleChoice = (typeof OWN_AGENT_RULE_CHOICES)[number];

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
  dataClass: z.enum(OWN_AGENT_DATA_CLASSES).nullable().default(null),
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

/**
 * EVALUATIONS (AG-testing-02). A person's own agent's test set is its cases: an input and the answer expected. An
 * evaluation runs every case `repeats` times on the test engine (never a model, never billed, no ledger call) and each
 * result is labelled TEST. A result passes when its reply contains the expected answer; the run's score is the share of
 * results that passed, in percent, and it passes when the score is at least the person's threshold. A blank threshold or
 * repeats count is refused with its name, and nothing is run or stored.
 */
export const OWN_AGENT_EVAL_LIMITS = { cases: 20, repeats: 10, text: 2000 } as const;

export const ownAgentEvalCaseSchema = z.object({ input: z.string(), expected: z.string() });
export type OwnAgentEvalCase = z.infer<typeof ownAgentEvalCaseSchema>;

/** One result: one case on one repeat, as the test engine answered it, and whether the reply held the expected answer. */
export const ownAgentEvalResultSchema = z.object({
  caseIndex: z.number().int().nonnegative(),
  repeat: z.number().int().positive(),
  input: z.string(),
  expected: z.string(),
  reply: z.string(),
  passed: z.boolean(),
  label: z.literal('TEST'),
});
export type OwnAgentEvalResult = z.infer<typeof ownAgentEvalResultSchema>;

/**
 * One evaluation run, the one its request id names. `score` is the passed share in percent as a decimal string, cut
 * (never rounded up) to two places; `verdict` compares the exact share with `threshold`.
 */
export const ownAgentEvalRunSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string(),
  cases: z.array(ownAgentEvalCaseSchema),
  repeats: z.number().int().positive(),
  threshold: z.string(),
  passed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  score: z.string(),
  verdict: z.enum(['pass', 'fail']),
  label: z.literal('TEST'),
  results: z.array(ownAgentEvalResultSchema),
  createdAt: z.string(),
});
export type OwnAgentEvalRun = z.infer<typeof ownAgentEvalRunSchema>;

/** One run in the list: its counts and verdict, with how many cases it ran but not the cases or results themselves. */
export const ownAgentEvalRunSummarySchema = ownAgentEvalRunSchema.omit({ cases: true, results: true }).extend({
  cases: z.number().int().positive(),
});
export type OwnAgentEvalRunSummary = z.infer<typeof ownAgentEvalRunSummarySchema>;

/**
 * `own.evals.get`: the agent's test set (empty until a run saves one), its newest run in full (null before the first),
 * and its runs newest first as summaries.
 */
export const ownAgentEvalsSchema = z.object({
  testSet: z.array(ownAgentEvalCaseSchema),
  latest: ownAgentEvalRunSchema.nullable(),
  runs: z.array(ownAgentEvalRunSummarySchema),
});
export type OwnAgentEvals = z.infer<typeof ownAgentEvalsSchema>;

/**
 * `own.evals.start` input. `repeats` and `threshold` arrive as the person typed them: blank is unset and refused
 * (`agents.eval.repeats_unset`, `agents.eval.threshold_unset`), never a default; a blank, long or extra case is refused
 * by the service by name (`agents.eval.case_blank`, `agents.eval.case_too_long`, `agents.eval.too_many_cases`). The
 * same request id again is the same run; with other cases, repeats or threshold it is refused `agents.request_id_replay`.
 */
export const ownAgentEvalStartSchema = z.object({
  id: z.string().min(1).max(64),
  requestId: z.string().min(8).max(200),
  // Loose on purpose: a blank case, a long one or one case too many reaches the service, which refuses it by name.
  cases: z.array(z.object({ input: z.string().max(20_000), expected: z.string().max(20_000) })).max(100),
  repeats: z.string().max(16),
  threshold: z.string().max(16),
});
export type OwnAgentEvalStart = z.infer<typeof ownAgentEvalStartSchema>;

/**
 * DRY RUNS AND TEST RUNS (AG-spend-04, AG-testing-01). A dry run checks one call of one of the agent's tools the way a
 * real call in a new session of the agent is checked (the caps that let the session open, the tool declared on the
 * agent, that it moves no value, the person's consent for its class, the owner's baseline, the person's rule, and the
 * tool's door) and says what the call would do. Nothing runs and nothing is billed: no session is opened, and no ledger entry, intent or
 * reservation is made. A dry run is a test run, labelled TEST and listed apart from live runs; live analytics leave test
 * runs out unless the person includes them.
 */
export const OWN_AGENT_DRY_RUN_CHECKS = [
  'caps_set',
  'tool_declared',
  'moves_no_value',
  'consent',
  'baseline',
  'rule',
  'door_wired',
] as const;
export type OwnAgentDryRunCheckName = (typeof OWN_AGENT_DRY_RUN_CHECKS)[number];

/** One check, in the order a real call meets it: passed, or not with the refusal code a real call would get. */
export const ownAgentDryRunCheckSchema = z.object({
  check: z.enum(OWN_AGENT_DRY_RUN_CHECKS),
  passed: z.boolean(),
  code: z.string().nullable(),
});
export type OwnAgentDryRunCheck = z.infer<typeof ownAgentDryRunCheckSchema>;

/**
 * What the call would do: run the tool once in a session of the agent (`run`), hold an approval request and run nothing
 * until the person approves (`ask`), or be refused with the first failing check's code (`refused`).
 */
export const ownAgentDryRunEffectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run'),
    tool: z.string(),
    module: z.string(),
    dataClass: z.enum(OWN_AGENT_DATA_CLASSES),
    input: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal('ask'),
    tool: z.string(),
    module: z.string(),
    dataClass: z.enum(OWN_AGENT_DATA_CLASSES),
    input: z.record(z.string(), z.string()),
  }),
  z.object({ kind: z.literal('refused'), tool: z.string(), code: z.string() }),
  /**
   * A tool that moves value, tested (AG-testing-01; J-agents-04 #2): what a call of it would do (`module` is where the
   * value would move). The test sends nothing: no ledger call is made, and no session, reservation or intent.
   */
  z.object({ kind: z.literal('would_move'), tool: z.string(), module: z.string(), input: z.record(z.string(), z.string()) }),
]);
export type OwnAgentDryRunEffect = z.infer<typeof ownAgentDryRunEffectSchema>;

/**
 * The engine a test run used and the engine this deployment runs the agent's live runs on. A test run always uses the
 * test engine (`test`: fixed replies from the input alone, no model, never billed), whatever the deployment's live engine
 * is: `sandbox` is the deterministic stand-in, `live` a connected model, `unknown` neither.
 */
export const OWN_AGENT_LIVE_ENGINES = ['sandbox', 'live', 'unknown'] as const;
export type OwnAgentLiveEngine = (typeof OWN_AGENT_LIVE_ENGINES)[number];

/** One row of a test run's log, in the order it happened; every row is labelled TEST. */
export const ownAgentTestLogRowSchema = z.object({
  step: z.enum(['asked', 'answered', 'billed']),
  text: z.string(),
  label: z.literal('TEST'),
});
export type OwnAgentTestLogRow = z.infer<typeof ownAgentTestLogRowSchema>;

const testRunBase = {
  id: z.string().uuid(),
  requestId: z.string(),
  /** Always `test`: a test run is never a live run. */
  mode: z.literal('test'),
  cost: z.literal('0'),
  assetId: z.string(),
  label: z.literal('TEST'),
  createdAt: z.string(),
};

/**
 * One test run of the person's own agent, never billed (cost 0) and labelled TEST:
 * - `dry_run`: one call of one of the agent's tools, checked (AG-spend-04);
 * - `engine_run`: the agent asked once on the test engine, its reply and its log (AG-testing-01; J-agents-04 #1);
 * - `tool_test`: a tool that moves value, tested: what it would do, with nothing sent (AG-testing-01; J-agents-04 #2).
 */
export const ownAgentTestRunSchema = z.discriminatedUnion('kind', [
  z.object({
    ...testRunBase,
    kind: z.literal('dry_run'),
    tool: z.string(),
    input: z.record(z.string(), z.string()),
    checks: z.array(ownAgentDryRunCheckSchema),
    effect: ownAgentDryRunEffectSchema,
  }),
  z.object({
    ...testRunBase,
    kind: z.literal('tool_test'),
    tool: z.string(),
    input: z.record(z.string(), z.string()),
    checks: z.array(ownAgentDryRunCheckSchema),
    effect: ownAgentDryRunEffectSchema,
  }),
  z.object({
    ...testRunBase,
    kind: z.literal('engine_run'),
    ask: z.string(),
    reply: z.string(),
    engine: z.literal('test'),
    liveEngine: z.enum(OWN_AGENT_LIVE_ENGINES),
    log: z.array(ownAgentTestLogRowSchema),
  }),
]);
export type OwnAgentTestRun = z.infer<typeof ownAgentTestRunSchema>;

/** `own.testRun` input: one question for the agent, answered on the test engine. The same request id again is that run. */
export const ownAgentTestRunStartSchema = z.object({
  id: z.string().min(1).max(64),
  requestId: z.string().min(8).max(200),
  ask: z.string().max(4000),
});
export type OwnAgentTestRunStart = z.infer<typeof ownAgentTestRunStartSchema>;

/** `own.toolTest` input: one tool that moves value. The same request id again is that test. */
export const ownAgentToolTestStartSchema = z.object({
  id: z.string().min(1).max(64),
  requestId: z.string().min(8).max(200),
  tool: z.string().min(1).max(120),
});
export type OwnAgentToolTestStart = z.infer<typeof ownAgentToolTestStartSchema>;

/** `own.dryRun` input: one call of one tool. The same request id again is the same dry run. */
export const ownAgentDryRunStartSchema = z.object({
  id: z.string().min(1).max(64),
  requestId: z.string().min(8).max(200),
  tool: z.string().min(1).max(120),
  input: z.record(z.string().max(64), z.string().max(4000)).refine((args) => Object.keys(args).length <= 8),
});
export type OwnAgentDryRunStart = z.infer<typeof ownAgentDryRunStartSchema>;

/**
 * `own.holds`: what this agent holds for the person across all its sessions, read from svc-agents' own tables: its
 * sessions, its spend reservations (any state) and its stored place intents. A dry run adds to none of them.
 */
export const ownAgentHoldsSchema = z.object({
  sessions: z.number().int().nonnegative(),
  reservations: z.number().int().nonnegative(),
  intents: z.number().int().nonnegative(),
});
export type OwnAgentHolds = z.infer<typeof ownAgentHoldsSchema>;

/**
 * `own.analytics`: the agent's runs by outcome and what they cost. Live runs only unless `includeTest` is true, which
 * adds the test runs (never billed, so the cost is the same). `includeTest` is false when not sent.
 */
export const ownAgentAnalyticsSchema = z.object({
  includeTest: z.boolean(),
  runs: z.number().int().nonnegative(),
  liveRuns: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Null when test runs are left out. */
  testRuns: z.number().int().nonnegative().nullable(),
  cost: z.string(),
  assetId: z.string(),
});
export type OwnAgentAnalytics = z.infer<typeof ownAgentAnalyticsSchema>;
