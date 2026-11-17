import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { EMPTY_SESSION_STATE, evaluateCompletion, evaluateToolCall, type SessionState } from '../fleet/guardrails.js';
import {
  isNavigatorMoneyWriteTool,
  NAVIGATOR_MONEY_WRITE_TOOLS,
  navigatorAgentGuardrail,
  navigatorDeclaredTools,
  navigatorDeclaredToolCount,
  navigatorMoneyDenylistCount,
  navigatorGuardrailBoardCard,
  parseNavigatorGuardrailStatusLine,
  navigatorGuardrailStatusLineMatches,
  navigatorGuardrailExportHeader,
  navigatorGuardrailExportLine,
  navigatorGuardrailExportText,
  navigatorDeclaredInRange,
  navigatorMoneyDenylistComplete,
  isNavigatorAllowlistedTool,
} from './guardrail.js';

const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...EMPTY_SESSION_STATE,
  ...overrides,
});

const completion = (task: string) => ({
  task,
  maxOutputTokens: 512,
  worstCaseCost: amt('0.05'),
});

describe('navigator agent Stage-1 guardrail', () => {
  const g = () => navigatorAgentGuardrail();

  it('allows declared read tools', () => {
    expect(evaluateToolCall(g(), state(), { tool: 'trade.quote' })).toEqual({ allowed: true });
    expect(evaluateToolCall(g(), state(), { tool: 'trade.markets.list' })).toEqual({ allowed: true });
    expect(evaluateToolCall(g(), state(), { tool: 'identity.session.read' })).toEqual({ allowed: true });
  });

  it('allows navigator.plan and navigator.tool_select tasks', () => {
    expect(evaluateCompletion(g(), state(), completion('navigator.plan'), 'IFC')).toEqual({ allowed: true });
    expect(evaluateCompletion(g(), state(), completion('navigator.tool_select'), 'IFC')).toEqual({
      allowed: true,
    });
  });

  it('refuses support / scanner completion tasks', () => {
    expect(evaluateCompletion(g(), state(), completion('support.reply'), 'IFC')).toMatchObject({
      allowed: false,
      code: 'agents.task_not_allowed',
    });
    expect(evaluateCompletion(g(), state(), completion('scanner.rank'), 'IFC')).toMatchObject({
      allowed: false,
      code: 'agents.task_not_allowed',
    });
  });

  it('refuses money-write tools as undeclared (before dispatch)', () => {
    for (const tool of NAVIGATOR_MONEY_WRITE_TOOLS) {
      expect(isNavigatorMoneyWriteTool(tool)).toBe(true);
      expect(evaluateToolCall(g(), state(), { tool }), tool).toMatchObject({
        allowed: false,
        code: 'agents.tool_not_declared',
        userMessageKey: 'agents.refused.tool_not_declared',
      });
    }
  });

  it('Stage-1 grants only read tools', () => {
    for (const tool of g().tools) {
      expect(tool.mode).toBe('read');
    }
  });

  it('refuses undeclared read tools outside the allowlist', () => {
    expect(evaluateToolCall(g(), state(), { tool: 'trade.fills.history' })).toMatchObject({
      allowed: false,
      code: 'agents.tool_not_declared',
    });
  });
});

describe('L3 wave50 navigator guardrail status/export', () => {
  it('board card and denylist honesty', () => {
    const g = navigatorAgentGuardrail();
    expect(navigatorDeclaredToolCount(g)).toBe(3);
    expect(navigatorDeclaredTools(g)).toContain('trade.quote');
    expect(navigatorMoneyDenylistCount()).toBe(NAVIGATOR_MONEY_WRITE_TOOLS.length);
    expect(navigatorMoneyDenylistComplete()).toBe(true);
    expect(navigatorGuardrailBoardCard(g).agentId).toBe('navigator');
    expect(navigatorGuardrailStatusLineMatches(g)).toBe(true);
    expect(parseNavigatorGuardrailStatusLine('nope')).toBeNull();
    expect(navigatorGuardrailExportText(g).startsWith(navigatorGuardrailExportHeader())).toBe(true);
    expect(navigatorGuardrailExportLine(g)).toContain('navigator,');
    expect(navigatorDeclaredInRange(1, 10, g)).toBe(true);
    expect(navigatorDeclaredInRange(10, 1, g)).toBe(false);
    expect(isNavigatorAllowlistedTool('trade.quote', g)).toBe(true);
    expect(isNavigatorAllowlistedTool('trade.fills.history', g)).toBe(false);
    expect(isNavigatorAllowlistedTool('ledger.post', g)).toBe(false);
  });
});
