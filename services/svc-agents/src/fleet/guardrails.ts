import { z } from 'zod';
import { isModuleId, type ModuleId } from '@intafaced/config';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { CopyKey } from '../copy.js';

/**
 * GUARDRAILS — the Agentic Law's other half (§8.2).
 *
 * "each agent = defined toolset + guardrail schema + audit log."
 *
 * The audit log answers *what did it do*. The guardrail answers *what was it
 * ever allowed to do* — and it has to answer that BEFORE the tool runs, not
 * after. An after-the-fact check on a `write` tool is not a guardrail; it is a
 * post-mortem. Every rule below is evaluated against a proposed action while
 * the action is still a proposal.
 *
 * A guardrail is DECLARED, not inferred. An agent lists the tools it may call,
 * the modules it may touch, and the ceilings it runs under. A tool that is not
 * on the list is refused for the simplest possible reason — nobody said it
 * could — and that refusal is written to `agent_actions` exactly like a success
 * would be. §8.2 requires every action to reach the audit table, and the
 * actions worth auditing most are the ones that did not happen.
 *
 * The guardrail is snapshotted onto the session at open (see `runtime.ts`), the
 * same way `stakes.multiplier_bps` is snapshotted in svc-token: widening an
 * agent's powers must not retroactively legitimise a call an in-flight session
 * already made under narrower terms.
 */

export const TOOL_MODES = ['read', 'write'] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

/**
 * Session/grant capacity (PX-S16 / PTX-M28-R01).
 *
 * Missing or unknown never becomes live. Only confirm-each and bounded
 * autonomous may dispatch place/amend/cancel/withdraw — and even those still
 * need the tool declared, plus a separate withdraw scope for cash-out.
 */
export const AGENT_CAPACITY_MODES = ['research_only', 'read_only', 'draft_preview', 'confirm_each', 'bounded_autonomous'] as const;
export type AgentCapacityMode = (typeof AGENT_CAPACITY_MODES)[number];

/** The only scope that can ever unlock cash-out. Default is absent. */
export const AGENT_WITHDRAW_SCOPE = 'withdraw' as const;

/** Place / amend / cancel / withdraw — forbidden in research-only and read-only. */
export const LIVE_WRITE_TOOLS = ['trade.order', 'trade.place', 'trade.amend', 'trade.cancel', 'bank.withdraw', 'bank.transfer'] as const;

/** Live order placement — conversational repeat must reuse a business key. */
export const PLACE_TOOLS = ['trade.order', 'trade.place'] as const;

/** Cash-out / transfer-out. Never implied by a trade grant. */
export const WITHDRAW_TOOLS = ['bank.withdraw', 'bank.transfer'] as const;

export function isKnownCapacityMode(mode: string | undefined | null): mode is AgentCapacityMode {
  return mode != null && (AGENT_CAPACITY_MODES as readonly string[]).includes(mode);
}

export function capacityModeAllowsLiveWrite(mode: string | undefined | null): boolean {
  return mode === 'confirm_each' || mode === 'bounded_autonomous';
}

export function isLiveWriteTool(tool: string): boolean {
  return (LIVE_WRITE_TOOLS as readonly string[]).includes(tool);
}

export function isPlaceTool(tool: string): boolean {
  return (PLACE_TOOLS as readonly string[]).includes(tool);
}

export function isWithdrawTool(tool: string): boolean {
  return (WITHDRAW_TOOLS as readonly string[]).includes(tool);
}

export function hasWithdrawScope(scopes: readonly string[]): boolean {
  return scopes.includes(AGENT_WITHDRAW_SCOPE);
}

const moduleIdSchema = z.custom<ModuleId>((value) => typeof value === 'string' && isModuleId(value), {
  message: 'must be a module id declared in packages/config/src/modules.ts',
});

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'must be an unsigned decimal string with at most 18 decimal places');

