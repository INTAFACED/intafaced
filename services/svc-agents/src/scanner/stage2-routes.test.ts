import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { NO_TIER_LAWS, type TierLaws } from '../tier-laws.js';
import { SCANNER_DATA_TOOLS } from './guardrail.js';
import { SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL, SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW } from './signal-inputs-law.js';

const SECRET = 'an-agents-scanner-stage2-mount-test-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read'],
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

function stubDeps(scanner: TierLaws['scanner'] = null): AgentsRouterDeps {
  return {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'IFC',
    tierLaws: { ...NO_TIER_LAWS, scanner },
  };
}

/** The stored law grants the `basic` tier; the signed principal carries the tier the door gates on. */
const law = {
  published: true as const,
  matrix: { basic: { maxSignals: 5, tools: [...SCANNER_DATA_TOOLS] } },
};
const basic = () => signed(principal({ tier: 'basic' }));

describe('scanner Stage-2 routes', () => {
  it('stage2Guardrail returns read-only spot tools', async () => {
    const result = await createAgentsRouter(stubDeps()).createCaller(signed()).scanner.stage2Guardrail();
    expect(result.agentId).toBe('scanner');
    expect(result.tools.map((t) => t.name)).toEqual([...SCANNER_DATA_TOOLS]);
    expect(result.tools.every((t) => t.mode === 'read')).toBe(true);
    expect(result.limits.allowedTasks).toEqual(['scanner.rank']);
  });

  it('tierGate refuse-closed when law blank', async () => {
    const result = await createAgentsRouter(stubDeps()).createCaller(basic()).scanner.tierGate({});
    expect(result).toEqual({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.scanner.tier_closed',
    });
  });

  it('tierGate takes the tier from the signed principal and the law from stored config, never the body', async () => {
    expect(await createAgentsRouter(stubDeps(law)).createCaller(basic()).scanner.tierGate({})).toEqual({
      status: 'ok',
      userTier: 'basic',
      maxSignals: 5,
      allowedTools: [...SCANNER_DATA_TOOLS],
    });
    // A lower signed tier than the stored law grants is the typed tier refusal.
    expect(await createAgentsRouter(stubDeps(law)).createCaller(signed()).scanner.tierGate({})).toEqual({
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.scanner.tier_closed',
    });
    // A body that names a tier or a law is rejected before the gate runs.
    const caller = createAgentsRouter(stubDeps(law)).createCaller(signed());
    await expect(caller.scanner.tierGate({ userTier: 'basic' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.scanner.tierGate({ law } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.scanner.invokeDataTool({ tool: 'trade.ticker', plane: 'live', userTier: 'basic' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.scanner.rankLive({ plane: 'live', law, tickers: [] } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('invokeDataTool echoes ticker when live + published law', async () => {
    const result = await createAgentsRouter(stubDeps(law))
      .createCaller(basic())
      .scanner.invokeDataTool({
        tool: 'trade.ticker',
        plane: 'live',
        now: '2026-08-07T12:00:00.000Z',
        ticker: {
          marketId: 'btc-usdt',
          last: '100',
          volume24h: '1000',
          change24hBps: 50,
          asOf: '2026-08-07T11:59:00.000Z',
          maxAgeMs: 120_000,
        },
      });
    expect(result).toEqual({
      status: 'ok',
      tool: 'trade.ticker',
      marketId: 'btc-usdt',
      last: '100',
      volume24h: '1000',
      change24hBps: 50,
      asOf: '2026-08-07T11:59:00.000Z',
    });
  });

  it('rankLive caps by tier depth and refuses invent on dark plane', async () => {
    const blankP011 = await createAgentsRouter(stubDeps(law))
      .createCaller(basic())
      .scanner.rankLive({
        plane: 'live',
        signalInputsLaw: { published: false },
        tickers: [
          {
            marketId: 'btc-usdt',
            last: '100',
            volume24h: '1000',
            change24hBps: 50,
            asOf: '2026-08-07T12:00:00.000Z',
            maxAgeMs: 60_000,
          },
        ],
      });
    expect(blankP011).toEqual({
      status: 'refuse',
      reason: 'signal_inputs_law_blank',
      userMessageKey: 'agents.scanner.signal_inputs_closed',
      residual: SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL,
    });

    const dark = await createAgentsRouter(stubDeps(law))
      .createCaller(basic())
      .scanner.rankLive({
        plane: 'dark',
        signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
        tickers: [
          {
            marketId: 'btc-usdt',
            last: '100',
            volume24h: '1000',
            change24hBps: 50,
            asOf: '2026-08-07T12:00:00.000Z',
            maxAgeMs: 60_000,
          },
        ],
      });
    expect(dark).toEqual({
      status: 'refuse',
      reason: 'market_plane_dark',
      userMessageKey: 'agents.scanner.unavailable',
    });

    const ok = await createAgentsRouter(stubDeps({ published: true, matrix: { basic: { maxSignals: 1, tools: [...SCANNER_DATA_TOOLS] } } }))
      .createCaller(basic())
      .scanner.rankLive({
        plane: 'live',
        signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
        now: '2026-08-07T12:00:00.000Z',
        tickers: [
          {
            marketId: 'btc-usdt',
            last: '100',
            volume24h: '100',
            change24hBps: 10,
            asOf: '2026-08-07T12:00:00.000Z',
            maxAgeMs: 60_000,
          },
          {
            marketId: 'eth-usdt',
            last: '50',
            volume24h: '5000',
            change24hBps: 200,
            asOf: '2026-08-07T12:00:00.000Z',
            maxAgeMs: 60_000,
          },
        ],
      });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    expect(ok.maxSignals).toBe(1);
    expect(ok.signals).toHaveLength(1);
    expect(ok.signals[0]?.marketId).toBe('eth-usdt');
  });
});
