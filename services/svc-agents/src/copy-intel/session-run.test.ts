import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { AuditedAction } from '../fleet/audit.js';
import { evaluateToolCall, type Guardrail, type Refusal, type SessionState } from '../fleet/guardrails.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import type { SettlementResult } from '../metering/meter.js';
import { copyIntelAgentGuardrail } from './guardrail.js';
import { COPY_INTEL_AGENT_ID, runCopyIntelStatsSession } from './session-run.js';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-07T12:00:00.000Z');

function fixture(leaderId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    leaderId,
    realisedPnl: '12.5',
    closedTrades: 10,
    winningTrades: 6,
    windowStart: '2026-08-01T00:00:00.000Z',
    windowEnd: '2026-08-07T00:00:00.000Z',
    source: 'platform-fills',
    ...overrides,
  } as {
    leaderId: string;
    realisedPnl: string | null;
    closedTrades: number | null;
    winningTrades: number | null;
    windowStart: string;
    windowEnd: string;
    source: string;
  };
}

function fakeAction(tool: string, status: 'executed' | 'refused'): AuditedAction {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    sessionId: SESSION,
    userId: USER,
    agentId: COPY_INTEL_AGENT_ID,
    sequence: 0,
    kind: 'tool_call',
    status,
    tool,
    task: null,
    providerId: null,
    model: null,
    inputTokens: 0n,
    outputTokens: 0n,
    cost: 0n,
    refusalCode: null,
    userMessageKey: 'agents.action.executed',
    userMessageParams: {},
    inputDigest: null,
    outputDigest: null,
    prevHash: null,
    hash: 'h',
    occurredAt: NOW,
  };
}

class FakeRuntime {
  readonly toolCalls: string[] = [];
  readonly refusedCalls: string[] = [];
  openCalls = 0;
  settleCalls = 0;
  closeCalls = 0;
  closeThrows: Error | null = null;
  guardrail: Guardrail = copyIntelAgentGuardrail();
  settlements: SettlementResult[] = [];
  readonly chargedAmounts: bigint[] = [];

  async openSession(input: { userId: string; agentId: string }) {
    this.openCalls += 1;
    return {
      id: SESSION,
      userId: input.userId,
      agentId: input.agentId,
      guardrail: this.guardrail,
      guardrailVersion: this.guardrail.version,
      status: 'open' as const,
      metered: true,
      openedAt: NOW,
      closedAt: null,
    };
  }

  private state(): SessionState {
    const toolCalls: Record<string, number> = {};
    for (const t of this.toolCalls) toolCalls[t] = (toolCalls[t] ?? 0) + 1;
    return {
      status: 'open',
      actionCount: this.toolCalls.length + this.refusedCalls.length,
      toolCalls,
      spend: 0n,
      approvedTools: [],
    };
  }

  async act(input: { sessionId: string; tool: string; execute: () => Promise<unknown> }) {
    const decision = evaluateToolCall(this.guardrail, this.state(), { tool: input.tool });
    if (!decision.allowed) {
      this.refusedCalls.push(input.tool);
      throw new RefusedError(decision as Refusal, fakeAction(input.tool, 'refused'));
    }
    const result = await input.execute();
    this.toolCalls.push(input.tool);
    return { result, action: fakeAction(input.tool, 'executed') };
  }

  async settleSession(_sessionId: string): Promise<SettlementResult[]> {
    this.settleCalls += 1;
    for (const row of this.settlements) this.chargedAmounts.push(row.amount);
    return this.settlements;
  }

  async closeSession(_sessionId: string) {
    this.closeCalls += 1;
    if (this.closeThrows) throw this.closeThrows;
    return {
      id: SESSION,
      userId: USER,
      agentId: COPY_INTEL_AGENT_ID,
      guardrail: this.guardrail,
      guardrailVersion: this.guardrail.version,
      status: 'closed' as const,
      metered: true,
      openedAt: NOW,
      closedAt: NOW,
    };
  }
}

function runtimeOf(fake: FakeRuntime): AgentRuntime {
  return fake as unknown as AgentRuntime;
}

function baseInput(fake: FakeRuntime) {
  return {
    runtime: runtimeOf(fake),
    userId: USER,
    feeAssetId: 'IFC',
    plane: 'live' as const,
    now: NOW,
  };
}

