import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { NO_TIER_LAWS } from '../tier-laws.js';
import { invokeNavigatorDataTool, isNavigatorDataToolOk, NAVIGATOR_DATA_TOOLS } from './data-tools.js';

const publishedAll = {
  published: true as const,
  matrix: {
    free: [...NAVIGATOR_DATA_TOOLS],
  },
};

const now = new Date('2026-08-07T12:00:00.000Z');

describe('navigator Stage-2 data tools', () => {
  it('refuses money-write tools without inventing a post', () => {
    const r = invokeNavigatorDataTool({
      tool: 'ledger.post',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
    });
    expect(r).toEqual({
      status: 'refuse',
      tool: 'ledger.post',
      reason: 'money_write',
      userMessageKey: 'agents.navigator.unavailable',
    });
  });

  it('refuses place/cancel/withdraw by name — installing an agent is not trading authority', () => {
    for (const tool of ['trade.place', 'trade.order', 'trade.cancel', 'bank.withdraw'] as const) {
      expect(
        invokeNavigatorDataTool({
          tool,
          plane: 'live',
          tierLaw: publishedAll,
          userTier: 'free',
        }),
        tool,
      ).toEqual({
        status: 'refuse',
        tool,
        reason: 'money_write',
        userMessageKey: 'agents.navigator.unavailable',
      });
    }
  });

  it('dark plane refuses invent quotes', () => {
    const r = invokeNavigatorDataTool({
      tool: 'trade.quote',
      plane: 'dark',
      tierLaw: publishedAll,
      userTier: 'free',
      quote: { marketId: 'm1', last: '1.23', asOf: '2026-08-07T11:59:00.000Z', maxAgeMs: 60_000 },
      now,
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'trade_plane_dark' });
  });

  it('blank tier law refuse-closed before fixture use', () => {
    const r = invokeNavigatorDataTool({
      tool: 'trade.quote',
      plane: 'live',
      tierLaw: null,
      userTier: 'free',
      quote: { marketId: 'm1', last: '1.23', asOf: '2026-08-07T11:59:00.000Z', maxAgeMs: 60_000 },
      now,
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'tier_law_blank' });
  });

  it('echoes trade.quote fixture last — never invents mid', () => {
    const r = invokeNavigatorDataTool({
      tool: 'trade.quote',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      quote: { marketId: 'btc-usd', last: '64000.50', asOf: '2026-08-07T11:59:30.000Z', maxAgeMs: 120_000 },
      now,
    });
    expect(r).toEqual({
      status: 'ok',
      tool: 'trade.quote',
      marketId: 'btc-usd',
      last: '64000.50',
      asOf: '2026-08-07T11:59:30.000Z',
    });
    expect(isNavigatorDataToolOk(r)).toBe(true);
  });

  it('refuses a negative trade.quote last and keeps a positive unsigned decimal', () => {
    const negative = invokeNavigatorDataTool({
      tool: 'trade.quote',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      quote: { marketId: 'm1', last: '-1.50', asOf: '2026-08-07T11:59:00.000Z', maxAgeMs: 60_000 },
      now,
    });
    expect(negative).toEqual({
      status: 'refuse',
      tool: 'trade.quote',
      reason: 'invalid_decimal',
      userMessageKey: 'agents.navigator.unavailable',
    });

    const positive = invokeNavigatorDataTool({
      tool: 'trade.quote',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      quote: { marketId: 'm1', last: '1.50', asOf: '2026-08-07T11:59:00.000Z', maxAgeMs: 60_000 },
      now,
    });
    expect(positive).toEqual({
      status: 'ok',
      tool: 'trade.quote',
      marketId: 'm1',
      last: '1.50',
      asOf: '2026-08-07T11:59:00.000Z',
    });
  });

  it('null last → incomplete_quote (no zero-fill)', () => {
    const r = invokeNavigatorDataTool({
      tool: 'trade.quote',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      quote: { marketId: 'm1', last: null, asOf: '2026-08-07T11:59:00.000Z', maxAgeMs: 60_000 },
      now,
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'incomplete_quote' });
  });

  it('stale quote refuses', () => {
    const r = invokeNavigatorDataTool({
      tool: 'trade.quote',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      quote: { marketId: 'm1', last: '1.00', asOf: '2026-08-07T10:00:00.000Z', maxAgeMs: 60_000 },
      now,
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'stale' });
  });

  it('lists markets from fixtures only', () => {
    const r = invokeNavigatorDataTool({
      tool: 'trade.markets.list',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      markets: [{ marketId: 'm1', symbol: 'BTC-USD', status: 'open' }],
    });
    expect(r).toEqual({
      status: 'ok',
      tool: 'trade.markets.list',
      markets: [{ marketId: 'm1', symbol: 'BTC-USD', status: 'open' }],
    });
  });

  it('empty markets refuse', () => {
    expect(
      invokeNavigatorDataTool({
        tool: 'trade.markets.list',
        plane: 'live',
        tierLaw: publishedAll,
        userTier: 'free',
        markets: [],
      }),
    ).toMatchObject({ status: 'refuse', reason: 'empty_markets' });
  });

  it('echoes a resolved identity session — never invents fields', () => {
    const r = invokeNavigatorDataTool({
      tool: 'identity.session.read',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      requesterUserId: 'u1',
      session: { sessionId: 's1', userId: 'u1', status: 'open' },
    });
    expect(r).toEqual({
      status: 'ok',
      tool: 'identity.session.read',
      session: { sessionId: 's1', userId: 'u1', status: 'open' },
    });
  });

  it('null live identity session refuses no_live_session — never invents an open session', () => {
    const r = invokeNavigatorDataTool({
      tool: 'identity.session.read',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      requesterUserId: 'u1',
      session: null,
    });
    expect(r).toEqual({
      status: 'refuse',
      tool: 'identity.session.read',
      reason: 'no_live_session',
      userMessageKey: 'agents.navigator.unavailable',
    });
  });

  it('incomplete identity session fields refuse incomplete_session', () => {
    const r = invokeNavigatorDataTool({
      tool: 'identity.session.read',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      requesterUserId: 'u1',
      session: { sessionId: 's1', userId: '  ', status: 'open' },
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'incomplete_session' });
  });

  it('refuses an identity session owned by another user', () => {
    const r = invokeNavigatorDataTool({
      tool: 'identity.session.read',
      plane: 'live',
      tierLaw: publishedAll,
      userTier: 'free',
      requesterUserId: 'requester',
      session: { sessionId: 's1', userId: 'another-user', status: 'open' },
    });
    expect(r).toEqual({
      status: 'refuse',
      tool: 'identity.session.read',
      reason: 'subject_mismatch',
      userMessageKey: 'agents.navigator.unavailable',
    });
  });

  it('undeclared read tools refuse — caller fixtures cannot invent an allowlist grant', () => {
    const r = invokeNavigatorDataTool({
      tool: 'trade.fills.history',
      plane: 'live',
      tierLaw: { published: true, matrix: { free: ['trade.fills.history', ...NAVIGATOR_DATA_TOOLS] } },
      userTier: 'free',
      requesterUserId: 'u1',
    });
    expect(r).toEqual({
      status: 'refuse',
      tool: 'trade.fills.history',
      reason: 'tool_not_declared',
      userMessageKey: 'agents.navigator.unavailable',
    });
  });

  it('tool outside published tier grants refuses', () => {
    const r = invokeNavigatorDataTool({
      tool: 'trade.quote',
      plane: 'live',
      tierLaw: { published: true, matrix: { free: ['trade.markets.list'] } },
      userTier: 'free',
      quote: { marketId: 'm1', last: '1', asOf: '2026-08-07T11:59:00.000Z', maxAgeMs: 60_000 },
      now,
    });
    expect(r).toMatchObject({ status: 'refuse', reason: 'tool_not_in_tier' });
  });
});

