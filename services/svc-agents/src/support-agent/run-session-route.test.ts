import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { NO_TIER_LAWS, type TierLaws } from '../tier-laws.js';
import { SUPPORT_DATA_TOOLS } from './data-tools.js';

/**
 * `support.runSession` is mounted, scoped and shaped.
 *
 * The runtime is only reached on paths that open a session, so the refusal and
 * escalate cases below run against a deliberately empty runtime: if any of them
 * touched it, the test would throw rather than pass. That is the assertion — a
 * desk that stops for free must not have opened anything to find out.
 */

const SECRET = 'an-agents-support-run-session-mount-test-secret';
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
    tierLaws: { ...NO_TIER_LAWS, support: law },
  };
}

const law = { published: true as const, matrix: { basic: [...SUPPORT_DATA_TOOLS] } };

/** The stored, published law the door reads instead of the body (AG-sessions-01). */
const withLaw = (deps: AgentsRouterDeps, stored: TierLaws['support']): AgentsRouterDeps => ({
  ...deps,
  tierLaws: { ...NO_TIER_LAWS, support: stored },
});

const ask = {
  tool: 'support.kb.search',
  limit: 20,
  articles: [
    {
      articleKey: 'support.kb.withdrawal_hold',
      titleKey: 'support.kb.withdrawal_hold.title',
      bodyKey: 'support.kb.withdrawal_hold.body',
    },
  ],
};

describe('support.runSession route', () => {
  it('refuses a dark desk without touching the runtime, and says it billed nothing', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .support.runSession({ plane: 'dark', asks: [ask] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'desk_plane_dark',
      userMessageKey: 'agents.support.unavailable',
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
      .support.runSession({ plane: 'live', asks: [ask] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.support.tier_closed',
    });
    expect(result.metering.sessionId).toBeNull();
  });

  it('escalates a money request to a person, free, without a session', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .support.runSession({ plane: 'live', moneyRequest: true, asks: [ask] });

    expect(result).toMatchObject({
      status: 'escalate',
      reason: 'money_request',
      userMessageKey: 'agents.support.escalated',
    });
    expect(result.metering.billedAmount).toBe('0');
    if (result.status !== 'escalate') return;
    expect(result.caseFile.moneyRequest).toBe(true);
    expect(result.caseFile.reason).toBe('money_request');
  });

  it('refuses fixture KB articles when no catalog is published — never a composed ok', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .support.runSession({ plane: 'live', asks: [ask] });

    expect(result.status).not.toBe('ok');
    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'kb_plane_ungrounded',
      userMessageKey: 'agents.support.unavailable',
    });
    expect(result.metering.billedAmount).toBe('0');
  });

  it('refuses when nothing was asked — not a live KB plane', async () => {
    const result = await createAgentsRouter(stubDeps()).createCaller(signed()).support.runSession({ plane: 'live', asks: [] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'kb_plane_ungrounded',
      userMessageKey: 'agents.support.unavailable',
    });
    expect(result.metering.billedAmount).toBe('0');
  });

  it('live without a desk port refuses no_live_kb and bills nothing', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .support.runSession({
        plane: 'live',
        kbCatalog: [
          {
            id: 'support.kb.withdrawal_hold',
            titleKey: 'support.kb.withdrawal_hold.title',
            bodyKey: 'support.kb.withdrawal_hold.body',
          },
        ],
        asks: [ask],
      });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_kb',
      userMessageKey: 'agents.support.unavailable',
    });
    expect(result.metering).toEqual({
      sessionId: null,
      billedAmount: '0',
      assetId: 'IFC',
      sessionClosed: false,
      settlements: [],
    });
  });

  it('requires agents:execute — a read-only principal cannot run a metered reply', async () => {
    const readOnly = signed(principal({ scopes: ['agents:read'] }));
    await expect(
      createAgentsRouter(stubDeps())
        .createCaller(readOnly)
        .support.runSession({
          plane: 'dark',
          asks: [ask],
        }),
    ).rejects.toThrow();
  });

  it('AG-sessions-01: a signed tier the stored law does not grant refuses tier_not_granted and bills 0', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed(principal({ tier: 'none' })))
      .support.runSession({ plane: 'live', asks: [ask] });

    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.support.tier_closed',
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
    await expect(none.support.runSession({ plane: 'live', asks: [ask], userTier: 'basic' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(none.support.runSession({ plane: 'live', asks: [ask], law } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('caps the ask list rather than letting a caller burn a session budget', async () => {
    const asks = Array.from({ length: 21 }, () => ask);
    await expect(createAgentsRouter(stubDeps()).createCaller(signed()).support.runSession({ plane: 'dark', asks })).rejects.toThrow();
  });
});
