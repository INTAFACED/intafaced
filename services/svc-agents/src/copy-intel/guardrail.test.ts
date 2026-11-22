import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { EMPTY_SESSION_STATE, evaluateCompletion, evaluateToolCall, type SessionState } from '../fleet/guardrails.js';
import {
  COPY_INTEL_MONEY_WRITE_TOOLS,
  copyIntelAgentGuardrail,
  isCopyIntelMoneyWriteTool,
  copyIntelDeclaredTools,
  copyIntelDeclaredToolCount,
  copyIntelMoneyDenylistCount,
  copyIntelGuardrailBoardCard,
  parseCopyIntelGuardrailStatusLine,
  copyIntelGuardrailStatusLineMatches,
  copyIntelGuardrailExportHeader,
  copyIntelGuardrailExportText,
  copyIntelMoneyDenylistComplete,
  copyIntelDeclaredInRange,
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

describe('copy-intel Stage-1 guardrail', () => {
  const g = () => copyIntelAgentGuardrail();

  it('allows copy_intel.stats and declared tools', () => {
    expect(evaluateCompletion(g(), state(), completion('copy_intel.stats'), 'IFC')).toEqual({ allowed: true });
    expect(evaluateToolCall(g(), state(), { tool: 'trade.copy.leaders.read' })).toEqual({ allowed: true });
    expect(evaluateToolCall(g(), state(), { tool: 'trade.copy.stats.write' })).toEqual({ allowed: true });
  });

  it('refuses trade placement / follow tools', () => {
    for (const tool of COPY_INTEL_MONEY_WRITE_TOOLS) {
      expect(isCopyIntelMoneyWriteTool(tool)).toBe(true);
      expect(evaluateToolCall(g(), state(), { tool }), tool).toMatchObject({
        allowed: false,
        code: 'agents.tool_not_declared',
      });
    }
  });
});

describe('L3 wave51 copy-intel guardrail status/export', () => {
  it('board card and denylist honesty', () => {
    const g = copyIntelAgentGuardrail();
    expect(copyIntelDeclaredToolCount(g)).toBe(2);
    expect(copyIntelDeclaredTools(g)).toContain('trade.copy.leaders.read');
    expect(copyIntelMoneyDenylistCount()).toBe(COPY_INTEL_MONEY_WRITE_TOOLS.length);
    expect(copyIntelMoneyDenylistComplete()).toBe(true);
    expect(copyIntelGuardrailBoardCard(g).agentId).toBe('copy-intel');
    expect(copyIntelGuardrailStatusLineMatches(g)).toBe(true);
    expect(parseCopyIntelGuardrailStatusLine('nope')).toBeNull();
    expect(copyIntelGuardrailExportText(g).startsWith(copyIntelGuardrailExportHeader())).toBe(true);
    expect(copyIntelDeclaredInRange(1, 5, g)).toBe(true);
    expect(copyIntelDeclaredInRange(5, 1, g)).toBe(false);
  });
});
