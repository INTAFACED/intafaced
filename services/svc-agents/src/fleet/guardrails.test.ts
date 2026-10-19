import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import {
  EMPTY_SESSION_STATE,
  evaluateCompletion,
  evaluateToolCall,
  parseGuardrail,
  serialiseGuardrail,
  type Guardrail,
  type SessionState,
} from './guardrails.js';

/**
 * The guardrail policy, as pure functions.
 *
 * Every rule is `(guardrail, state, request) → decision`, which is what makes
 * this testable without a database and identical in every caller. The runtime
 * tests then only have to prove that the decision is consulted BEFORE execution
 * and that a refusal reaches the audit table.
 */

const BASE = {
  agentId: 'probe',
  version: 1,
  capacityMode: 'confirm_each',
  tools: [
    { name: 'trade.quote', module: 'trade', mode: 'read' },
    { name: 'trade.order', module: 'trade', mode: 'write', maxCallsPerSession: 1, requiresApproval: true },
    { name: 'trade.cancel', module: 'trade', mode: 'write', maxCallsPerSession: 0 },
  ],
  limits: {
    maxActionsPerSession: 5,
    maxOutputTokensPerCall: 512,
    maxSpendPerSession: '1',
    allowedModules: ['trade'],
    allowedTasks: ['plan'],
  },
};

const guardrail = (): Guardrail => parseGuardrail(BASE);
const state = (overrides: Partial<SessionState> = {}): SessionState => ({ ...EMPTY_SESSION_STATE, ...overrides });

describe('parseGuardrail', () => {
  it('round-trips through the jsonb form stored on a session', () => {
    const parsed = guardrail();
    expect(parseGuardrail(serialiseGuardrail(parsed))).toEqual(parsed);
  });

  it('parses the spend cap to a scaled bigint, never a float', () => {
    expect(guardrail().limits.maxSpendPerSession).toBe(amt('1'));
    expect(typeof guardrail().limits.maxSpendPerSession).toBe('bigint');
  });

  it('rejects a tool granted in a module the agent may not act in', () => {
    // A contradiction in a security policy resolves however the enforcement
    // code happens to be ordered. Reject it where it is written instead.
    expect(() =>
      parseGuardrail({
        ...BASE,
        tools: [{ name: 'bank.loan', module: 'bank', mode: 'write' }],
      }),
    ).toThrow(/not in allowedModules/);
  });

  it('rejects a duplicate tool grant', () => {
    expect(() =>
      parseGuardrail({
        ...BASE,
        tools: [
          { name: 'trade.quote', module: 'trade', mode: 'read' },
          { name: 'trade.quote', module: 'trade', mode: 'write' },
        ],
      }),
    ).toThrow(/declared once/);
  });

  it('rejects a module that is not in the platform registry', () => {
    expect(() => parseGuardrail({ ...BASE, limits: { ...BASE.limits, allowedModules: ['casino'] } })).toThrow();
  });

  it('rejects a product agent that grants a money-moving tool at parse time', () => {
    // Soft undeclared refuse is not enough — registration must fail closed.
    expect(() =>
      parseGuardrail({
        agentId: 'navigator',
        version: 1,
        tools: [
          { name: 'trade.quote', module: 'trade', mode: 'read' },
          { name: 'trade.order', module: 'trade', mode: 'write' },
        ],
        limits: {
          maxActionsPerSession: 5,
          maxOutputTokensPerCall: 512,
          maxSpendPerSession: '1',
          allowedModules: ['trade'],
          allowedTasks: ['navigator.plan'],
        },
      }),
    ).toThrow(/cannot grant money-moving tool "trade\.order"/);

    expect(() =>
      parseGuardrail({
        agentId: 'merchant',
        version: 1,
        tools: [{ name: 'pay.route.change', module: 'pay', mode: 'write' }],
        limits: {
          maxActionsPerSession: 5,
          maxOutputTokensPerCall: 512,
          maxSpendPerSession: '0.25',
          allowedModules: ['pay'],
          allowedTasks: ['merchant.watch'],
        },
      }),
    ).toThrow(/pay\.route\.change/);
  });

  it('still allows a test probe agent to grant trade.order (approval / budget tests)', () => {
    expect(() => parseGuardrail(BASE)).not.toThrow();
    expect(guardrail().tools.some((t) => t.name === 'trade.order')).toBe(true);
  });
});

