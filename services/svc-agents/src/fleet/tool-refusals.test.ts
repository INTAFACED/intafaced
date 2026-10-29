import { describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION_STATE,
  evaluateToolCall,
  parseGuardrail,
  toolRefusalCodes,
  type Guardrail,
  type SessionState,
} from './guardrails.js';
import { navigatorAgentGuardrail } from '../navigator/guardrail.js';

/**
 * `agent.get` publishes, per tool, the refusals a person can meet. The list is
 * only honest if it is exactly what `evaluateToolCall` can return: every code
 * listed is reachable from some session state, and no state reaches a code that
 * is not listed. This walks every state that matters to a tool call and
 * compares the two in both directions.
 */

const probe = (capacityMode: string | undefined, tools: unknown[], scopes: string[] = []) =>
  parseGuardrail({
    agentId: 'probe',
    version: 1,
    ...(capacityMode === undefined ? {} : { capacityMode }),
    scopes,
    tools,
    limits: {
      maxActionsPerSession: 5,
      maxOutputTokensPerCall: 512,
      maxSpendPerSession: '1',
      allowedModules: ['trade', 'bank'],
      allowedTasks: ['plan'],
    },
  });

const TOOLS = [
  { name: 'trade.quote', module: 'trade', mode: 'read' },
  { name: 'trade.order', module: 'trade', mode: 'write', maxCallsPerSession: 1, requiresApproval: true },
  { name: 'trade.cancel', module: 'trade', mode: 'write', maxCallsPerSession: 0 },
  { name: 'bank.withdraw', module: 'bank', mode: 'write' },
];

/** A snapshot written by an older build that granted a module it no longer allows; the parser would refuse it. */
const stale: Guardrail = {
  ...probe('confirm_each', [{ name: 'trade.quote', module: 'trade', mode: 'read' }]),
  limits: { ...probe('confirm_each', []).limits, allowedModules: ['bank'] },
};

const GUARDRAILS: [string, Guardrail][] = [
  ['confirm each', probe('confirm_each', TOOLS)],
  ['confirm each with the withdraw scope', probe('confirm_each', TOOLS, ['withdraw'])],
  ['research only', probe('research_only', TOOLS)],
  ['no mode named', probe(undefined, TOOLS)],
  ['an unknown mode', probe('everything', TOOLS)],
  ['navigator', navigatorAgentGuardrail()],
  ['a stale snapshot', stale],
];

function reachable(guardrail: Guardrail, tool: string): Set<string> {
  const states: SessionState[] = [
    EMPTY_SESSION_STATE,
    { ...EMPTY_SESSION_STATE, status: 'closed' },
    { ...EMPTY_SESSION_STATE, actionCount: guardrail.limits.maxActionsPerSession },
    { ...EMPTY_SESSION_STATE, toolCalls: { [tool]: 1_000 } },
    { ...EMPTY_SESSION_STATE, approvedTools: [tool] },
  ];
  const requests = [{}, { approved: true }, { idempotencyKey: 'intent-1' }, { approved: true, idempotencyKey: 'intent-1' }];
  const codes = new Set<string>();
  for (const state of states)
    for (const request of requests) {
      const decision = evaluateToolCall(guardrail, state, { tool, ...request });
      if (!decision.allowed) codes.add(decision.code);
    }
  return codes;
}

describe('toolRefusalCodes', () => {
  for (const [name, guardrail] of GUARDRAILS)
    for (const grant of guardrail.tools)
      it(`lists exactly what the runtime can refuse ${grant.name} with (${name})`, () => {
        const listed = toolRefusalCodes(guardrail, grant);
        expect(new Set(listed)).toEqual(reachable(guardrail, grant.name));
        expect(new Set(listed).size).toBe(listed.length);
      });

  it('names the reasons a person meets on a guarded write: its call budget, approval and a business key', () => {
    const g = probe('confirm_each', TOOLS);
    expect(
      toolRefusalCodes(
        g,
        g.tools.find((t) => t.name === 'trade.order')!,
      ),
    ).toEqual([
      'agents.session_closed',
      'agents.action_limit',
      'agents.tool_call_limit',
      'agents.approval_required',
      'agents.place_idempotency_required',
    ]);
  });

  it('stops at a rule that always refuses: a research-only agent never reaches approval on a write', () => {
    const g = probe('research_only', TOOLS);
    expect(
      toolRefusalCodes(
        g,
        g.tools.find((t) => t.name === 'trade.order')!,
      ),
    ).toEqual(['agents.session_closed', 'agents.action_limit', 'agents.mode_forbids_write']);
  });
});