const SECRET = 'an-agents-navigator-identity-miss-invoke-test-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read'],
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

function stubDeps(overrides: Partial<AgentsRouterDeps> = {}): AgentsRouterDeps {
  return {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'IFC',
    navigatorTradeUrl: 'http://svc-trade:4004',
    tierLaws: { ...NO_TIER_LAWS, navigator: { published: true, matrix: { basic: [...NAVIGATOR_DATA_TOOLS] } } },
    ...overrides,
  };
}

const fatSession = { sessionId: 'sess-1', userId: USER, status: 'open' as const };

describe('invokeDataTool live identity miss (S11-6)', () => {
  it('unset identity port refuses no_live_session — caller fixture is not live truth', async () => {
    const result = await createAgentsRouter(stubDeps()).createCaller(signed()).navigator.invokeDataTool({
      tool: 'identity.session.read',
      plane: 'live',
      session: fatSession,
      occurredAt: '2026-08-07T12:00:01.000Z',
    });
    expect(result.result).toEqual({
      status: 'refuse',
      tool: 'identity.session.read',
      reason: 'no_live_session',
      userMessageKey: 'agents.navigator.unavailable',
    });
    expect(result.audit).toMatchObject({ status: 'refused', reason: 'no_live_session' });
  });

  it('throwing identity port refuses no_live_session — does not keep caller session', async () => {
    const result = await createAgentsRouter(
      stubDeps({
        navigatorIdentitySessionPort: {
          read: async () => {
            throw new Error('identity down');
          },
        },
      }),
    )
      .createCaller(signed())
      .navigator.invokeDataTool({
        tool: 'identity.session.read',
        plane: 'live',
        session: fatSession,
        occurredAt: '2026-08-07T12:00:01.000Z',
      });
    expect(result.result).toMatchObject({ status: 'refuse', reason: 'no_live_session' });
    expect(result.result).not.toMatchObject({ status: 'ok', session: fatSession });
    expect(result.audit.status).toBe('refused');
  });

  it('null identity read refuses no_live_session — catch must not echo caller fixture', async () => {
    const result = await createAgentsRouter(
      stubDeps({
        navigatorIdentitySessionPort: { read: async () => null },
      }),
    )
      .createCaller(signed())
      .navigator.invokeDataTool({
        tool: 'identity.session.read',
        plane: 'live',
        session: fatSession,
        occurredAt: '2026-08-07T12:00:01.000Z',
      });
    expect(result.result).toMatchObject({ status: 'refuse', reason: 'no_live_session' });
  });

  it('live identity uses the port session, not the caller fixture status', async () => {
    const result = await createAgentsRouter(
      stubDeps({
        navigatorIdentitySessionPort: {
          read: async () => ({ sessionId: 'sess-1', userId: USER, status: 'closed' as const }),
        },
      }),
    )
      .createCaller(signed())
      .navigator.invokeDataTool({
        tool: 'identity.session.read',
        plane: 'live',
        session: fatSession,
        occurredAt: '2026-08-07T12:00:01.000Z',
      });
    expect(result.result).toEqual({
      status: 'ok',
      tool: 'identity.session.read',
      session: { sessionId: 'sess-1', userId: USER, status: 'closed' },
    });
  });

  it('padded identity.session.read in live still overlays — caller fixture is not live truth', async () => {
    const result = await createAgentsRouter(stubDeps()).createCaller(signed()).navigator.invokeDataTool({
      tool: ' identity.session.read ',
      plane: 'live',
      session: fatSession,
      occurredAt: '2026-08-07T12:00:01.000Z',
    });
    expect(result.result).toEqual({
      status: 'refuse',
      tool: 'identity.session.read',
      reason: 'no_live_session',
      userMessageKey: 'agents.navigator.unavailable',
    });
    expect(result.result).not.toMatchObject({ status: 'ok', session: fatSession });
  });

  it('padded identity.session.read live uses the port session, not the caller fixture', async () => {
    const result = await createAgentsRouter(
      stubDeps({
        navigatorIdentitySessionPort: {
          read: async () => ({ sessionId: 'sess-1', userId: USER, status: 'closed' as const }),
        },
      }),
    )
      .createCaller(signed())
      .navigator.invokeDataTool({
        tool: ' identity.session.read ',
        plane: 'live',
        session: fatSession,
        occurredAt: '2026-08-07T12:00:01.000Z',
      });
    expect(result.result).toEqual({
      status: 'ok',
      tool: 'identity.session.read',
      session: { sessionId: 'sess-1', userId: USER, status: 'closed' },
    });
    expect(result.result).not.toMatchObject({ status: 'ok', session: fatSession });
  });
});