export const toolGrantSchema = z.object({
  /** Tool id as the runtime dispatches it, e.g. 'trade.quote'. */
  name: z.string().min(1).max(120),
  /** Which module the tool acts in. Checked against `limits.allowedModules`. */
  module: moduleIdSchema,
  /**
   * `write` tools change platform state on the user's behalf. They are called
   * out separately so an operator can read a guardrail and see, at a glance,
   * the blast radius of the agent rather than having to know what each tool does.
   */
  mode: z.enum(TOOL_MODES),
  /** Per-session ceiling. Absent = unlimited within the session action limit. */
  maxCallsPerSession: z.number().int().min(0).optional(),
  /** §8.2 "exec inside user guardrails" — the user confirms before this runs. */
  requiresApproval: z.boolean().default(false),
});

export const guardrailLimitsSchema = z.object({
  /** Total actions — completions and tool calls — one session may perform. */
  maxActionsPerSession: z.number().int().min(1).max(10_000),
  /** Ceiling applied on top of whatever the route allows. The tighter wins. */
  maxOutputTokensPerCall: z.number().int().min(1).max(1_000_000),
  /**
   * Metered spend ceiling for the session, in the fee asset. Null = uncapped,
   * which is legitimate for an internal operator agent and never for a user's.
   */
  maxSpendPerSession: amountString.nullable().default(null),
  /** Modules the agent may act in at all. Empty = none. */
  allowedModules: z.array(moduleIdSchema).default([]),
  /** Routing tasks the agent may invoke. Empty = it may not call the engine. */
  allowedTasks: z.array(z.string().min(1)).default([]),
});

export const guardrailSchema = z.object({
  agentId: z.string().min(1).max(64),
  /** Bumped on every change. The session records which version bound it. */
  version: z.number().int().min(1),
  /**
   * Grant capacity. Optional on the wire so an old snapshot still parses —
   * evaluateToolCall then refuses live writes rather than defaulting to live.
   */
  capacityMode: z.string().min(1).max(64).optional(),
  /** Extra approved scopes. Empty = none. `withdraw` is never implied. */
  scopes: z.array(z.string().min(1).max(64)).default([]),
  tools: z.array(toolGrantSchema).default([]),
  limits: guardrailLimitsSchema,
});

export type GuardrailConfig = z.infer<typeof guardrailSchema>;

export interface ToolGrant {
  readonly name: string;
  readonly module: ModuleId;
  readonly mode: ToolMode;
  readonly maxCallsPerSession?: number;
  readonly requiresApproval: boolean;
}

export interface GuardrailLimits {
  readonly maxActionsPerSession: number;
  readonly maxOutputTokensPerCall: number;
  /** Parsed to `Amount`; null means uncapped. */
  readonly maxSpendPerSession: Amount | null;
  readonly allowedModules: readonly ModuleId[];
  readonly allowedTasks: readonly string[];
}

export interface Guardrail {
  readonly agentId: string;
  readonly version: number;
  readonly capacityMode?: string;
  readonly scopes: readonly string[];
  readonly tools: readonly ToolGrant[];
  readonly limits: GuardrailLimits;
}

/**
 * Tools that must never appear on a **product** agent guardrail.
 *
 * Test probes (`probe` / `thrifty`) may still grant `trade.order` to exercise
 * approval and budget rules. Product agent ids (navigator, support, scanner,
 * merchant, copy-intel) hard-fail at parse if a money-moving tool is granted —
 * undeclared refuse alone is not enough if registration accepts a grant.
 *
 * Pure stats/write-audit tools (e.g. copy-intel `trade.copy.stats.write`) are
 * not on this list — they do not move value.
 */
export const FLEET_HARD_MONEY_WRITE_TOOLS = [
  'ledger.post',
  'ledger.hold',
  'pay.refund',
  'pay.capture',
  'pay.route.change',
  'bank.transfer',
  'bank.withdraw',
  'bank.loan',
  'trade.order',
  'trade.place',
  'trade.amend',
  'trade.cancel',
  'trade.copy.follow',
  'trade.copy.unfollow',
  'p2p.release',
] as const;

/** Product agent ids that must never grant money-write tools. */
export const PRODUCT_AGENT_IDS = ['navigator', 'support', 'scanner', 'merchant', 'copy-intel'] as const;

export function isFleetHardMoneyWriteTool(tool: string): boolean {
  return (FLEET_HARD_MONEY_WRITE_TOOLS as readonly string[]).includes(tool);
}

