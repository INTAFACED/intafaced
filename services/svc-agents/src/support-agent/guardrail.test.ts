import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { EMPTY_SESSION_STATE, evaluateCompletion, evaluateToolCall, type SessionState } from '../fleet/guardrails.js';
import {
  isSupportMoneyTool,
  SUPPORT_MONEY_TOOLS,
  supportAgentGuardrail,
  supportDeclaredTools,
  supportDeclaredToolCount,
  supportMoneyDenylistCount,
  supportApprovalRequiredCount,
  supportGuardrailBoardCard,
  parseSupportGuardrailStatusLine,
  supportGuardrailStatusLineMatches,
  supportGuardrailExportHeader,
  supportGuardrailExportText,
  supportDeclaredInRange,
  supportMoneyDenylistComplete,
} from './guardrail.js';

const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...EMPTY_SESSION_STATE,
  ...overrides,
});

const completion = (task: string) => ({
  task,
  maxOutputTokens: 256,
  worstCaseCost: amt('0.01'),
});

describe('support agent Stage-1 guardrail', () => {
  const g = () => supportAgentGuardrail();

  it('allows read-only desk tools that are declared', () => {
    expect(evaluateToolCall(g(), state(), { tool: 'support.kb.search' })).toEqual({ allowed: true });
    expect(evaluateToolCall(g(), state(), { tool: 'support.ticket.read' })).toEqual({ allowed: true });
    expect(evaluateToolCall(g(), state(), { tool: 'identity.account.read' })).toEqual({ allowed: true });
  });

  it('the account projection is a read in identity — never a money module', () => {
    const account = g().tools.find((t) => t.name === 'identity.account.read');
    expect(account).toMatchObject({ module: 'identity', mode: 'read' });
    expect(account?.requiresApproval ?? false).toBe(false);
  });

  it('allows support.classify / support.reply completion tasks', () => {
    expect(evaluateCompletion(g(), state(), completion('support.classify'), 'IFC')).toEqual({ allowed: true });
    expect(evaluateCompletion(g(), state(), completion('support.reply'), 'IFC')).toEqual({ allowed: true });
  });

  it('refuses navigator / trade completion tasks', () => {
    expect(evaluateCompletion(g(), state(), completion('navigator.plan'), 'IFC')).toMatchObject({
      allowed: false,
      code: 'agents.task_not_allowed',
    });
  });

  it('refuses every money-path tool by undeclared default — not after run', () => {
    for (const tool of SUPPORT_MONEY_TOOLS) {
      expect(isSupportMoneyTool(tool)).toBe(true);
      expect(evaluateToolCall(g(), state(), { tool }), tool).toMatchObject({
        allowed: false,
        code: 'agents.tool_not_declared',
        userMessageKey: 'agents.refused.tool_not_declared',
      });
    }
  });

  it('never grants tools in trade/pay/bank/ledger modules', () => {
    const moneyModules = new Set(['trade', 'pay', 'bank', 'ledger', 'p2p']);
    for (const tool of g().tools) {
      expect(moneyModules.has(tool.module)).toBe(false);
    }
  });

  it('Stage-2 L3: ticket.comment is write + requiresApproval; refuse without approval', () => {
    const comment = g().tools.find((t) => t.name === 'support.ticket.comment');
    expect(comment).toMatchObject({ mode: 'write', requiresApproval: true });
    expect(evaluateToolCall(g(), state(), { tool: 'support.ticket.comment' })).toMatchObject({
      allowed: false,
    });
    expect(evaluateToolCall(g(), state({ approvedTools: ['support.ticket.comment'] }), { tool: 'support.ticket.comment' })).toEqual({
      allowed: true,
    });
    expect(evaluateToolCall(g(), state(), { tool: 'support.ticket.comment', approved: true })).toEqual({ allowed: true });
  });

  it('refuses support tools outside the grant list', () => {
    expect(evaluateToolCall(g(), state(), { tool: 'support.ticket.delete' })).toMatchObject({
      allowed: false,
      code: 'agents.tool_not_declared',
    });
  });

  it('allowing the identity module did not open the identity module', () => {
    for (const tool of ['identity.account.freeze', 'identity.session.read', 'identity.kyc.approve']) {
      expect(evaluateToolCall(g(), state(), { tool }), tool).toMatchObject({
        allowed: false,
        code: 'agents.tool_not_declared',
      });
    }
  });
});

describe('L3 wave50 support guardrail status/export', () => {
  it('board card and denylist honesty', () => {
    const g = supportAgentGuardrail();
    expect(supportDeclaredToolCount(g)).toBe(4);
    expect(supportDeclaredTools(g)).toContain('support.ticket.read');
    expect(supportDeclaredTools(g)).toContain('identity.account.read');
    expect(supportApprovalRequiredCount(g)).toBe(1);
    expect(supportMoneyDenylistCount()).toBe(SUPPORT_MONEY_TOOLS.length);
    expect(supportMoneyDenylistComplete()).toBe(true);
    expect(supportGuardrailBoardCard(g).agentId).toBe('support');
    expect(supportGuardrailStatusLineMatches(g)).toBe(true);
    expect(parseSupportGuardrailStatusLine('nope')).toBeNull();
    expect(supportGuardrailExportText(g).startsWith(supportGuardrailExportHeader())).toBe(true);
    expect(supportDeclaredInRange(1, 10, g)).toBe(true);
    expect(supportDeclaredInRange(10, 1, g)).toBe(false);
  });
});