describe('evaluateToolCall', () => {
  it('allows a declared tool', () => {
    expect(evaluateToolCall(guardrail(), state(), { tool: 'trade.quote' })).toEqual({ allowed: true });
  });

  it('refuses an undeclared tool — the default is no', () => {
    const decision = evaluateToolCall(guardrail(), state(), { tool: 'bank.withdraw' });
    expect(decision).toMatchObject({ allowed: false, code: 'agents.tool_not_declared' });
  });

  it('refuses a tool that needs approval until the user gives it', () => {
    const g = guardrail();
    expect(evaluateToolCall(g, state(), { tool: 'trade.order' })).toMatchObject({
      allowed: false,
      code: 'agents.approval_required',
    });
    expect(evaluateToolCall(g, state(), { tool: 'trade.order', approved: true, idempotencyKey: 'intent-1' })).toEqual({
      allowed: true,
    });
    // A session-scoped approval works too, for a surface that remembers one.
    expect(evaluateToolCall(g, state({ approvedTools: ['trade.order'] }), { tool: 'trade.order', idempotencyKey: 'intent-1' })).toEqual({
      allowed: true,
    });
  });

  it('refuses once a tool has hit its per-session call limit', () => {
    const decision = evaluateToolCall(guardrail(), state({ toolCalls: { 'trade.order': 1 } }), {
      tool: 'trade.order',
      approved: true,
    });
    expect(decision).toMatchObject({ allowed: false, code: 'agents.tool_call_limit' });
  });

  it('treats a zero call budget as "declared but disabled", not as unlimited', () => {
    // The most dangerous plausible bug in this file: `maxCallsPerSession: 0`
    // read as falsy would mean "no limit" on exactly the tool an operator was
    // trying to switch off.
    expect(evaluateToolCall(guardrail(), state(), { tool: 'trade.cancel' })).toMatchObject({
      allowed: false,
      code: 'agents.tool_call_limit',
    });
  });

  it('refuses every tool once the session action budget is spent', () => {
    expect(evaluateToolCall(guardrail(), state({ actionCount: 5 }), { tool: 'trade.quote' })).toMatchObject({
      allowed: false,
      code: 'agents.action_limit',
    });
  });

  it('refuses every tool on a closed session', () => {
    expect(evaluateToolCall(guardrail(), state({ status: 'closed' }), { tool: 'trade.quote' })).toMatchObject({
      allowed: false,
      code: 'agents.session_closed',
    });
  });

  it('refuses research-only and read-only before place/amend/cancel/withdraw', () => {
    for (const mode of ['research_only', 'read_only', 'draft_preview'] as const) {
      const g = parseGuardrail({ ...BASE, capacityMode: mode });
      expect(evaluateToolCall(g, state(), { tool: 'trade.order', approved: true, idempotencyKey: 'k' })).toMatchObject({
        allowed: false,
        code: 'agents.mode_forbids_write',
      });
      expect(evaluateToolCall(g, state(), { tool: 'trade.cancel' })).toMatchObject({
        allowed: false,
        code: 'agents.mode_forbids_write',
      });
    }
  });

  it('refuses live writes when capacity mode is missing or unknown — never defaults to live', () => {
    const missing = parseGuardrail({ ...BASE, capacityMode: undefined });
    expect(evaluateToolCall(missing, state(), { tool: 'trade.order', approved: true, idempotencyKey: 'k' })).toMatchObject({
      allowed: false,
      code: 'agents.mode_unknown',
    });
    const unknown = parseGuardrail({ ...BASE, capacityMode: 'live' });
    expect(evaluateToolCall(unknown, state(), { tool: 'trade.order', approved: true, idempotencyKey: 'k' })).toMatchObject({
      allowed: false,
      code: 'agents.mode_unknown',
    });
    // Read tools still run — missing mode is not a blanket session kill.
    expect(evaluateToolCall(missing, state(), { tool: 'trade.quote' })).toEqual({ allowed: true });
  });

  it('refuses withdraw unless a separate withdraw scope is on the grant', () => {
    const granted = parseGuardrail({
      ...BASE,
      tools: [
        ...BASE.tools,
        { name: 'bank.withdraw', module: 'bank', mode: 'write', requiresApproval: true },
        { name: 'bank.transfer', module: 'bank', mode: 'write', requiresApproval: true },
      ],
      limits: { ...BASE.limits, allowedModules: ['trade', 'bank'] },
    });
    expect(evaluateToolCall(granted, state(), { tool: 'bank.withdraw', approved: true })).toMatchObject({
      allowed: false,
      code: 'agents.withdraw_scope_required',
    });
    expect(evaluateToolCall(granted, state(), { tool: 'bank.transfer', approved: true })).toMatchObject({
      allowed: false,
      code: 'agents.withdraw_scope_required',
    });
    const scoped = parseGuardrail({
      ...BASE,
      scopes: ['withdraw'],
      tools: [{ name: 'bank.withdraw', module: 'bank', mode: 'write', requiresApproval: true }],
      limits: { ...BASE.limits, allowedModules: ['bank'] },
    });
    expect(evaluateToolCall(scoped, state(), { tool: 'bank.withdraw', approved: true })).toEqual({ allowed: true });
  });

  it('refuses a product agent that carries withdraw scope', () => {
    expect(() =>
      parseGuardrail({
        agentId: 'navigator',
        version: 1,
        scopes: ['withdraw'],
        tools: [{ name: 'trade.quote', module: 'trade', mode: 'read' }],
        limits: {
          maxActionsPerSession: 5,
          maxOutputTokensPerCall: 512,
          maxSpendPerSession: '1',
          allowedModules: ['trade'],
          allowedTasks: ['navigator.plan'],
        },
      }),
    ).toThrow(/cannot carry withdraw scope/);
  });

  it('refuses a place without an idempotency key', () => {
    expect(evaluateToolCall(guardrail(), state(), { tool: 'trade.order', approved: true })).toMatchObject({
      allowed: false,
      code: 'agents.place_idempotency_required',
    });
  });

  it('refuses a tool whose module was revoked after the snapshot was taken', () => {
    // Reachable only from an older jsonb snapshot; the enforcement point must
    // not assume its input came from the current parser.
    const stale: Guardrail = {
      ...guardrail(),
      limits: { ...guardrail().limits, allowedModules: [] },
    };
    expect(evaluateToolCall(stale, state(), { tool: 'trade.quote' })).toMatchObject({
      allowed: false,
      code: 'agents.module_not_allowed',
    });
  });
});