export function isProductAgentId(agentId: string): boolean {
  return (PRODUCT_AGENT_IDS as readonly string[]).includes(agentId);
}

export function parseGuardrail(input: unknown): Guardrail {
  const config = guardrailSchema.parse(input);

  const seen = new Set<string>();
  for (const tool of config.tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate tool grant "${tool.name}" — a tool is declared once`);
    seen.add(tool.name);

    // A tool granted in a module the agent may not act in is a contradiction,
    // and contradictions in a security policy resolve however the code happens
    // to be ordered. Reject it at parse time instead.
    if (!config.limits.allowedModules.includes(tool.module)) {
      throw new Error(
        `Tool "${tool.name}" acts in module "${tool.module}", which is not in allowedModules — ` + `grant the module or drop the tool`,
      );
    }

    // Product agents: money-moving tools are never grantable. Test probes may
    // still declare them to exercise approval / budget enforcement.
    if (isProductAgentId(config.agentId) && isFleetHardMoneyWriteTool(tool.name)) {
      throw new Error(
        `Product agent "${config.agentId}" cannot grant money-moving tool "${tool.name}" — ` +
          `value moves only via packages/ledger-client recipes`,
      );
    }
  }

  if (isProductAgentId(config.agentId) && hasWithdrawScope(config.scopes)) {
    throw new Error(`Product agent "${config.agentId}" cannot carry withdraw scope — cash-out is a separate approved grant`);
  }

  return {
    agentId: config.agentId,
    version: config.version,
    ...(config.capacityMode === undefined ? {} : { capacityMode: config.capacityMode }),
    scopes: [...config.scopes],
    tools: config.tools.map((t) => ({
      name: t.name,
      module: t.module,
      mode: t.mode,
      requiresApproval: t.requiresApproval,
      ...(t.maxCallsPerSession === undefined ? {} : { maxCallsPerSession: t.maxCallsPerSession }),
    })),
    limits: {
      maxActionsPerSession: config.limits.maxActionsPerSession,
      maxOutputTokensPerCall: config.limits.maxOutputTokensPerCall,
      maxSpendPerSession: config.limits.maxSpendPerSession === null ? null : parseAmount(config.limits.maxSpendPerSession),
      allowedModules: config.limits.allowedModules,
      allowedTasks: config.limits.allowedTasks,
    },
  };
}

/** Serialise back to the jsonb form stored on the session. */
export function serialiseGuardrail(guardrail: Guardrail): GuardrailConfig {
  return {
    agentId: guardrail.agentId,
    version: guardrail.version,
    ...(guardrail.capacityMode === undefined ? {} : { capacityMode: guardrail.capacityMode }),
    scopes: [...guardrail.scopes],
    tools: guardrail.tools.map((t) => ({
      name: t.name,
      module: t.module,
      mode: t.mode,
      requiresApproval: t.requiresApproval,
      ...(t.maxCallsPerSession === undefined ? {} : { maxCallsPerSession: t.maxCallsPerSession }),
    })),
    limits: {
      maxActionsPerSession: guardrail.limits.maxActionsPerSession,
      maxOutputTokensPerCall: guardrail.limits.maxOutputTokensPerCall,
      maxSpendPerSession: guardrail.limits.maxSpendPerSession === null ? null : formatAmount(guardrail.limits.maxSpendPerSession),
      allowedModules: [...guardrail.limits.allowedModules],
      allowedTasks: [...guardrail.limits.allowedTasks],
    },
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

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
  // the person's available balance cannot cover (OWNER 107), or one whose balance could not be read.
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

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  readonly allowed: false;
  readonly code: RefusalCode;
  readonly userMessageKey: CopyKey;
  readonly userMessageParams: Readonly<Record<string, string | number>>;
}

export type GuardrailDecision = { readonly allowed: true } | Refusal;

const ALLOWED: GuardrailDecision = { allowed: true };

function refuse(code: RefusalCode, userMessageKey: CopyKey, userMessageParams: Readonly<Record<string, string | number>> = {}): Refusal {
  return { allowed: false, code, userMessageKey, userMessageParams };
}

/**
 * What the session has consumed so far.
 *
 * Passed in rather than read here so this module stays pure: every rule is a
 * function of (guardrail, state, request), which is what makes the whole policy
 * testable without a database and identical in every caller.
 */
export interface SessionState {
  readonly status: 'open' | 'closed';
  /** Actions already recorded, refusals included — a refused attempt is an action. */
  readonly actionCount: number;
  /** Executed calls per tool. Refusals do not count against a tool's own budget. */
  readonly toolCalls: Readonly<Record<string, number>>;
  /** Metered spend accrued so far this session, in the fee asset. */
  readonly spend: Amount;
  /** Which tools the user has explicitly approved for this session. */
  readonly approvedTools: readonly string[];
}

export const EMPTY_SESSION_STATE: SessionState = {
  status: 'open',
  actionCount: 0,
  toolCalls: {},
  spend: 0n,
  approvedTools: [],
};

export interface ToolCallRequest {
  readonly tool: string;
  /** Set when the caller is presenting a user's explicit confirmation. */
  readonly approved?: boolean;
  /** Stable business key for place tools. Conversational repeat must reuse it. */
  readonly idempotencyKey?: string;
}

export interface CompletionAttempt {
  readonly task: string;
  readonly maxOutputTokens: number;
  /** Cost this call could reach at its ceiling. Checked against the spend cap. */
  readonly worstCaseCost: Amount;
}

export function findTool(guardrail: Guardrail, name: string): ToolGrant | undefined {
  return guardrail.tools.find((t) => t.name === name);
}

/**
 * May this session act at all?
 *
 * Checked first everywhere, because a closed or exhausted session must refuse
 * uniformly — a rule that only some entry points enforce is not a rule.
 */
function evaluateSession(guardrail: Guardrail, state: SessionState): GuardrailDecision {
  if (state.status === 'closed') {
    return refuse('agents.session_closed', 'agents.refused.session_closed');
  }
  if (state.actionCount >= guardrail.limits.maxActionsPerSession) {
    return refuse('agents.action_limit', 'agents.refused.step_limit', { limit: guardrail.limits.maxActionsPerSession });
  }
  return ALLOWED;
}

/**
 * Every refusal `evaluateToolCall` can return for a declared tool under this
 * guardrail, in the order it checks them, so a person can read why a call
 * would be refused before granting a session. Derived from the same rules, plus
 * the runtime's own key-conflict refusal on order placement: a
 * rule that refuses this tool whatever the session state ends the list, since
 * nothing after it is ever reached.
 */
export function toolRefusalCodes(guardrail: Guardrail, grant: ToolGrant): RefusalCode[] {
  const codes: RefusalCode[] = ['agents.session_closed', 'agents.action_limit'];
  const always = (code: RefusalCode) => [...codes, code];
  if (isProductAgentId(guardrail.agentId) && isFleetHardMoneyWriteTool(grant.name)) return always('agents.tool_not_declared');
  if (!guardrail.limits.allowedModules.includes(grant.module)) return always('agents.module_not_allowed');
  if (isLiveWriteTool(grant.name)) {
    if (!isKnownCapacityMode(guardrail.capacityMode)) return always('agents.mode_unknown');
    if (!capacityModeAllowsLiveWrite(guardrail.capacityMode)) return always('agents.mode_forbids_write');
  }
  if (isWithdrawTool(grant.name) && !hasWithdrawScope(guardrail.scopes)) return always('agents.withdraw_scope_required');
  if (grant.maxCallsPerSession === 0) return always('agents.tool_call_limit');
  if (grant.maxCallsPerSession !== undefined) codes.push('agents.tool_call_limit');
  if (grant.requiresApproval) codes.push('agents.approval_required');
  // The runtime, not this policy, refuses a business key already claimed by another order (runtime.ts `placeKeyConflict`).
  if (isPlaceTool(grant.name)) codes.push('agents.place_idempotency_required', 'agents.place_key_conflict');
  return codes;
}

/** Guardrail decision for a proposed tool call. Evaluated before dispatch. */
export function evaluateToolCall(guardrail: Guardrail, state: SessionState, request: ToolCallRequest): GuardrailDecision {
  const session = evaluateSession(guardrail, state);
  if (!session.allowed) return session;

  const grant = findTool(guardrail, request.tool);
  if (!grant) {
    // The default is NO. An undeclared tool is refused rather than checked
    // against some looser rule, because "what can this agent do" must be
    // answerable by reading the guardrail alone.
    return refuse('agents.tool_not_declared', 'agents.refused.tool_not_declared', { tool: request.tool });
  }

  if (isProductAgentId(guardrail.agentId) && isFleetHardMoneyWriteTool(request.tool)) {
    // parseGuardrail rejects this grant. A snapshot that skipped the parser
    // must not dispatch it: capacity mode is not consulted for every money
    // write, and withdraw scope must not reopen cash-out on a product agent.
    return refuse('agents.tool_not_declared', 'agents.refused.tool_not_declared', { tool: request.tool });
  }

  if (!guardrail.limits.allowedModules.includes(grant.module)) {
    // Unreachable via `parseGuardrail`, which rejects this combination — kept
    // because a guardrail can also arrive as a jsonb snapshot written by an
    // older build, and the enforcement point must not assume its input was
    // produced by the current parser.
    return refuse('agents.module_not_allowed', 'agents.refused.module_not_allowed', { module: grant.module });
  }

  if (isLiveWriteTool(request.tool)) {
    // Missing/unknown must refuse closed — never fall through as live.
    if (!isKnownCapacityMode(guardrail.capacityMode)) {
      return refuse('agents.mode_unknown', 'agents.refused.mode_unknown', { tool: request.tool });
    }
    if (!capacityModeAllowsLiveWrite(guardrail.capacityMode)) {
      return refuse('agents.mode_forbids_write', 'agents.refused.mode_forbids_write', {
        tool: request.tool,
        mode: guardrail.capacityMode,
      });
    }
  }

  if (isWithdrawTool(request.tool) && !hasWithdrawScope(guardrail.scopes)) {
    return refuse('agents.withdraw_scope_required', 'agents.refused.withdraw_scope_required', { tool: request.tool });
  }

  if (grant.maxCallsPerSession !== undefined) {
    const used = state.toolCalls[request.tool] ?? 0;
    if (used >= grant.maxCallsPerSession) {
      return refuse('agents.tool_call_limit', 'agents.refused.tool_call_limit', {
        tool: request.tool,
        limit: grant.maxCallsPerSession,
      });
    }
  }

  if (grant.requiresApproval && !request.approved && !state.approvedTools.includes(request.tool)) {
    return refuse('agents.approval_required', 'agents.refused.approval_required', { tool: request.tool });
  }

  if (isPlaceTool(request.tool) && !(request.idempotencyKey ?? '').trim()) {
    return refuse('agents.place_idempotency_required', 'agents.refused.place_idempotency_required', { tool: request.tool });
  }

  return ALLOWED;
}

/** Guardrail decision for a proposed engine call. Evaluated before routing dispatch. */
export function evaluateCompletion(
  guardrail: Guardrail,
  state: SessionState,
  attempt: CompletionAttempt,
  feeAssetId: string,
): GuardrailDecision {
  const session = evaluateSession(guardrail, state);
  if (!session.allowed) return session;

  if (!guardrail.limits.allowedTasks.includes(attempt.task)) {
    return refuse('agents.task_not_allowed', 'agents.refused.task_not_allowed', { task: attempt.task });
  }

  if (attempt.maxOutputTokens > guardrail.limits.maxOutputTokensPerCall) {
    return refuse('agents.output_limit', 'agents.refused.output_limit', { limit: guardrail.limits.maxOutputTokensPerCall });
  }

  const cap = guardrail.limits.maxSpendPerSession;
  if (cap !== null) {
    // Checked against the call's WORST CASE, not its expected cost. A ceiling
    // that can be exceeded by one unlucky generation is not a ceiling, and the
    // cost is only knowable after the tokens have already been spent.
    if (state.spend + attempt.worstCaseCost > cap) {
      return refuse('agents.spend_limit', 'agents.refused.spend_limit', { limit: formatAmount(cap), asset: feeAssetId });
    }
  }

  return ALLOWED;
}

/** Convenience for the audit row: the tool/task a decision was about. */
export function refusalSummary(refusal: Refusal): string {
  return `${refusal.code}(${Object.entries(refusal.userMessageParams)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')})`;
}
