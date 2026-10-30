/**
 * Unit card (D26-P2-01h):
 * Promise: dark refuse + metering-off never bill through public tRPC doors
 *   (router-mounted entry points — not unit-only Runtime/UsageMeter guards).
 * Break: a new product runSession could ship dark without billedAmount:'0',
 *   or metering kill-switch could still feeCharge via usage.settle /
 *   usage.settleSession / session.close / run.complete.
 * Done bar:
 *   · every Stage-1 product runSession dark refuse → metering.billedAmount '0'
 *     via createCaller (public door);
 *   · metering-off through usage.settle + usage.settleSession + session.close
 *     + run.complete never invokes meter.settle / feeCharge (router stub door);
 *   · real AgentRuntime(meteringEnabled:false) through the same doors lives in
 *     runtime.test.ts (same Postgres owner — avoids parallel TRUNCATE collide).
 * Class: N (honesty) / M surface (feeCharge refuse). Leverage: existing
 *   svc-agents metering + ledger-client recipes (import only).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createAgentsRouter } from './router.js';
import type { AgentsRouterDeps } from './router.js';
import { chargeKeyFor } from './metering/meter.js';
import type { AuditedAction } from './fleet/audit.js';
import type { SettlementResult } from './metering/meter.js';
import type { SessionRecord, ThinkResult } from './runtime.js';
import { SCANNER_DATA_TOOLS } from './scanner/guardrail.js';
import { SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW } from './scanner/signal-inputs-law.js';
import { NAVIGATOR_DATA_TOOLS } from './navigator/data-tools.js';
import { SUPPORT_DATA_TOOLS } from './support-agent/data-tools.js';

const SECRET = 'an-agents-metering-public-doors-promise-falsify-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const WINDOW = '2026-08-12T10';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read', 'agents:execute', 'admin:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function settleCaller(p: Principal = principal()) {
  return { ...signed(p), service: 'svc-agents' as const };
}

function emptyDeps(): AgentsRouterDeps {
  return {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'IFC',
  };
}

const scannerLaw = {
  published: true as const,
  matrix: { free: { maxSignals: 5, tools: [...SCANNER_DATA_TOOLS] } },
};
const ticker = {
  marketId: 'btc-usdt',
  last: '100',
  volume24h: '1000',
  change24hBps: 50,
  asOf: '2026-08-07T11:59:30.000Z',
  maxAgeMs: 120_000,
};
const navigatorLaw = { published: true as const, matrix: { free: [...NAVIGATOR_DATA_TOOLS] } };
const navigatorAsk = {
  tool: 'trade.quote' as const,
  quote: {
    marketId: 'btc-usdt',
    last: '100',
    asOf: '2026-08-07T11:59:30.000Z',
    maxAgeMs: 120_000,
  },
};
const supportLaw = { published: true as const, matrix: { free: [...SUPPORT_DATA_TOOLS] } };
const supportAsk = {
  tool: 'support.kb.search' as const,
  limit: 20,
  articles: [
    {
      articleKey: 'support.kb.withdrawal_hold',
      titleKey: 'support.kb.withdrawal_hold.title',
      bodyKey: 'support.kb.withdrawal_hold.body',
    },
  ],
};
const merchantPoint = {
  railId: 'card-visa',
  approvalRate: '0.70',
  attempts: 100,
  asOf: '2026-08-07T11:59:30.000Z',
  maxAgeMs: 120_000,
};
const copyFixture = {
  leaderId: 'leader-a',
  realisedPnl: '12.5',
  closedTrades: 10,
  winningTrades: 6,
  windowStart: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-07T00:00:00.000Z',
  source: 'platform-fills',
};

const ZERO_METERING = {
  sessionId: null,
  billedAmount: '0',
  assetId: 'IFC',
  sessionClosed: false,
  settlements: [],
};

describe('D26-P2-01h public doors — dark refuse bills zero', () => {
  it('scanner.runSession dark refuse → billedAmount 0 (createCaller)', async () => {
    const result = await createAgentsRouter(emptyDeps())
      .createCaller(signed())
      .scanner.runSession({
        plane: 'dark',
        userTier: 'free',
        law: scannerLaw,
        // Sealed P0-11 so dark-plane refuse is reachable (blank law refuses earlier).
        signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
        tickers: [ticker],
      });
    expect(result).toMatchObject({ status: 'refuse', reason: 'market_plane_dark' });
    expect(result.metering).toEqual(ZERO_METERING);
  });

  it('navigator.runSession dark refuse → billedAmount 0 (createCaller)', async () => {
    const result = await createAgentsRouter(emptyDeps())
      .createCaller(signed())
      .navigator.runSession({ plane: 'dark', userTier: 'free', law: navigatorLaw, asks: [navigatorAsk] });
    expect(result).toMatchObject({ status: 'refuse', reason: 'trade_plane_dark' });
    expect(result.metering).toEqual(ZERO_METERING);
  });

  it('support.runSession dark refuse → billedAmount 0 (createCaller)', async () => {
    const result = await createAgentsRouter(emptyDeps())
      .createCaller(signed())
      .support.runSession({ plane: 'dark', userTier: 'free', law: supportLaw, asks: [supportAsk] });
    expect(result).toMatchObject({ status: 'refuse', reason: 'desk_plane_dark' });
    expect(result.metering).toEqual(ZERO_METERING);
  });

  it('merchant.runSession dark refuse → billedAmount 0 (createCaller)', async () => {
    const result = await createAgentsRouter(emptyDeps())
      .createCaller(signed())
      .merchant.runSession({ plane: 'dark', points: [merchantPoint] });
    expect(result).toMatchObject({ status: 'refuse', reason: 'pay_plane_dark' });
    expect(result.metering).toEqual(ZERO_METERING);
  });

  it('copyIntel.runSession dark refuse → billedAmount 0 (createCaller)', async () => {
    const result = await createAgentsRouter(emptyDeps())
      .createCaller(signed())
      .copyIntel.runSession({ plane: 'dark', fixtures: [copyFixture] });
    expect(result).toMatchObject({ status: 'refuse', reason: 'copy_plane_dark' });
    expect(result.metering).toEqual(ZERO_METERING);
  });
});

/**
 * Metering-off kill-switch at the tRPC surface.
 *
 * Runtime here mirrors AgentRuntime.settleWindow when meteringEnabled=false:
 * settled:false, amount 0n, no chargeTxId — and the meter.settle path that
 * posts recipes.feeCharge must never be reached from these doors.
 */