describe('evaluateCompletion', () => {
  const attempt = (overrides: Partial<{ task: string; maxOutputTokens: number; worstCaseCost: bigint }> = {}) => ({
    task: 'plan',
    maxOutputTokens: 256,
    worstCaseCost: amt('0.1'),
    ...overrides,
  });

  it('allows a task the agent is permitted to invoke', () => {
    expect(evaluateCompletion(guardrail(), state(), attempt(), 'IFC')).toEqual({ allowed: true });
  });

  it('refuses a task outside the agent’s declared list', () => {
    expect(evaluateCompletion(guardrail(), state(), attempt({ task: 'scanner.rank' }), 'IFC')).toMatchObject({
      allowed: false,
      code: 'agents.task_not_allowed',
      // Dedicated key — must not reuse tool_not_declared for a task refuse.
      userMessageKey: 'agents.refused.task_not_allowed',
      userMessageParams: { task: 'scanner.rank' },
    });
  });

  it('refuses a request for more output than the agent may produce', () => {
    expect(evaluateCompletion(guardrail(), state(), attempt({ maxOutputTokens: 4096 }), 'IFC')).toMatchObject({
      allowed: false,
      code: 'agents.output_limit',
    });
  });

  it('refuses on WORST-CASE cost, not expected cost', () => {
    // Spend so far is 0.95; this call could reach 0.1, taking the session to
    // 1.05 against a cap of 1. A ceiling that only catches the average is not a
    // ceiling — and the actual cost is unknowable until the tokens are gone.
    expect(evaluateCompletion(guardrail(), state({ spend: amt('0.95') }), attempt(), 'IFC')).toMatchObject({
      allowed: false,
      code: 'agents.spend_limit',
    });
  });

  it('allows a call that lands exactly on the cap', () => {
    expect(evaluateCompletion(guardrail(), state({ spend: amt('0.9') }), attempt(), 'IFC')).toEqual({ allowed: true });
  });

  it('treats a null cap as uncapped', () => {
    const uncapped = parseGuardrail({ ...BASE, limits: { ...BASE.limits, maxSpendPerSession: null } });
    expect(evaluateCompletion(uncapped, state({ spend: amt('1000000') }), attempt(), 'IFC')).toEqual({ allowed: true });
  });

  it('names the limit and the asset in the refusal parameters', () => {
    const decision = evaluateCompletion(guardrail(), state({ spend: amt('0.95') }), attempt(), 'IFC');
    expect(decision).toMatchObject({ allowed: false, userMessageParams: { limit: '1', asset: 'IFC' } });
  });
});
