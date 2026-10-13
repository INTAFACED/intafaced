import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { AuditedAction } from '../fleet/audit.js';
import { evaluateToolCall, type Guardrail, type Refusal, type SessionState } from '../fleet/guardrails.js';
import { AgentError } from '../errors.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import type { SettlementResult } from '../metering/meter.js';
import { scannerAgentGuardrail, SCANNER_DATA_TOOLS } from './guardrail.js';
import { runScannerRankSession, SCANNER_AGENT_ID, SCANNER_TICKER_TOOL } from './session-run.js';
import type { SpotTickersPort } from './spot-tickers-port.js';
import { SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL, SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW } from './signal-inputs-law.js';

/**
 * The metered `scanner.rank` run.
 *
 * Postgres is doubled here; the POLICY is not. The double calls the real
 * `evaluateToolCall` against the real `scannerAgentGuardrail()`, and the run
 * under test calls the real data tools and the real Stage-1 ranker. What is
 * faked is row storage — `runtime.test.ts` owns the database properties
 * (append-only, the window seal, the unique request id) against real Postgres,
 * and re-faking them here would only test the fake.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-07T12:00:00.000Z');

const law = {
  published: true as const,
  matrix: { free: { maxSignals: 5, tools: [...SCANNER_DATA_TOOLS] } },
};

function ticker(marketId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    marketId,
    last: '100',
    volume24h: '1000',
    change24hBps: 50,
    asOf: '2026-08-07T11:59:30.000Z',
    maxAgeMs: 120_000,
    ...overrides,
  } as {
    marketId: string;
    last: string | null;
    volume24h: string | null;
    change24hBps: number | null;
    asOf: string;
    maxAgeMs: number;
  };
}

function fakeAction(tool: string, status: 'executed' | 'refused'): AuditedAction {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    sessionId: SESSION,
    userId: USER,
    agentId: SCANNER_AGENT_ID,
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

/**
 * A runtime double that enforces the real guardrail.
 *
 * `settlements` is what the meter would hand back; the default is `[]`, which
 * is what a real scanner run produces — it never calls the engine, so it opens
 * no usage window and there is nothing to settle.
 */
