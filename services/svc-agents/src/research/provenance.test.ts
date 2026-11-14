/**
 * RC-agents-09 (J-agents-10 #4): a Navigator answer about a market carries where its facts came from, built by the
 * service, never by the model: the sources it read itself, the venue's observation time, the environment, the
 * assumptions, the uncertainty level from the owner's scale, and every sentence that cites no source. A blank scale or a
 * market that cannot be read refuses before the run row and the engine, so nothing runs and nothing is charged.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { researchProvenanceSchema } from '@intafaced/contracts/agents-research';
import { createAgentsRouter, type AgentsRouterDeps } from '../router.js';
import type { AuditedAction } from '../fleet/audit.js';
import type { SessionRecord, ThinkResult } from '../runtime.js';
import { createMemoryRunStore } from '../runs/memory-store.js';
import type { NavigatorTradeDataPort } from '../navigator/trade-data-port.js';
import {
  buildProvenance,
  namedMarkets,
  parseUncertaintyScale,
  prepareResearch,
  researchEnvironment,
  splitClaims,
  RESEARCH_MAX_MARKETS,
} from './provenance.js';

const SCALE = ['TEST low', 'TEST medium', 'TEST high'];
const OBSERVED = '2026-11-14T08:00:00.000Z';

/** A trade plane that knows the markets in `last` and reads each one's last price at `asOf`. */
function port(last: Record<string, string | null>, asOf = OBSERVED): NavigatorTradeDataPort & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    listMarkets: async () => [],
    quote: async (marketId) => {
      reads.push(marketId);
      if (!(marketId in last)) throw new Error('trade unreachable');
      return { marketId, last: last[marketId] ?? null, asOf, maxAgeMs: 60_000 };
    },
  };
}

describe('namedMarkets', () => {
  it('finds each market the ask names, once, in order', () => {
    expect(namedMarkets('TEST: what moved BTC/USDT today, and ETH/USDT? Also BTC/USDT again.')).toEqual(['BTC/USDT', 'ETH/USDT']);
  });
  it('an ask that names no market is not research', () => {
    for (const ask of ['Where do I place a limit order?', 'TEST: why was my agent request refused?', 'buy and/or sell', 'btc/usdt'])
      expect(namedMarkets(ask)).toEqual([]);
  });
  it('reads at most RESEARCH_MAX_MARKETS markets', () => {
    const ask = ['A1/B1', 'A2/B2', 'A3/B3', 'A4/B4', 'A5/B5', 'A6/B6'].join(' ');
    expect(namedMarkets(ask)).toHaveLength(RESEARCH_MAX_MARKETS);
  });
});

describe('parseUncertaintyScale', () => {
  it('blank is unset', () => {
    for (const raw of [undefined, null, '', '  ']) expect(parseUncertaintyScale(raw)).toBeNull();
  });
  it('reads labels lowest first', () => {
    expect(parseUncertaintyScale('TEST low, TEST medium ,TEST high')).toEqual(SCALE);
  });
  it('a malformed scale stops the service rather than guessing', () => {
    for (const raw of ['only one', 'a,,b', 'a,a']) expect(() => parseUncertaintyScale(raw)).toThrow(/at least two distinct/);
  });
});

describe('researchEnvironment', () => {
  it('names where the data is', () => {
    expect(researchEnvironment('dev')).toBe('TEST');
    expect(researchEnvironment('test')).toBe('TEST');
    expect(researchEnvironment('staging')).toBe('testnet');
    expect(researchEnvironment('prod')).toBe('live');
  });
});

describe('prepareResearch', () => {
  it('reads every named market itself, as numbered sources with the venue observation time', async () => {
    const trade = port({ 'btc-usdt': '64000.5', 'eth-usdt': '3100' });
    const plan = await prepareResearch({ ask: 'TEST: BTC/USDT vs ETH/USDT', port: trade, scale: SCALE, environment: 'TEST' });
    expect(trade.reads).toEqual(['btc-usdt', 'eth-usdt']);
    expect(plan!.sources).toEqual([
      { id: 'S1', market: 'BTC/USDT', measure: 'last_price', value: '64000.5', observedAt: OBSERVED },
      { id: 'S2', market: 'ETH/USDT', measure: 'last_price', value: '3100', observedAt: OBSERVED },
    ]);
    expect(plan!.system).toContain('[S1] BTC/USDT last traded price 64000.5, observed at 2026-11-14T08:00:00.000Z (TEST data).');
  });

  it('no market named: null, and nothing is read', async () => {
    const trade = port({});
    expect(await prepareResearch({ ask: 'Where do I stake?', port: trade, scale: null, environment: 'TEST' })).toBeNull();
    expect(trade.reads).toEqual([]);
  });

  it('a blank scale refuses agents.uncertainty_scale_unset before any read', async () => {
    const trade = port({ 'btc-usdt': '1' });
    await expect(prepareResearch({ ask: 'BTC/USDT', port: trade, scale: null, environment: 'TEST' })).rejects.toMatchObject({
      code: 'agents.uncertainty_scale_unset',
    });
    expect(trade.reads).toEqual([]);
  });

  it('a market that cannot be read, or has no last price, refuses agents.provenance_missing', async () => {
    for (const trade of [port({}), port({ 'btc-usdt': null }), undefined]) {
      await expect(prepareResearch({ ask: 'BTC/USDT', port: trade, scale: SCALE, environment: 'TEST' })).rejects.toMatchObject({
        code: 'agents.provenance_missing',
        userMessageParams: { market: 'BTC/USDT' },
      });
    }
  });

  it('one unreadable market among several refuses the whole answer', async () => {
    await expect(
      prepareResearch({ ask: 'BTC/USDT and SOL/USDT', port: port({ 'btc-usdt': '1' }), scale: SCALE, environment: 'TEST' }),
    ).rejects.toMatchObject({ code: 'agents.provenance_missing', userMessageParams: { market: 'SOL/USDT' } });
  });
});

