/**
 * D-account-07 public doors: the agreement and eligibility routes, and the gate in front of POST /api/v1/positions.
 * Hermetic: memory stores behind the real REST registration. Every text and number below is TEST content.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { memoryAdlDisclosureStore, presentAdlDisclosureWire, ADL_DISCLOSURE_VERSION } from './adl-disclosure.js';
import { derivativesAccessGate } from './derivatives-access.js';
import {
  assessEligibility,
  memoryEligibilityStore,
  presentQuestions,
  readEligibilityState,
  type EligibilityRules,
} from './derivatives-eligibility.js';
import {
  acceptAgreement,
  agreementTextId,
  AGREEMENT_KINDS,
  memoryRiskAgreementStore,
  readAgreementView,
  type AgreementKind,
} from './risk-agreements.js';

const SECRET = 'a-trade-derivatives-access-public-door-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-10-20T10:00:00.000Z');

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['trade:read', 'trade:write'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function headers(p: Principal = principal(), region = 'DE'): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
    'x-intafaced-region': region,
  };
}

const RULES: EligibilityRules = {
  version: 1,
  questions: [
    {
      id: 'q1',
      prompt: 'TEST one',
      options: [
        { id: 'a', text: 'TEST a' },
        { id: 'b', text: 'TEST b' },
      ],
      correctOptionId: 'a',
    },
  ],
  passMark: 1,
  minKycTier: 'basic',
  createdAt: AT,
};

function publish(store: ReturnType<typeof memoryRiskAgreementStore>, kind: AgreementKind, n: number, regions: string[]) {
  store.publish({
    kind,
    version: n,
    publishedAt: AT,
    texts: regions.map((region) => ({
      region,
      textId: agreementTextId(kind, n, region),
      title: `TEST ${kind}`,
      body: `TEST body ${kind} v${n}`,
      bodySha256: 'sha256:test',
    })),
  });
}

const POSITION = {
  symbol: 'BTC/USDT-PERP',
  side: 'long',
  size: '1',
  leverage: '2',
  marginMode: 'isolated',
  clientOpenId: 'open-1',
};

function harness() {
  const agreements = memoryRiskAgreementStore();
  const eligibility = memoryEligibilityStore();
  const gate = derivativesAccessGate({ agreements, eligibility });
  const adl = memoryAdlDisclosureStore();
  const opened: unknown[] = [];
  const deps = {
    edgeSecret: SECRET,
    icebergDisplayRule: null,
    serviceName: 'svc-trade',
    openOrders: async () => [],
    orderHistory: async () => [],
    getOrder: async () => {
      throw new Error('unused');
    },
    placeOrder: async () => {
      throw new Error('unused');
    },
    cancelOrder: async () => {
      throw new Error('unused');
    },
    cancelAllOrders: async () => [],
    massCancelOrders: async () => [],
    myFills: async () => [],
    marketBySymbol: async () => null,
    marketById: async () => null,
    markets: async () => [],
    userBalances: async () => [],
    listPositions: async () => [],
    listClosedPositions: async () => [],
    getPosition: async () => {
      throw new Error('unused');
    },
    openPosition: async (p, input) => {
      await gate({ userId: p.userId, tier: p.tier, region: input.region ?? null });
      opened.push(input);
      return { id: 'pos-1', symbol: input.symbol, side: input.side, status: 'open' } as never;
    },
    closePosition: async () => {
      throw new Error('unused');
    },
    setLeverage: async () => {
      throw new Error('unused');
    },
    addIsolatedMargin: async () => {
      throw new Error('unused');
    },
    reduceIsolatedMargin: async () => {
      throw new Error('unused');
    },
    getOpenMarginCall: async () => null,
    getAdlDisclosure: async (p) => presentAdlDisclosureWire(await adl.getAck(p.userId)),
    ackAdlDisclosure: async (p) => presentAdlDisclosureWire(await adl.recordAck(p.userId, ADL_DISCLOSURE_VERSION, AT)),
    listAdlDisclosureEvents: async () => [],
    getAgreements: async (p, region) => Promise.all(AGREEMENT_KINDS.map((k) => readAgreementView(agreements, p.userId, k, region))),
    acceptAgreement: async (p, input) => acceptAgreement(agreements, { userId: p.userId, ...input, now: AT }),
    getDerivativesEligibility: async (p) => {
      const rules = await eligibility.currentRules();
      return { state: await readEligibilityState(eligibility, p.userId, p.tier), questions: rules ? presentQuestions(rules) : null };
    },
    assessDerivativesEligibility: async (p, input) =>
      assessEligibility(eligibility, { userId: p.userId, submissionId: input.clientSubmissionId, answers: input.answers, now: AT }),
  } satisfies PrivateRestDeps;
  return { deps: deps as PrivateRestDeps, agreements, eligibility, opened };
}

async function appFor(deps: PrivateRestDeps) {
  const app = Fastify();
  registerPrivateRest(app, deps);
  await app.ready();
  return app;
}

const post = (app: Awaited<ReturnType<typeof appFor>>, url: string, payload: unknown, p?: Principal, region?: string) =>
  app.inject({ method: 'POST', url, headers: headers(p, region), payload: payload as never });

describe('POST /api/v1/positions is gated by agreements and eligibility', () => {
  it('nothing published: 403 trade.agreement_unpublished, nothing opened', async () => {
    const h = harness();
    const app = await appFor(h.deps);
    const res = await post(app, '/api/v1/positions', POSITION);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'trade.agreement_unpublished' });
    expect(h.opened).toEqual([]);
    await app.close();
  });

  it('a region with no text: 403 trade.agreement_region_unavailable', async () => {
    const h = harness();
    publish(h.agreements, 'derivatives_risk', 1, ['GB']);
    const app = await appFor(h.deps);
    const res = await post(app, '/api/v1/positions', POSITION, undefined, 'DE');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'trade.agreement_region_unavailable', region: 'DE' });
    await app.close();
  });

  it('given v2 is published and v1 was accepted: 403 trade.agreement_required with the document id', async () => {
    const h = harness();
    publish(h.agreements, 'derivatives_risk', 1, ['DE']);
    const app = await appFor(h.deps);
    expect((await post(app, '/api/v1/account/agreements/accept', { kind: 'derivatives_risk', version: 1 })).statusCode).toBe(200);
    publish(h.agreements, 'derivatives_risk', 2, ['DE']);
    const res = await post(app, '/api/v1/positions', POSITION);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'trade.agreement_required',
      kind: 'derivatives_risk',
      version: 2,
      documentId: 'derivatives_risk:v2:DE',
    });
    expect(h.opened).toEqual([]);
    await app.close();
  });

  it('accepted but no suitability rules published: 403 trade.derivatives_eligibility_unset (rules_unpublished)', async () => {
    const h = harness();
    publish(h.agreements, 'derivatives_risk', 1, ['DE']);
    const app = await appFor(h.deps);
    await post(app, '/api/v1/account/agreements/accept', { kind: 'derivatives_risk', version: 1 });
    const res = await post(app, '/api/v1/positions', POSITION);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'trade.derivatives_eligibility_unset', reason: 'rules_unpublished' });
    await app.close();
  });

  it('rules published, tier below the rule: 403 trade.identity_level_insufficient; then the open succeeds at the tier', async () => {
    const h = harness();
    publish(h.agreements, 'derivatives_risk', 1, ['DE']);
    h.eligibility.publish({ ...RULES, minKycTier: 'full' });
    const app = await appFor(h.deps);
    const low = principal({ tier: 'basic' });
    await post(app, '/api/v1/account/agreements/accept', { kind: 'derivatives_risk', version: 1 }, low);
    const quiz = await post(
      app,
      '/api/v1/account/derivatives-eligibility/assess',
      { clientSubmissionId: 'sub-1', answers: { q1: 'a' } },
      low,
    );
    expect(quiz.json()).toMatchObject({ passed: true, created: true });
    const refused = await post(app, '/api/v1/positions', POSITION, low);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'trade.identity_level_insufficient', requiredTier: 'full', currentTier: 'basic' });

    const ok = await post(app, '/api/v1/positions', POSITION, principal({ tier: 'full' }));
    expect(ok.statusCode).toBe(200);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toMatchObject({ region: 'DE' });
    await app.close();
  });
});

describe('agreement and eligibility doors', () => {
  it('GET /account/agreements lists both kinds for the region, unavailable ones with the reason', async () => {
    const h = harness();
    publish(h.agreements, 'derivatives_risk', 1, ['DE']);
    const app = await appFor(h.deps);
    const res = await app.inject({ method: 'GET', url: '/api/v1/account/agreements', headers: headers() });
    expect(res.statusCode).toBe(200);
    const { agreements } = res.json() as { agreements: Array<Record<string, unknown>> };
    expect(agreements.find((a) => a.kind === 'derivatives_risk')).toMatchObject({ available: true, version: 1, accepted: false });
    expect(agreements.find((a) => a.kind === 'margin_terms')).toMatchObject({ available: false, reason: 'trade.agreement_unpublished' });
    await app.close();
  });

  it('accept is idempotent (first time kept), a stale version is 409, an unknown kind is 400', async () => {
    const h = harness();
    publish(h.agreements, 'derivatives_risk', 1, ['DE']);
    const app = await appFor(h.deps);
    const first = await post(app, '/api/v1/account/agreements/accept', { kind: 'derivatives_risk', version: 1 });
    const again = await post(app, '/api/v1/account/agreements/accept', { kind: 'derivatives_risk', version: 1 });
    expect(first.json()).toMatchObject({ created: true, textId: 'derivatives_risk:v1:DE' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false });
    expect(h.agreements.accepted()).toHaveLength(1);
    const stale = await post(app, '/api/v1/account/agreements/accept', { kind: 'derivatives_risk', version: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'trade.agreement_version_stale', currentVersion: 1 });
    const unknown = await post(app, '/api/v1/account/agreements/accept', { kind: 'nope', version: 1 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: 'trade.agreement_kind_unknown' });
    await app.close();
  });

  it('accept needs trade:write; reads need trade:read', async () => {
    const h = harness();
    publish(h.agreements, 'derivatives_risk', 1, ['DE']);
    const app = await appFor(h.deps);
    const readOnly = principal({ scopes: ['trade:read'] });
    expect((await post(app, '/api/v1/account/agreements/accept', { kind: 'derivatives_risk', version: 1 }, readOnly)).statusCode).toBe(403);
    const noScope = principal({ scopes: [] });
    expect((await app.inject({ method: 'GET', url: '/api/v1/account/agreements', headers: headers(noScope) })).statusCode).toBe(403);
    expect(h.agreements.accepted()).toEqual([]);
    await app.close();
  });

  it('GET eligibility shows unset with no questions while the rules are blank, and never the scoring key once published', async () => {
    const h = harness();
    const app = await appFor(h.deps);
    const blank = await app.inject({ method: 'GET', url: '/api/v1/account/derivatives-eligibility', headers: headers() });
    expect(blank.statusCode).toBe(200);
    expect(blank.json()).toMatchObject({ state: { status: 'unset', reason: 'rules_unpublished' }, questions: null });
    const refused = await post(app, '/api/v1/account/derivatives-eligibility/assess', { clientSubmissionId: 's', answers: { q1: 'a' } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'trade.derivatives_eligibility_unset', reason: 'rules_unpublished' });

    h.eligibility.publish(RULES);
    const live = await app.inject({ method: 'GET', url: '/api/v1/account/derivatives-eligibility', headers: headers() });
    expect(live.body).not.toContain('correctOptionId');
    expect(live.json()).toMatchObject({ state: { status: 'unset', reason: 'not_assessed', passMark: 1 }, questions: [{ id: 'q1' }] });
    await app.close();
  });

  it('assess: bad answers are 400, a repeat submission id is idempotent, other answers on it are 409', async () => {
    const h = harness();
    h.eligibility.publish(RULES);
    const app = await appFor(h.deps);
    const bad = await post(app, '/api/v1/account/derivatives-eligibility/assess', { clientSubmissionId: 's1', answers: { q1: 'zz' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'trade.eligibility_answers_invalid' });
    const ok = await post(app, '/api/v1/account/derivatives-eligibility/assess', { clientSubmissionId: 's1', answers: { q1: 'a' } });
    expect(ok.json()).toMatchObject({ passed: true, created: true });
    const repeat = await post(app, '/api/v1/account/derivatives-eligibility/assess', { clientSubmissionId: 's1', answers: { q1: 'a' } });
    expect(repeat.json()).toMatchObject({ passed: true, created: false });
    const conflict = await post(app, '/api/v1/account/derivatives-eligibility/assess', { clientSubmissionId: 's1', answers: { q1: 'b' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'trade.eligibility_submission_conflict' });
    await app.close();
  });

  it('doors that are not wired refuse trade.agreements_unconfigured instead of answering empty', async () => {
    const h = harness();
    const { getAgreements, acceptAgreement: _a, getDerivativesEligibility, assessDerivativesEligibility, ...rest } = h.deps;
    void getAgreements;
    void _a;
    void getDerivativesEligibility;
    void assessDerivativesEligibility;
    const app = await appFor(rest as PrivateRestDeps);
    const read = await app.inject({ method: 'GET', url: '/api/v1/account/agreements', headers: headers() });
    expect(read.statusCode).toBe(403);
    expect(read.json()).toMatchObject({ error: 'trade.agreements_unconfigured' });
    const accept = await post(app, '/api/v1/account/agreements/accept', { kind: 'derivatives_risk', version: 1 });
    expect(accept.json()).toMatchObject({ error: 'trade.agreements_unconfigured' });
    await app.close();
  });
});
