import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { NO_TIER_LAWS, type TierLaws } from '../tier-laws.js';
import { SCANNER_DATA_TOOLS } from './guardrail.js';
import { SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW, SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL } from './signal-inputs-law.js';

/**
 * `scanner.runSession` is mounted, scoped and shaped.
 *
 * The runtime is only reached on paths that open a session, so the refusal
 * cases below run against a deliberately empty runtime: if any of them touched
 * it, the test would throw rather than pass. That is the assertion — a scanner
 * that refuses for free must not have opened anything to find out.
 */

const SECRET = 'an-agents-scanner-run-session-mount-test-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read', 'agents:execute'],
    tier: 'basic',
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

function stubDeps(): AgentsRouterDeps {
  return {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'IFC',
    tierLaws: { ...NO_TIER_LAWS, scanner: law },
  };
}

const law = {
  published: true as const,
  matrix: { basic: { maxSignals: 5, tools: [...SCANNER_DATA_TOOLS] } },
};

/** The stored, published law the door reads instead of the body (AG-sessions-01). */
const withLaw = (deps: AgentsRouterDeps, stored: TierLaws['scanner']): AgentsRouterDeps => ({
  ...deps,
  tierLaws: { ...NO_TIER_LAWS, scanner: stored },
});

const ticker = {
  marketId: 'btc-usdt',
  last: '100',
  volume24h: '1000',
  change24hBps: 50,
  asOf: '2026-08-07T11:59:30.000Z',
  maxAgeMs: 120_000,
};

describe('scanner.runSession route', () => {
  it('D26-P1-A3: refuses unpublished P0-11 without touching the runtime', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .scanner.runSession({
        plane: 'live',
        signalInputsLaw: { published: false },
        tickers: [ticker],
      });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'signal_inputs_law_blank',
      userMessageKey: 'agents.scanner.signal_inputs_closed',
      residual: SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL,
    });
    expect(result.metering.sessionId).toBeNull();
    expect(result.metering.billedAmount).toBe('0');
  });

  it('refuses a dark plane without touching the runtime, and says it billed nothing', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .scanner.runSession({
        plane: 'dark',
        signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
        tickers: [ticker],
      });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'market_plane_dark',
      userMessageKey: 'agents.scanner.unavailable',
    });
    expect(result.metering).toEqual({
      sessionId: null,
      billedAmount: '0',
      assetId: 'IFC',
      sessionClosed: false,
      settlements: [],
    });
  });

  it('refuses a blank tier law refuse-closed', async () => {
    const result = await createAgentsRouter(withLaw(stubDeps(), null))
      .createCaller(signed())
      .scanner.runSession({
        plane: 'live',
        signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
        tickers: [ticker],
      });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.scanner.tier_closed',
    });
    expect(result.metering.sessionId).toBeNull();
  });

  it('AG-sessions-01: a signed tier the stored law does not grant refuses tier_not_granted and bills 0', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed(principal({ tier: 'none' })))
      .scanner.runSession({
        plane: 'live',
        signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
        tickers: [ticker],
      });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.scanner.tier_closed',
    });
    expect(result.metering).toEqual({
      sessionId: null,
      billedAmount: '0',
      assetId: 'IFC',
      sessionClosed: false,
      settlements: [],
    });
  });

  it('AG-sessions-01: a body naming its own tier or law is rejected before the gate', async () => {
    const router = createAgentsRouter(stubDeps()).createCaller(signed(principal({ tier: 'none' })));
    const body = { plane: 'live' as const, signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW, tickers: [ticker] };
    await expect(router.scanner.runSession({ ...body, userTier: 'basic' } as unknown as typeof body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(router.scanner.runSession({ ...body, law } as unknown as typeof body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('live without a tickers port refuses no_live_tickers — body tickers are not live truth', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .scanner.runSession({
        plane: 'live',
        signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
        tickers: [ticker],
      });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_tickers',
      userMessageKey: 'agents.scanner.unavailable',
    });
    expect(result.metering).toEqual({
      sessionId: null,
      billedAmount: '0',
      assetId: 'IFC',
      sessionClosed: false,
      settlements: [],
    });
  });

  it('live without a tickers port refuses no_live_tickers even when body tickers are empty', async () => {
    const result = await createAgentsRouter(stubDeps()).createCaller(signed()).scanner.runSession({
      plane: 'live',
      signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
      tickers: [],
    });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_tickers',
      userMessageKey: 'agents.scanner.unavailable',
    });
    expect(result.metering.billedAmount).toBe('0');
  });

  it('requires agents:execute — a read-only principal cannot run a metered scan', async () => {
    const readOnly = signed(principal({ scopes: ['agents:read'] }));
    await expect(
      createAgentsRouter(stubDeps())
        .createCaller(readOnly)
        .scanner.runSession({
          plane: 'dark',
          signalInputsLaw: SEALED_ABS_CHANGE_X_LOG_VOLUME_LAW,
          tickers: [ticker],
        }),
    ).rejects.toThrow();
  });
});
