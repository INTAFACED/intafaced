/**
 * D-account-07 public doors: the identity-level gate in front of POST /api/v1/positions. No agreement, quiz or notice
 * gates an open and their customer doors are gone (owner decision 2026-10-27). Hermetic: memory stores behind the real
 * REST registration. Every text and number below is TEST content.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { memoryAdlDisclosureStore, presentAdlDisclosureWire, ADL_DISCLOSURE_VERSION } from './adl-disclosure.js';
import { derivativesAccessGate } from './derivatives-access.js';
import { memoryEligibilityStore, type EligibilityRules } from './derivatives-eligibility.js';

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

const POSITION = {
  symbol: 'BTC/USDT-PERP',
  side: 'long',
  size: '1',
  leverage: '2',
  marginMode: 'isolated',
  clientOpenId: 'open-1',
};

function harness() {
  const eligibility = memoryEligibilityStore();
  const gate = derivativesAccessGate({ eligibility });
  const adl = memoryAdlDisclosureStore();
  const opened: unknown[] = [];
  const deps = {
    edgeSecret: SECRET,
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
  } satisfies PrivateRestDeps;
  return { deps: deps as PrivateRestDeps, eligibility, opened };
}

async function appFor(deps: PrivateRestDeps) {
  const app = Fastify();
  registerPrivateRest(app, deps);
  await app.ready();
  return app;
}

const post = (app: Awaited<ReturnType<typeof appFor>>, url: string, payload: unknown, p?: Principal, region?: string) =>
  app.inject({ method: 'POST', url, headers: headers(p, region), payload: payload as never });

describe('POST /api/v1/positions is gated by the identity level only', () => {
  it('nothing published: 403 trade.identity_level_unset, and nothing opens (a blank tier stays blank)', async () => {
    const h = harness();
    const app = await appFor(h.deps);
    const res = await post(app, '/api/v1/positions', POSITION);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'trade.identity_level_unset' });
    expect(h.opened).toEqual([]);
    await app.close();
  });

  it('the published tier met: the open goes through with no agreement, quiz or notice (owner decision 2026-10-27)', async () => {
    const h = harness();
    h.eligibility.publish({ ...RULES, minKycTier: 'basic' });
    const app = await appFor(h.deps);
    const res = await post(app, '/api/v1/positions', POSITION, principal({ tier: 'basic' }));
    expect(res.statusCode).toBe(200);
    expect(h.opened).toHaveLength(1);
    await app.close();
  });

  it('rules published, tier below the rule: 403 trade.identity_level_insufficient; then the open succeeds at the tier', async () => {
    const h = harness();
    h.eligibility.publish({ ...RULES, minKycTier: 'full' });
    const app = await appFor(h.deps);
    const refused = await post(app, '/api/v1/positions', POSITION, principal({ tier: 'basic' }));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'trade.identity_level_insufficient', requiredTier: 'full', currentTier: 'basic' });
    expect(h.opened).toEqual([]);

    const ok = await post(app, '/api/v1/positions', POSITION, principal({ tier: 'full' }));
    expect(ok.statusCode).toBe(200);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toMatchObject({ region: 'DE' });
    await app.close();
  });
});

describe('the removed customer doors', () => {
  it('agreements and the suitability quiz are no longer served', async () => {
    const h = harness();
    const app = await appFor(h.deps);
    for (const url of ['/api/v1/account/agreements', '/api/v1/account/derivatives-eligibility']) {
      expect((await app.inject({ method: 'GET', url, headers: headers() })).statusCode).toBe(404);
    }
    for (const url of ['/api/v1/account/agreements/accept', '/api/v1/account/derivatives-eligibility/assess']) {
      expect((await post(app, url, {})).statusCode).toBe(404);
    }
    await app.close();
  });
});