describe('buildProvenance', () => {
  const plan = async () =>
    (await prepareResearch({ ask: 'BTC/USDT', port: port({ 'btc-usdt': '64000' }), scale: SCALE, environment: 'TEST' }))!;

  it('a fully cited answer: nothing unsupported, the lowest level', async () => {
    const p = buildProvenance(await plan(), 'BTC/USDT last traded at 64000 [S1].');
    expect(researchProvenanceSchema.parse(p)).toEqual(p);
    expect(p.unsupported).toEqual([]);
    expect(p.uncertainty).toEqual({ level: 'TEST low', scale: SCALE, unsupportedCount: 0, claimCount: 1 });
    expect(p.observedAt).toBe(OBSERVED);
    expect(p.environment).toBe('TEST');
    expect(p.assumptions).toEqual(['last_trade_at_observation', 'named_markets_only']);
    expect(p.notAdvice).toBe(true);
  });

  it('a sentence with no citation, or citing a source never read, is listed unsupported, verbatim', async () => {
    const p = buildProvenance(await plan(), 'BTC/USDT is at 64000 [S1]. It will double next week. Volume tripled [S7].');
    expect(p.unsupported).toEqual(['It will double next week.', 'Volume tripled [S7].']);
    expect(p.uncertainty).toMatchObject({ level: 'TEST high', unsupportedCount: 2, claimCount: 3 });
  });

  it('half unsupported sits in the middle of the scale', async () => {
    const p = buildProvenance(await plan(), 'Price 64000 [S1].\nIt looks strong.');
    expect(p.uncertainty).toMatchObject({ level: 'TEST medium', unsupportedCount: 1, claimCount: 2 });
  });

  it('an empty answer is the highest level, with the block still present', async () => {
    const p = buildProvenance(await plan(), '   ');
    expect(p.uncertainty).toMatchObject({ level: 'TEST high', unsupportedCount: 0, claimCount: 0 });
    expect(p.sources).toHaveLength(1);
  });

  it('splits sentences on end marks and line breaks', () => {
    expect(splitClaims('One. Two!\nThree? four')).toEqual(['One.', 'Two!', 'Three?', 'four']);
  });
});

// ── Through the public door: run.complete on a Navigator session ─────────────────────────────────────────────────────

const SECRET = 'an-agents-research-provenance-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function signed() {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read', 'agents:execute'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-research',
  });
}

function navigatorDeps(opts: { reply: string; trade?: NavigatorTradeDataPort; scale?: readonly string[] | null; agentId?: string }) {
  const agentId = opts.agentId ?? 'navigator';
  const calls: Array<{ system?: string }> = [];
  const session: SessionRecord = {
    id: SESSION,
    userId: USER,
    agentId,
    guardrail: {
      agentId,
      version: 1,
      scopes: [],
      tools: [],
      limits: {
        maxActionsPerSession: 20,
        maxOutputTokensPerCall: 256,
        maxSpendPerSession: null,
        allowedModules: ['trade'],
        allowedTasks: ['navigator.plan'],
      },
    },
    guardrailVersion: 1,
    status: 'open',
    metered: true,
    openedAt: new Date('2026-11-14T08:00:00.000Z'),
    closedAt: null,
  };
  const action: AuditedAction = {
    id: '44444444-4444-4444-8444-444444444444',
    sessionId: SESSION,
    userId: USER,
    agentId,
    sequence: 1,
    kind: 'completion',
    status: 'executed',
    tool: null,
    task: 'navigator.plan',
    providerId: 'primary',
    model: 'test-engine',
    inputTokens: 10n,
    outputTokens: 5n,
    cost: 7n,
    refusalCode: null,
    userMessageKey: 'agents.action.completed',
    userMessageParams: {},
    inputDigest: null,
    outputDigest: null,
    prevHash: null,
    hash: '0'.repeat(64),
    occurredAt: new Date('2026-11-14T08:00:01.000Z'),
  };
  const runtime = {
    session: async (id: string) => (id === SESSION ? session : null),
    think: async (input: { system?: string }): Promise<ThinkResult> => {
      calls.push({ ...(input.system === undefined ? {} : { system: input.system }) });
      return {
        text: opts.reply,
        usage: { inputTokens: 10, outputTokens: 5 },
        cost: 7n,
        metered: true,
        windowId: '2026-11-14T08',
        action,
      } as unknown as ThinkResult;
    },
  } as unknown as AgentsRouterDeps['runtime'];
  const runStore = createMemoryRunStore();
  const deps: AgentsRouterDeps = {
    runtime,
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'USDT',
    runStore,
    research: { scale: opts.scale === undefined ? SCALE : opts.scale, environment: 'TEST' },
    ...(opts.trade ? { navigatorTradeDataPort: opts.trade } : {}),
  };
  return { deps, calls, runStore };
}

