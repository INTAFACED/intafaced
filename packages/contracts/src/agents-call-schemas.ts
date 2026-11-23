import { z } from 'zod';
import { AGENT_ALERT_MEASURES } from './agents-alerts.js';
import { routeChangeSchema } from './agents-routes.js';
import { actionOutcomeSchema } from './agents-review.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-agents's records share, copied from the service's router while its Rust port is in flight (the router keeps its own until the port's switch). */

/**
 * The operator's agent alert desk (AG-analytics-02, AG-guardrails-02; J-agents-16).
 *
 * Alert rules: a measure over every agent action svc-agents recorded (refusal rate and failure rate in percent of the
 * window's actions, or cost in the fee asset), a threshold the operator typed, a window length in minutes, and
 * optionally one agent. A blank threshold is refused by name and nothing is stored; 0 is a value like any other.
 *
 * The evaluator reads each rule's current window and the one before it (windows are aligned to the epoch by the
 * rule's length). A window with no actions has no rate: it fires nothing and is reported as having no rows, never as
 * 0%. A window whose measure is above the threshold writes one alert, keyed by rule and window start, so the evaluator
 * running again (the timer, a second "Evaluate now", two replicas) writes no second row for that window. An alert is
 * kept whatever happens to its delivery: no delivery vendor is connected to svc-agents, so every alert stays `pending`.
 *
 * The managed baseline is the owner's (`AGENTS_POLICY_BASELINE`); this desk shows it and sets this environment's
 * override per tool class, which may only narrow it. A rule may be checked against both before anyone stores it.
 * Nothing here moves value.
 */
export const ALERT_MEASURES = AGENT_ALERT_MEASURES;

/** The risk signals, each computed from stored rows (AG-registry-01). */
export const RISK_SIGNALS = ['no_owner', 'write_tool', 'no_spend_cap', 'never_run'] as const;

export const FLEET_STATUSES = ['active', 'quarantined', 'disabled_by_kind', 'disabled'] as const;

/**
 * The operator's agent fleet (AG-registry-01, AG-control-02): every agent on the platform in one registry, with its
 * owner, publisher, channels and risk signals read from stored rows, an audited CSV export, and the switches. The brake
 * is easy and the release is hard: one operator quarantines an agent or switches a whole kind off; two distinct
 * founders restore either. Every action and every export writes one `agent_fleet_audit` row on a business key, in the
 * same transaction as what it records, so a retried request writes nothing twice. No money moves here.
 *
 * An agent is named by a reference: `product:<agent_id>` for a registered product agent, `own:<uuid>` for an agent a
 * person built.
 */
export const FLEET_KINDS = ['customer_built', 'product'] as const;

export const filterInput = {
  riskSignal: z.enum(RISK_SIGNALS).optional(),
  status: z.enum(FLEET_STATUSES).optional(),
  kind: z.enum(FLEET_KINDS).optional(),
  ownerless: z.boolean().optional(),
};

export const switchSchema = z.object({
  reason: z.string(),
  setBy: z.string(),
  setAt: z.string(),
  restoreRequestedBy: z.string().nullable(),
});

export const fleetRowSchema = z.object({
  ref: z.string(),
  name: z.string().nullable(),
  kind: z.enum(FLEET_KINDS),
  ownerId: z.string().nullable(),
  publisherId: z.string().nullable(),
  channels: z.array(z.string()).nullable(),
  riskSignals: z.array(z.enum(RISK_SIGNALS)),
  status: z.enum(FLEET_STATUSES),
  lastRunAt: z.string().nullable(),
  quarantine: switchSchema.nullable(),
  kindSwitch: switchSchema.nullable(),
});

/** What an audit row records. */
export const FLEET_ACTIONS = [
  'export',
  'quarantine',
  'restore_request',
  'restore',
  'kill_kind',
  'restore_kind_request',
  'restore_kind',
  'reassign',
] as const;

export const requestId = z.string().min(8).max(200);

export const ref = z.string().min(1).max(120);

export const OUTCOMES = ['executed', 'refused', 'failed'] as const;

export const TOOL_MAX = 120;

export const readInput = z.object({
  userId: z.string().min(1).max(64),
  /** Optional so a missing reason reaches its named refusal, not a schema error. */
  reason: z.string().max(200).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  tool: z.string().min(1).max(TOOL_MAX).optional(),
  requestId: z.string().min(8).max(200),
});

export const actionView = z.object({
  id: z.string(),
  occurredAt: z.string(),
  kind: z.string(),
  tool: z.string(),
  outcome: z.enum(OUTCOMES),
  refusalCode: z.string().nullable(),
  inputDigest: z.string().nullable(),
});

export const changeSchema = routeChangeSchema;

export const idInput = z.object({ id: z.string().min(1).max(64) });

export const BACKGROUND_STATES = ['running', 'done', 'stopped'] as const;

export const ownBackgroundRunSchema = z.object({
  id: z.string().uuid(),
  ask: z.string(),
  state: z.enum(BACKGROUND_STATES),
  stepsDone: z.number().int(),
  stepsTotal: z.number().int(),
  stopCode: z.string().nullable(),
  mode: z.literal('test'),
  cost: z.literal('0'),
  label: z.literal('TEST'),
  startedAt: z.string(),
  updatedAt: z.string(),
});