describe('copy_intel.stats metered session run', () => {
  it('refuses live leader plane before opening a session — no invent stats', async () => {
    const fake = new FakeRuntime();
    const result = await runCopyIntelStatsSession({
      ...baseInput(fake),
      fixtures: [fixture('leader-a'), fixture('leader-b', { realisedPnl: '3.0', winningTrades: 2 })],
      leaderAllowlist: ['leader-a', 'leader-b'],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_leaders',
      userMessageKey: 'agents.copy_intel.unavailable',
    });
    expect(fake.openCalls).toBe(0);
    expect(fake.toolCalls).toEqual([]);
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
  });

  it('bills zero when live plane is refused — no invent fee share charge', async () => {
    const fake = new FakeRuntime();
    const result = await runCopyIntelStatsSession({ ...baseInput(fake), fixtures: [fixture('leader-a')] });

    expect(result.status).toBe('refuse');
    expect(result.metering.billedAmount).toBe('0');
    expect(result.metering.settlements).toEqual([]);
    expect(typeof result.metering.billedAmount).toBe('string');
    expect(fake.openCalls).toBe(0);
  });

  it('does not settle invented windows while the live plane is closed', async () => {
    const fake = new FakeRuntime();
    fake.settlements = [
      {
        sessionId: SESSION,
        windowId: 'w1',
        chargeKey: 'agent.usage:s:w1',
        amount: parseAmount('1.5'),
        chargeTxId: 'tx1',
        settled: true,
      },
      {
        sessionId: SESSION,
        windowId: 'w2',
        chargeKey: 'agent.usage:s:w2',
        amount: parseAmount('2.5'),
        chargeTxId: 'tx2',
        settled: true,
      },
    ];
    const result = await runCopyIntelStatsSession({ ...baseInput(fake), fixtures: [fixture('leader-a')] });
    expect(result).toMatchObject({ status: 'refuse', reason: 'no_live_leaders' });
    expect(result.metering.billedAmount).toBe('0');
    expect(fake.settleCalls).toBe(0);
  });

  it('refuses a dark copy plane before opening a metered session', async () => {
    const fake = new FakeRuntime();
    const result = await runCopyIntelStatsSession({
      ...baseInput(fake),
      plane: 'dark',
      fixtures: [fixture('leader-a')],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'copy_plane_dark',
      userMessageKey: 'agents.copy_intel.unavailable',
    });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
  });

  it('D26-P1-A5: refuses returns-ranked board before opening a session', async () => {
    const fake = new FakeRuntime();
    await expect(
      runCopyIntelStatsSession({
        ...baseInput(fake),
        fixtures: [fixture('leader-a')],
        rankBy: 'realisedPnl',
      }),
    ).rejects.toMatchObject({
      code: 'agents.refused',
      userMessageKey: 'agents.copy_intel.unavailable',
      userMessageParams: { reason: 'returns_ranked_board_forbidden', rankBy: 'realisedPnl' },
    });
    expect(fake.openCalls).toBe(0);
  });

  it('refuses live plane when port is unset and no fixtures are supplied', async () => {
    const fake = new FakeRuntime();
    const result = await runCopyIntelStatsSession({ ...baseInput(fake), fixtures: [] });
    expect(result).toMatchObject({ status: 'refuse', reason: 'no_live_leaders' });
    expect(fake.openCalls).toBe(0);
  });

  it('does not open a session to discover a missing live allowlist — even with a write budget', async () => {
    const fake = new FakeRuntime();
    fake.guardrail = copyIntelAgentGuardrail();
    (fake.guardrail as { limits: { maxActionsPerSession: number } }).limits.maxActionsPerSession = 2;

    const result = await runCopyIntelStatsSession({
      ...baseInput(fake),
      fixtures: [fixture('solo')],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_leaders',
      fixturesRefusedByGuardrail: 0,
      writesRefusedByGuardrail: 0,
    });
    expect(fake.openCalls).toBe(0);
    expect(fake.toolCalls).toEqual([]);
  });

  it('does not call tools when live leaders are not allowlisted', async () => {
    const fake = new FakeRuntime();
    fake.act = async () => {
      throw new Error('storage exploded');
    };
    const result = await runCopyIntelStatsSession({ ...baseInput(fake), fixtures: [fixture('a')] });
    expect(result).toMatchObject({ status: 'refuse', reason: 'no_live_leaders' });
    expect(fake.settleCalls).toBe(0);
    expect(fake.closeCalls).toBe(0);
  });

  it('never reaches trade.order or fee-share invent paths while live plane is closed', async () => {
    const fake = new FakeRuntime();
    await runCopyIntelStatsSession({ ...baseInput(fake), fixtures: [fixture('a'), fixture('b')] });

    expect(fake.toolCalls).toEqual([]);
    expect(fake.toolCalls.some((t) => t === 'trade.order' || t === 'ledger.post' || t.includes('fee'))).toBe(false);
  });

  it('does not settle again when close throws after the charge', async () => {
    const prevOpen = process.env.LIVE_TRADE_COPY_LEADER_PLANE_OPEN;
    const prevIds = process.env.LIVE_TRADE_COPY_LEADER_IDS;
    process.env.LIVE_TRADE_COPY_LEADER_PLANE_OPEN = 'true';
    process.env.LIVE_TRADE_COPY_LEADER_IDS = 'leader-a';
    const charge = parseAmount('1.25');
    try {
      const fake = new FakeRuntime();
      fake.settlements = [
        {
          sessionId: SESSION,
          windowId: 'w1',
          chargeKey: 'agent.usage:s:w1',
          amount: charge,
          chargeTxId: 'tx1',
          settled: true,
        },
      ];
      fake.closeThrows = new Error('close failed after charge');

      await expect(
        runCopyIntelStatsSession({
          ...baseInput(fake),
          fixtures: [fixture('leader-a')],
          leaderAllowlist: ['leader-a'],
          copyLeaderFixturesPort: { sample: async () => [fixture('leader-a')] },
        }),
      ).rejects.toThrow('close failed after charge');

      expect(fake.settleCalls).toBe(1);
      expect(fake.closeCalls).toBe(1);
      expect(fake.chargedAmounts).toEqual([1250000000000000000n]);
      expect(typeof fake.chargedAmounts[0]).toBe('bigint');
    } finally {
      if (prevOpen === undefined) delete process.env.LIVE_TRADE_COPY_LEADER_PLANE_OPEN;
      else process.env.LIVE_TRADE_COPY_LEADER_PLANE_OPEN = prevOpen;
      if (prevIds === undefined) delete process.env.LIVE_TRADE_COPY_LEADER_IDS;
      else process.env.LIVE_TRADE_COPY_LEADER_IDS = prevIds;
    }
  });
});
