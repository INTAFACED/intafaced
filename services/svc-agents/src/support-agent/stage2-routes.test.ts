import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { NO_TIER_LAWS, type TierLaws } from '../tier-laws.js';
import { SUPPORT_DATA_TOOLS } from './data-tools.js';
import { createFixtureSupportDesk } from './desk-port.js';

const SECRET = 'an-agents-support-stage2-mount-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
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

const articles = [
  { articleKey: 'kb.withdrawals.delayed', titleKey: 'kb.withdrawals.delayed.title', bodyKey: 'kb.withdrawals.delayed.body' },
];

const AT = '2026-08-07T22:00:00.000Z';

function stubDeps(
  desk = createFixtureSupportDesk({
    articles,
    tickets: [{ ticketId: 'tkt-9', ownerUserId: OTHER, status: 'open', category: 'withdrawals' }],
    accounts: [
      { userId: USER, status: 'frozen', kycTier: 'tier-2' },
      { userId: OTHER, status: 'frozen', kycTier: 'tier-2' },
    ],
  }),
): AgentsRouterDeps {
  return {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'IFC',
    tierLaws: { ...NO_TIER_LAWS, support: law },
    supportDesk: desk,
  };
}

const law = { published: true as const, matrix: { basic: [...SUPPORT_DATA_TOOLS] } };

/** The stored, published law the door reads instead of the body (AG-sessions-01). */
const withLaw = (deps: AgentsRouterDeps, stored: TierLaws['support']): AgentsRouterDeps => ({
  ...deps,
  tierLaws: { ...NO_TIER_LAWS, support: stored },
});

const caller = (deps: AgentsRouterDeps = stubDeps()) => createAgentsRouter(deps).createCaller(signed());

describe('support Stage-2 routes', () => {
  it('tierGate refuses closed when law is blank', async () => {
    expect(await caller(withLaw(stubDeps(), null)).support.tierGate({})).toEqual({
      status: 'refuse',
      reason: 'tier_law_blank',
      userMessageKey: 'agents.support.tier_closed',
    });
  });

  it("AG-sessions-01: the tier is the signed principal's and the law is stored, never the body", async () => {
    const none = createAgentsRouter(stubDeps()).createCaller(signed(principal({ tier: 'none' })));
    expect(await none.support.tierGate({})).toEqual({
      status: 'refuse',
      reason: 'tier_not_granted',
      userMessageKey: 'agents.support.tier_closed',
    });
    await expect(none.support.tierGate({ userTier: 'basic' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(none.support.tierGate({ law } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      none.support.invokeDataTool({
        tool: 'support.kb.search',
        plane: 'live',
        articles,
        limit: 20,
        occurredAt: AT,
        userTier: 'basic',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(none.support.answerOrEscalate({ tool: 'support.kb.search', plane: 'live', articles, law } as never)).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );
  });

  it('tierGate grants exactly the published matrix row', async () => {
    expect(await caller().support.tierGate({})).toEqual({
      status: 'ok',
      userTier: 'basic',
      allowedTools: [...SUPPORT_DATA_TOOLS],
    });
  });

  it('invokeDataTool reads the KB and audits the call as executed', async () => {
    const result = await caller().support.invokeDataTool({
      tool: 'support.kb.search',
      plane: 'live',
      articles,
      limit: 20,
      occurredAt: AT,
    });
    expect(result.result).toEqual({ status: 'ok', tool: 'support.kb.search', articles });
    expect(result.audit).toEqual({
      sequence: 0,
      kind: 'tool_call',
      status: 'executed',
      tool: 'support.kb.search',
      reason: null,
      userMessageKey: 'agents.action.executed',
      occurredAt: AT,
    });
  });

  it('invokeDataTool refuses another user’s ticket even though the caller named the owner', async () => {
    const result = await caller().support.invokeDataTool({
      tool: 'support.ticket.read',
      plane: 'live',
      ticket: { ticketId: 'tkt-9', ownerUserId: OTHER, status: 'open', category: 'withdrawals' },
      occurredAt: AT,
    });
    expect(result.result).toMatchObject({ status: 'refuse', reason: 'not_ticket_owner' });
    expect(result.audit).toMatchObject({ status: 'refused', reason: 'not_ticket_owner' });
  });

  it('invokeDataTool refuses another user’s account projection', async () => {
    const desk = createFixtureSupportDesk({
      articles,
      accounts: [{ userId: USER, status: 'frozen', kycTier: 'tier-2' }],
    });
    desk.readAccount = async () => ({
      status: 'ok',
      account: { userId: OTHER, status: 'frozen', kycTier: 'tier-2' },
    });
    const result = await caller(stubDeps(desk)).support.invokeDataTool({
      tool: 'identity.account.read',
      plane: 'live',
      account: { userId: OTHER, status: 'frozen', kycTier: 'tier-2' },
      occurredAt: AT,
    });
    expect(result.result).toMatchObject({ status: 'refuse', reason: 'account_owner_mismatch' });
  });

  it('invokeDataTool returns the caller’s own account projection with no balance field', async () => {
    const result = await caller().support.invokeDataTool({
      tool: 'identity.account.read',
      plane: 'live',
      account: { userId: USER, status: 'frozen', kycTier: 'tier-2' },
      occurredAt: AT,
    });
    expect(result.result).toEqual({
      status: 'ok',
      tool: 'identity.account.read',
      account: { userId: USER, status: 'frozen', kycTier: 'tier-2' },
    });
  });

  it('invokeDataTool refuses a money tool and still writes the audit row', async () => {
    const result = await caller().support.invokeDataTool({
      tool: 'ledger.post',
      plane: 'live',
      occurredAt: AT,
    });
    expect(result.result).toMatchObject({ status: 'refuse', tool: 'ledger.post', reason: 'money_tool' });
    expect(result.audit).toMatchObject({ status: 'refused', tool: 'ledger.post' });
  });

  it('answerOrEscalate answers only from articles the KB actually returned', async () => {
    expect(
      await caller().support.answerOrEscalate({
        tool: 'support.kb.search',
        plane: 'live',
        kbPlane: 'live',
        articles,
        limit: 20,
      }),
    ).toEqual({ status: 'answer', citedArticleKeys: ['kb.withdrawals.delayed'] });
  });

  it('answerOrEscalate sends an empty KB, a dark desk and a money ask to a person', async () => {
    const base = {
      tool: 'support.kb.search' as const,
      plane: 'live' as const,
      kbPlane: 'live' as const,
      limit: 20,
    };
    expect(
      await caller(stubDeps(createFixtureSupportDesk({ articles: [] }))).support.answerOrEscalate({ ...base, articles: [] }),
    ).toMatchObject({
      reason: 'kb_no_hit',
    });
    expect(await caller().support.answerOrEscalate({ ...base, plane: 'dark', articles })).toMatchObject({
      reason: 'desk_refused',
    });
    expect(await caller().support.answerOrEscalate({ ...base, articles, moneyRequest: true })).toMatchObject({
      reason: 'money_request',
    });
  });

  it('answerOrEscalate never answers from fixture articles when the KB plane is omitted (dark)', async () => {
    const result = await caller().support.answerOrEscalate({
      tool: 'support.kb.search',
      plane: 'live',
      articles,
    });
    expect(result.status).not.toBe('answer');
    expect(result).toMatchObject({ status: 'escalate', reason: 'kb_no_hit' });
  });
});