const ASK = (content: string, requestId = 'research-request-0001') => ({
  sessionId: SESSION,
  requestId,
  task: 'navigator.plan',
  messages: [{ role: 'user' as const, content }],
});

describe('run.complete on a Navigator session', () => {
  it('an answer about a market returns its provenance, hands the engine the sources, and stores both with the reply', async () => {
    const trade = port({ 'btc-usdt': '64000' });
    const { deps, calls, runStore } = navigatorDeps({ reply: 'mock:test-engine:0123456789abcdef', trade });
    const caller = createAgentsRouter(deps).createCaller(signed());
    const result = await caller.run.complete(ASK('TEST: what moved BTC/USDT today?'));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain('[S1] BTC/USDT last traded price 64000');
    expect(result.provenance).toMatchObject({
      sources: [{ id: 'S1', market: 'BTC/USDT', measure: 'last_price', value: '64000', observedAt: OBSERVED }],
      observedAt: OBSERVED,
      environment: 'TEST',
      unsupported: ['mock:test-engine:0123456789abcdef'],
      uncertainty: { level: 'TEST high', unsupportedCount: 1, claimCount: 1 },
      notAdvice: true,
    });
    // Stored in the same write as the reply: a later read of the run returns the same provenance.
    const read = await caller.run.get({ runId: result.runId });
    expect(read.state).toBe('completed');
    expect(read.reply).toBe('mock:test-engine:0123456789abcdef');
    expect(read.provenance).toEqual(result.provenance);
    expect([...runStore.runs.values()][0]!.provenance).toEqual(result.provenance);
  });

  it('an ask that names no market runs as before, with no provenance and no market read', async () => {
    const trade = port({ 'btc-usdt': '64000' });
    const { deps, calls } = navigatorDeps({ reply: 'Use the order ticket.', trade });
    const result = await createAgentsRouter(deps).createCaller(signed()).run.complete(ASK('Where do I place a limit order?'));
    expect(result.provenance).toBeNull();
    expect(trade.reads).toEqual([]);
    expect(calls[0]!.system).toBeUndefined();
  });

  it('another agent naming a market is not a Navigator research answer', async () => {
    const trade = port({ 'btc-usdt': '64000' });
    const { deps } = navigatorDeps({ reply: 'ok', trade, agentId: 'probe' });
    const result = await createAgentsRouter(deps).createCaller(signed()).run.complete(ASK('BTC/USDT?'));
    expect(result.provenance).toBeNull();
    expect(trade.reads).toEqual([]);
  });

  it('a market it cannot read refuses agents.provenance_missing: no run row, no engine call, nothing charged', async () => {
    const { deps, calls, runStore } = navigatorDeps({ reply: 'never', trade: port({}) });
    await expect(
      createAgentsRouter(deps).createCaller(signed()).run.complete(ASK('TEST: what moved BTC/USDT today?')),
    ).rejects.toMatchObject({
      message: 'agents.refused.provenance_missing',
      cause: { code: 'agents.provenance_missing' },
    });
    expect(calls).toEqual([]);
    expect(runStore.runs.size).toBe(0);
  });

  it('a blank uncertainty scale refuses agents.uncertainty_scale_unset: no run row, no engine call, nothing charged', async () => {
    const { deps, calls, runStore } = navigatorDeps({ reply: 'never', trade: port({ 'btc-usdt': '1' }), scale: null });
    await expect(createAgentsRouter(deps).createCaller(signed()).run.complete(ASK('BTC/USDT'))).rejects.toMatchObject({
      message: 'agents.refused.uncertainty_scale_unset',
      cause: { code: 'agents.uncertainty_scale_unset' },
    });
    expect(calls).toEqual([]);
    expect(runStore.runs.size).toBe(0);
  });
});