describe('D26-P2-01h public doors — metering-off never feeCharges', () => {
  function meteringOffDeps() {
    const meterSettleCalls: string[] = [];

    const openSession: SessionRecord = {
      id: SESSION,
      userId: USER,
      agentId: 'probe',
      guardrail: {
        agentId: 'probe',
        version: 1,
        scopes: [],
        tools: [],
        limits: {
          maxActionsPerSession: 20,
          maxOutputTokensPerCall: 256,
          maxSpendPerSession: null,
          allowedModules: ['trade'],
          allowedTasks: ['plan'],
        },
      },
      guardrailVersion: 1,
      status: 'open',
      metered: true,
      openedAt: new Date('2026-08-12T10:00:00.000Z'),
      closedAt: null,
    };

    const action: AuditedAction = {
      id: '44444444-4444-4444-8444-444444444444',
      sessionId: SESSION,
      userId: USER,
      agentId: 'probe',
      sequence: 1,
      kind: 'completion',
      status: 'executed',
      tool: null,
      task: 'plan',
      providerId: 'primary',
      model: 'reasoning-lg',
      inputTokens: 10n,
      outputTokens: 5n,
      cost: 0n,
      refusalCode: null,
      userMessageKey: 'agents.action.completed',
      userMessageParams: {},
      inputDigest: null,
      outputDigest: null,
      prevHash: null,
      hash: '0'.repeat(64),
      occurredAt: new Date('2026-08-12T10:00:01.000Z'),
    };

    const offSettle = (sessionId: string, windowId: string): SettlementResult => ({
      sessionId,
      windowId,
      chargeKey: chargeKeyFor(sessionId, windowId),
      amount: 0n,
      chargeTxId: null,
      settled: false,
    });

    const runtime = {
      session: async (sessionId: string) => (sessionId === SESSION ? openSession : null),
      settleWindow: async (sessionId: string, windowId: string) => offSettle(sessionId, windowId),
      settleSession: async (sessionId: string) => [offSettle(sessionId, WINDOW)],
      // Same order as AgentRuntime.closeSettled: settle the session's windows, then close it.
      async closeSettled(
        this: { settleSession(id: string): Promise<unknown>; closeSession(id: string): Promise<unknown> },
        sessionId: string,
      ) {
        await this.settleSession(sessionId);
        return this.closeSession(sessionId);
      },
      closeSession: async (sessionId: string) => ({
        ...openSession,
        id: sessionId,
        status: 'closed' as const,
        closedAt: new Date('2026-08-12T10:05:00.000Z'),
      }),
      think: async (): Promise<ThinkResult> => ({
        text: 'audit-only while metering off',
        usage: { inputTokens: 10, outputTokens: 5 },
        cost: 0n,
        metered: false,
        windowId: null,
        route: {
          task: 'plan',
          providerId: 'primary',
          model: 'reasoning-lg',
          maxOutputTokens: 256,
          price: { inputPerMillion: amt('3'), outputPerMillion: amt('15') },
          capability: 'complete',
        },
        action,
      }),
    } as unknown as AgentsRouterDeps['runtime'];

    const meter = {
      windowFor: () => WINDOW,
      pendingCost: async () => 0n,
      sessionSpend: async () => 0n,
      settle: async () => {
        meterSettleCalls.push('settle');
        throw new Error('meter.settle / feeCharge must not run while metering is off');
      },
    } as unknown as AgentsRouterDeps['meter'];

    const deps: AgentsRouterDeps = {
      runtime,
      gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
      meter,
      feeAssetId: 'IFC',
    };

    return { deps, meterSettleCalls };
  }

  it('usage.settle returns settled:false amount 0 and never calls meter.settle', async () => {
    const { deps, meterSettleCalls } = meteringOffDeps();
    const result = await createAgentsRouter(deps).createCaller(settleCaller()).usage.settle({ sessionId: SESSION, windowId: WINDOW });

    expect(result).toEqual({
      amount: '0',
      assetId: 'IFC',
      chargeKey: chargeKeyFor(SESSION, WINDOW),
      settled: false,
    });
    expect(meterSettleCalls).toEqual([]);
  });

  it('usage.settleSession returns unsettled zeros and never calls meter.settle', async () => {
    const { deps, meterSettleCalls } = meteringOffDeps();
    const result = await createAgentsRouter(deps).createCaller(settleCaller()).usage.settleSession({ sessionId: SESSION });

    expect(result.assetId).toBe('IFC');
    expect(result.settlements).toEqual([
      {
        windowId: WINDOW,
        amount: '0',
        chargeKey: chargeKeyFor(SESSION, WINDOW),
        settled: false,
      },
    ]);
    expect(meterSettleCalls).toEqual([]);
  });

  it('session.close settles then closes without meter.settle / feeCharge', async () => {
    const { deps, meterSettleCalls } = meteringOffDeps();
    let settleCalls = 0;
    const base = deps.runtime;
    const runtime = {
      ...base,
      settleSession: async (sessionId: string) => {
        settleCalls += 1;
        return base.settleSession(sessionId);
      },
    } as AgentsRouterDeps['runtime'];

    const result = await createAgentsRouter({ ...deps, runtime })
      .createCaller(signed())
      .session.close({ sessionId: SESSION });

    expect(settleCalls).toBe(1);
    expect(result.status).toBe('closed');
    expect(meterSettleCalls).toEqual([]);
  });

  it('run.complete reports cost 0 / metered false and never calls meter.settle', async () => {
    const { deps, meterSettleCalls } = meteringOffDeps();
    const result = await createAgentsRouter(deps)
      .createCaller(signed())
      .run.complete({
        sessionId: SESSION,
        requestId: 'req-metering-off-1',
        task: 'plan',
        messages: [{ role: 'user', content: 'probe while billing is off' }],
      });

    expect(result.metered).toBe(false);
    expect(result.cost).toBe('0');
    expect(result.assetId).toBe('IFC');
    expect(meterSettleCalls).toEqual([]);
  });

  it('run.complete same requestId twice never calls meter.settle', async () => {
    const { deps, meterSettleCalls } = meteringOffDeps();
    const caller = createAgentsRouter(deps).createCaller(signed());
    const first = await caller.run.complete({
      sessionId: SESSION,
      requestId: 'req-metering-off-replay',
      task: 'plan',
      messages: [{ role: 'user', content: 'replay while billing is off' }],
    });
    const second = await caller.run.complete({
      sessionId: SESSION,
      requestId: 'req-metering-off-replay',
      task: 'plan',
      messages: [{ role: 'user', content: 'replay while billing is off' }],
    });

    expect(first.metered).toBe(false);
    expect(second.metered).toBe(false);
    expect(first.cost).toBe('0');
    expect(second.cost).toBe('0');
    expect(meterSettleCalls).toEqual([]);
  });

  it('router never posts feeCharge itself — settle doors only call runtime', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'router.ts'), 'utf8');
    expect(src).not.toMatch(/recipes\.feeCharge/);
    expect(src).not.toMatch(/ledger\.post/);
    expect(src).toMatch(/runtime\.settleWindow/);
    expect(src).toMatch(/runtime\.settleSession/);
    expect(src).toMatch(/runtime\.think/);
  });
});