class FakeRuntime {
  readonly toolCalls: string[] = [];
  readonly refusedCalls: string[] = [];
  openCalls = 0;
  settleCalls = 0;
  closeCalls = 0;
  guardrail: Guardrail = scannerAgentGuardrail();
  settlements: SettlementResult[] = [];

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
    return this.settlements;
  }

  async closeSession(_sessionId: string) {
    this.closeCalls += 1;
    return {
      id: SESSION,
      userId: USER,
      agentId: SCANNER_AGENT_ID,
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

function portOf(tickers: ReturnType<typeof ticker>[]): SpotTickersPort {
  return { sample: async () => tickers };
}

function baseInput(fake: FakeRuntime) {
  return {
    runtime: runtimeOf(fake),
    userId: USER,
    feeAssetId: 'IFC',
    plane: 'live' as const,
    tierLaw: law,
    signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
    userTier: 'free',
    now: NOW,
  };
}

function liveWithPort(fake: FakeRuntime, tickers: ReturnType<typeof ticker>[]) {
  return { ...baseInput(fake), tickers, spotTickersPort: portOf(tickers) };
}

describe('scanner.rank metered session run', () => {
  it('ranks through the runtime, then settles and closes the session', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...liveWithPort(fake, [
        ticker('btc-usdt', { volume24h: '100', change24hBps: 10 }),
        ticker('eth-usdt', { volume24h: '5000', change24hBps: 200 }),
      ]),
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    // The strongest signal wins on the pure ranker's terms, unchanged.
    expect(result.signals[0]?.marketId).toBe('eth-usdt');
    expect(result.tickersAccepted).toBe(2);
    expect(result.tickersRefusedByTool).toBe(0);
    expect(result.tickersRefusedByGuardrail).toBe(0);

    // One audited tool call per ticker — the guardrail saw every fetch.
    expect(fake.toolCalls).toEqual([SCANNER_TICKER_TOOL, SCANNER_TICKER_TOOL]);
    expect(fake.openCalls).toBe(1);
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
    expect(result.metering.sessionId).toBe(SESSION);
    expect(result.metering.sessionClosed).toBe(true);
  });

  it('bills zero for a run that never called the engine, and does not invent a charge', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession(liveWithPort(fake, [ticker('btc-usdt')]));

    expect(result.metering.billedAmount).toBe('0');
    expect(result.metering.settlements).toEqual([]);
    expect(result.metering.assetId).toBe('IFC');
    // Money is a decimal string on the wire, never a number.
    expect(typeof result.metering.billedAmount).toBe('string');
  });

  it('reports what the meter settled as decimal strings, summed in bigint', async () => {
    const fake = new FakeRuntime();
    fake.settlements = [
      {
        sessionId: SESSION,
        windowId: '2026-08-07T12:00',
        chargeKey: 'agent.usage:s:w1',
        amount: parseAmount('1.5'),
        chargeTxId: 'tx1',
        settled: true,
      },
      {
        sessionId: SESSION,
        windowId: '2026-08-07T12:05',
        chargeKey: 'agent.usage:s:w2',
        amount: parseAmount('2.5'),
        chargeTxId: 'tx2',
        settled: true,
      },
    ];

    const result = await runScannerRankSession(liveWithPort(fake, [ticker('btc-usdt')]));

    // 1.5 + 2.5 = 4 at the ledger's scale — summed as bigint, formatted once.
    expect(result.metering.billedAmount).toBe('4');
    expect(result.metering.settlements.map((s) => s.amount)).toEqual(['1.5', '2.5']);
    expect(result.metering.settlements.every((s) => typeof s.amount === 'string')).toBe(true);
  });

  it('refuses a dark plane before opening a metered session', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({ ...baseInput(fake), plane: 'dark', tickers: [ticker('btc-usdt')] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'market_plane_dark',
      userMessageKey: 'agents.scanner.unavailable',
    });
    // Nothing opened means nothing to bill for the platform's own darkness.
    expect(fake.openCalls).toBe(0);
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
  });

  it('D26-P1-A3: refuses blank P0-11 signal-inputs law before opening a session', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...baseInput(fake),
      signalInputsLaw: null,
      tickers: [ticker('btc-usdt')],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'signal_inputs_law_blank',
      userMessageKey: 'agents.scanner.signal_inputs_closed',
      residual: SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL,
    });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
  });

  it('refuses an unpublished tier law before opening a metered session', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({ ...baseInput(fake), tierLaw: null, tickers: [ticker('btc-usdt')] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.scanner.tier_closed',
    });
    expect(fake.openCalls).toBe(0);
  });

  it('refuses when the tier does not grant the ticker tool', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...baseInput(fake),
      tierLaw: { published: true, matrix: { free: { maxSignals: 3, tools: ['trade.markets.list'] } } },
      tickers: [ticker('btc-usdt')],
    });

    expect(result).toMatchObject({ status: 'refuse', reason: 'tier_not_granted', userMessageKey: 'agents.scanner.tier_closed' });
    expect(fake.openCalls).toBe(0);
  });

  it('live HTTP tickers without published limit refuses tickers_limit_unset — never invent 500', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...baseInput(fake),
      tickers: [ticker('btc-usdt')],
      spotTickersPort: {
        sample: async () => {
          throw new AgentError(
            'Tickers page limit is unset — pass limit (never invent 500)',
            'agents.tickers_limit_unset',
            'agents.scanner.tickers_limit_unset',
          );
        },
      },
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tickers_limit_unset',
      userMessageKey: 'agents.scanner.tickers_limit_unset',
    });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.sessionId).toBeNull();
  });

  it('live without a tickers port refuses no_live_tickers — body tickers are not live truth', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...baseInput(fake),
      tickers: [ticker('btc-usdt', { last: '999999', volume24h: '999999', change24hBps: 9999 })],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_tickers',
      userMessageKey: 'agents.scanner.unavailable',
    });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
  });

  it('live empty port refuses no_live_tickers — never a fake zero-filled ticker', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...baseInput(fake),
      tickers: [ticker('btc-usdt')],
      spotTickersPort: { sample: async () => [] },
    });

    expect(result).toMatchObject({ status: 'refuse', reason: 'no_live_tickers' });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.billedAmount).toBe('0');
  });

  it('live throwing port refuses no_live_tickers before a session', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...baseInput(fake),
      tickers: [ticker('btc-usdt')],
      spotTickersPort: {
        sample: async () => {
          throw new Error('spot quotes unavailable');
        },
      },
    });

    expect(result).toMatchObject({ status: 'refuse', reason: 'no_live_tickers' });
    expect(fake.openCalls).toBe(0);
    expect(result.metering.sessionId).toBeNull();
  });

  it('live rank uses port samples and ignores invented request-body tickers', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...baseInput(fake),
      tickers: [ticker('invented-usdt', { volume24h: '999999', change24hBps: 9999 })],
      spotTickersPort: portOf([ticker('eth-usdt', { volume24h: '5000', change24hBps: 200 })]),
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.signals.map((s) => s.marketId)).toEqual(['eth-usdt']);
    expect(result.signals.some((s) => s.marketId === 'invented-usdt')).toBe(false);
  });

  it('live without a tickers port refuses no_live_tickers even when body tickers are empty', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({ ...baseInput(fake), tickers: [] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_tickers',
      userMessageKey: 'agents.scanner.unavailable',
    });
    expect(fake.openCalls).toBe(0);
  });

  it('drops a ticker the data tool refuses instead of filling it in', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...liveWithPort(fake, [
        ticker('btc-usdt'),
        ticker('ghost-usdt', { last: null }), // blank last stays out of the live sample
        ticker('stale-usdt', { asOf: '2026-08-07T00:00:00.000Z' }), // older than maxAgeMs — the tool refuses this row
      ]),
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tickersAccepted).toBe(1);
    // The stale row is the only one the tool saw and refused. The null last never reached it.
    expect(result.tickersRefusedByTool).toBe(1);
    expect(result.signals.map((s) => s.marketId)).toEqual(['btc-usdt']);
  });

  it('refuses the whole run when every ticker was refused — no invented list', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...liveWithPort(fake, [
        ticker('a-usdt', { last: null }), // a null last is absent from the live sample
        ticker('b-usdt', { volume24h: null }), // live last; the tool refuses the incomplete row
      ]),
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_tickers',
      userMessageKey: 'agents.scanner.unavailable',
      tickersRefusedByTool: 1,
    });
    // The session it opened is still settled and closed.
    expect(fake.openCalls).toBe(1);
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('counts a guardrail refusal instead of ranking around it', async () => {
    const fake = new FakeRuntime();
    // A guardrail whose action budget allows exactly one call.
    fake.guardrail = scannerAgentGuardrail();
    (fake.guardrail as { limits: { maxActionsPerSession: number } }).limits.maxActionsPerSession = 1;

    const result = await runScannerRankSession({
      ...liveWithPort(fake, [ticker('btc-usdt'), ticker('eth-usdt'), ticker('sol-usdt')]),
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tickersAccepted).toBe(1);
    expect(result.tickersRefusedByGuardrail).toBe(2);
    expect(fake.refusedCalls).toHaveLength(2);
    // Still settled and closed despite the refusals.
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('honours the tier depth cap rather than the caller', async () => {
    const fake = new FakeRuntime();
    const result = await runScannerRankSession({
      ...liveWithPort(fake, [
        ticker('btc-usdt', { volume24h: '100', change24hBps: 10 }),
        ticker('eth-usdt', { volume24h: '5000', change24hBps: 200 }),
      ]),
      tierLaw: { published: true, matrix: { free: { maxSignals: 1, tools: [...SCANNER_DATA_TOOLS] } } },
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.maxSignals).toBe(1);
    expect(result.signals).toHaveLength(1);
  });

  it('settles and closes even when the run throws', async () => {
    const fake = new FakeRuntime();
    const boom = new Error('storage exploded');
    fake.act = async () => {
      throw boom;
    };

    await expect(runScannerRankSession(liveWithPort(fake, [ticker('btc-usdt')]))).rejects.toThrow('storage exploded');

    // No leaked open session, no unbilled window left for a sweep nobody runs.
    expect(fake.settleCalls).toBe(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('only ever asks for the declared read tool — never a money-write one', async () => {
    const fake = new FakeRuntime();
    await runScannerRankSession(liveWithPort(fake, [ticker('btc-usdt'), ticker('eth-usdt')]));

    expect(new Set(fake.toolCalls)).toEqual(new Set([SCANNER_TICKER_TOOL]));
    expect(fake.toolCalls.some((t) => t.startsWith('ledger.') || t.startsWith('trade.order'))).toBe(false);
  });
});