export const byId = z.object({ runId: z.string().guid() }).strict();

/**
 * The internal tRPC surface (§1: "Fastify + tRPC (internal) / REST (public)").
 *
 * Two rules shape every procedure here.
 *
 * **Nothing leaves this service that a user may not see.** Outputs are declared
 * with `.output()` so the contract is validated on the way out, and the shapes
 * below carry routing task ids, model ALIASES and i18n keys — never a vendor
 * name, never an upstream error body, never a prompt (Doctrine §0.7, §10).
 *
 * **The log is the product.** `log.mine` and `session.log` return the same rows
 * an auditor would read, keyed for i18n, because §8.2's Agentic Law promises
 * the user a visible log and not a summary of one.
 *
 * A user always reads their own actions: every log query is scoped to
 * `ctx.principal.userId` rather than to a userId in the input. An agent audit
 * trail that one user can query for another is a privacy incident wearing a
 * feature's clothes.
 */
export const actionOutput = z.object({
  id: z.string().guid(),
  sessionId: z.string().guid(),
  agentId: z.string(),
  sequence: z.number().int(),
  kind: z.enum(['session_open', 'session_close', 'completion', 'embedding', 'tool_call', 'usage_settlement']),
  status: z.enum(['executed', 'refused', 'failed']),
  tool: z.string().nullable(),
  /** The routing task. Configuration, not a product name. */
  task: z.string().nullable(),
  /** The routing alias. The concrete upstream id never leaves the adapter. */
  model: z.string().nullable(),
  /** Counts as strings: they are bigint in the database and JSON has no bigint. */
  inputTokens: z.string(),
  outputTokens: z.string(),
  cost: z.string(),
  refusalCode: z.string().nullable(),
  /** i18n key + params. The surface renders; this service never ships prose. */
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.union([z.string(), z.number()])),
  occurredAt: z.string(),
});

export const sessionOutput = z.object({
  id: z.string().guid(),
  agentId: z.string(),
  guardrailVersion: z.number().int(),
  status: z.enum(['open', 'closed']),
  metered: z.boolean(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
});

export const REFUSAL_CODES = [
  'agents.tool_not_declared',
  'agents.tool_call_limit',
  'agents.module_not_allowed',
  'agents.task_not_allowed',
  'agents.action_limit',
  'agents.spend_limit',
  'agents.output_limit',
  'agents.approval_required',
  'agents.session_closed',
  'agents.mode_unknown',
  'agents.mode_forbids_write',
  'agents.withdraw_scope_required',
  'agents.place_idempotency_required',
  'agents.place_key_conflict',
  // Refused by the runtime before the engine, not by this policy: a route with no published rate, and a worst case
  // the person's available balance cannot cover, or one whose balance could not be read.
  'agents.price_unset',
  'agents.funds_insufficient',
  'agents.funds_unread',
  // Refused at the hold for an agent the person built: a run past one of the caps they set for it, or no caps set.
  'agents.spend.cap_exceeded',
  'agents.spend.cap_unset',
  // Refused at the hold for a team run past the member's allocation, a project limit or the pool, or with none set.
  'agents.team.allocation_exceeded',
  'agents.team.project_limit_exceeded',
  'agents.team.pool_exceeded',
  'agents.team.allocation_unset',
  // Refused at the hold once the month's spend of an agent the person built reached the hard limit they set for it.
  'agents.usage.hard_limit_reached',
  // Refused by the runtime while a usage window the person owes could not be paid: past the owner's overage grace, or
  // with no grace published.
  'agents.overage_grace_exceeded',
  'agents.overage_grace_unset',
  // Refused by the runtime when the session's current usage window is already sealed: it takes no more usage.
  'agents.window_sealed',
  // Refused by the runtime before the engine: a Copy-Intel request for a leader ranking by returns. Copy-Intel shows
  // disclosed stats from fills and never a returns board (D26-P1-A5).
  'agents.copy_intel.returns_board_refused',
] as const;

/**
 * What my agents did (J-agents-13): the dashboard, one run's trace, the activity log's outcome filter, count and whole
 * export, and usage by agent, user and task. Every procedure reads only the signed person's own rows (the user id comes
 * from the signed principal, never the body) and writes nothing; no money moves.
 */
export const outcome = actionOutcomeSchema;

export const businessId = z.string().uuid();

export const memberId = z.string().trim().min(1).max(128);

export const revision = z.number().int().positive().max(1_000_000);

export const amount = z.string().max(64).nullable().optional();

export type CoachRefusalCode =
  | 'agents.advice_forbidden'
  | 'agents.positions_not_decided'
  | 'agents.coach_curriculum_empty'
  | 'agents.coach_engine_unavailable'
  | 'agents.price_unset'
  | 'agents.spend_limit'
  | 'agents.funds_insufficient'
  | 'agents.request_id_replay'
  | 'agents.run_in_progress';

export const COACH_REFUSAL_CODES: readonly CoachRefusalCode[] = [
  'agents.advice_forbidden',
  'agents.positions_not_decided',
  'agents.coach_curriculum_empty',
  'agents.coach_engine_unavailable',
  'agents.price_unset',
  'agents.spend_limit',
  'agents.funds_insufficient',
  'agents.request_id_replay',
  'agents.run_in_progress',
];
