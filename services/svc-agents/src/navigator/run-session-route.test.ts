import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { NO_TIER_LAWS, type TierLaws } from '../tier-laws.js';
import { NAVIGATOR_DATA_TOOLS } from './data-tools.js';

/**
 * `navigator.runSession` is mounted, scoped and shaped.
 *
 * The runtime is only reached on paths that open a session, so the refusal cases
 * below run against a deliberately empty runtime: if any of them touched it, the
 * test would throw rather than pass. That is the assertion — a navigator that
 * refuses for free must not have opened anything to find out.
 */

const SECRET = 'an-agents-navigator-run-session-mount-test-secret';
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
    tierLaws: { ...NO_TIER_LAWS, navigator: law },
    navigatorTradeUrl: 'http://svc-trade:4004',
  };
}

const law = { published: true as const, matrix: { basic: [...NAVIGATOR_DATA_TOOLS] } };

/** The stored, published law the door reads instead of the body (AG-sessions-01). */
const withLaw = (deps: AgentsRouterDeps, stored: TierLaws['navigator']): AgentsRouterDeps => ({
  ...deps,
  tierLaws: { ...NO_TIER_LAWS, navigator: stored },
});

const ask = {
  tool: 'trade.quote',
  quote: {
    marketId: 'btc-usdt',
    last: '100',
    asOf: '2026-08-07T11:59:30.000Z',
    maxAgeMs: 120_000,
  },
};

describe('navigator.runSession route', () => {
  it('refuses a dark plane without touching the runtime, and says it billed nothing', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .navigator.runSession({ plane: 'dark', asks: [ask] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'trade_plane_dark',
      userMessageKey: 'agents.navigator.unavailable',
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
      .navigator.runSession({ plane: 'live', asks: [ask] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.navigator.tier_closed',
    });
    expect(result.metering.sessionId).toBeNull();
  });

  it('is empty when nothing was asked', async () => {
    const result = await createAgentsRouter(stubDeps()).createCaller(signed()).navigator.runSession({ plane: 'live', asks: [] });

    expect(result).toMatchObject({ status: 'empty', userMessageKey: 'agents.navigator.empty' });
    expect(result.metering.billedAmount).toBe('0');
  });

  it('requires agents:execute — a read-only principal cannot run a metered answer', async () => {
    const readOnly = signed(principal({ scopes: ['agents:read'] }));
    await expect(
      createAgentsRouter(stubDeps())
        .createCaller(readOnly)
        .navigator.runSession({
          plane: 'dark',
          asks: [ask],
        }),
    ).rejects.toThrow();
  });

  it('refuses off-allowlist asks without touching the runtime, and says it billed nothing', async () => {
    const result = await createAgentsRouter(
      withLaw(stubDeps(), { published: true, matrix: { basic: ['trade.fills.history', 'ledger.post'] } }),
    )
      .createCaller(signed())
      .navigator.runSession({
        plane: 'live',
        asks: [{ tool: 'trade.fills.history' }, { tool: 'ledger.post' }],
      });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tool_not_declared',
      userMessageKey: 'agents.navigator.unavailable',
    });
    expect(result.metering).toEqual({
      sessionId: null,
      billedAmount: '0',
      assetId: 'IFC',
      sessionClosed: false,
      settlements: [],
    });
  });

  it('AG-sessions-01: a signed tier the stored law does not grant refuses tier_not_granted and bills 0', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed(principal({ tier: 'none' })))
      .navigator.runSession({ plane: 'live', asks: [ask] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.navigator.tier_closed',
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
    const none = createAgentsRouter(stubDeps()).createCaller(signed(principal({ tier: 'none' })));
    await expect(none.navigator.runSession({ plane: 'live', asks: [ask], userTier: 'basic' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(none.navigator.runSession({ plane: 'live', asks: [ask], law } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('caps the ask list rather than letting a caller burn a session budget', async () => {
    const asks = Array.from({ length: 21 }, () => ask);
    await expect(createAgentsRouter(stubDeps()).createCaller(signed()).navigator.runSession({ plane: 'dark', asks })).rejects.toThrow();
  });
});
