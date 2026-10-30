/**
 * trade.ccxt-api capability matrix — claim ≡ wire (D26-P1-T5 / paste-w10 L02 A1).
 *
 * Break: matrix says supported but route missing; matrix says 501 but wire 404;
 * refuse arm code drifts; REST_ROUTES entry not inventoried.
 * Done bar: bot-readable matrix + tests that fail on claim≠wire.
 * Class N. Paths: svc-trade only (public/private REST).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { REST_ROUTES } from '@intafaced/exchange-contract';
import {
  CALLER_REFUSED_PRICE_FIELDS,
  CCXT_CAPABILITY_MATRIX,
  CCXT_LEVERAGE_REFUSE_IDS,
  CCXT_REFUSE_ARMS,
  danglingRefuseArmIds,
  leverageRefuseDrift,
  matrixRestRouteNames,
  orphanRefuseArmIds,
  refuseArmById,
  refuseOnlyRoutes,
} from './ccxt-capability-matrix.js';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from './public-rest.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicRestSource = readFileSync(join(here, 'public-rest.ts'), 'utf8');
const privateRestSource = readFileSync(join(here, 'private-rest.ts'), 'utf8');
const spotOrderPreviewSource = readFileSync(join(here, 'spot/order-preview-rest.ts'), 'utf8');
const statementRestSource = readFileSync(join(here, 'statements/statement-rest.ts'), 'utf8');
const positionServiceSource = readFileSync(join(here, 'futures/position-service.ts'), 'utf8');
const marginModeSource = readFileSync(join(here, 'futures/margin-mode.ts'), 'utf8');
const privateMountSource = `${privateRestSource}\n${spotOrderPreviewSource}\n${statementRestSource}`;

const SECRET = 'a-ccxt-capability-matrix-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal(), region = 'DE'): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
    'x-intafaced-region': region,
  };
}

function emptyDepth() {
  return { bids: [] as [string, string][], asks: [] as [string, string][], sequence: 0 };
}

function publicDeps(over: Partial<PublicRestDeps> = {}): PublicRestDeps {
  const markets = [fakeMarket({ symbol: 'BTC/USDT', kind: 'spot' })];
  return {
    markets: async () => markets,
    marketBySymbol: async (symbol) => markets.find((m) => m.symbol === symbol) ?? null,
    depth: async () => emptyDepth(),
    publicTape: async () => [],
    candles: async () => [],
    ...over,
  };
}

function privateDeps(over: Partial<PrivateRestDeps> = {}): PrivateRestDeps {
  const market = fakeMarket({ symbol: 'BTC/USDT' });
  return {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    openOrders: async () => [],
    orderHistory: async () => [],
    getOrder: async () => {
      throw new Error('getOrder should not run in matrix refuse tests');
    },
    placeOrder: async () => {
      throw new Error('placeOrder should not run in matrix refuse tests');
    },
    cancelOrder: async () => {
      throw new Error('cancelOrder should not run in matrix refuse tests');
    },
    cancelAllOrders: async () => [],
    massCancelOrders: async () => [],
    myFills: async () => [],
    marketBySymbol: async (symbol) => (symbol === market.symbol ? market : null),
    marketById: async (id) => (id === market.id ? market : null),
    markets: async () => [market],
    userBalances: async () => [],
    listPositions: async () => [],
    listClosedPositions: async () => [],
    getPosition: async () => {
      throw new Error('getPosition should not run in this matrix test');
    },
    openPosition: async () => {
      throw new Error('openPosition should not run when price refused');
    },
    closePosition: async () => {
      throw new Error('closePosition should not run when price refused');
    },
    setLeverage: async () => {
      throw new Error('setLeverage should not run in this matrix test');
    },
    addIsolatedMargin: async () => {
      throw new Error('addIsolatedMargin should not run in this matrix test');
    },
    reduceIsolatedMargin: async () => {
      throw new Error('reduceIsolatedMargin should not run in this matrix test');
    },
    getOpenMarginCall: async () => null,
    getAdlDisclosure: async () => ({
      version: 'DIRECTION-2026-07-31:34',
      copy: 'stub',
      acknowledged: false,
      acknowledgedAt: null,
    }),
    ackAdlDisclosure: async () => ({
      version: 'DIRECTION-2026-07-31:34',
      copy: 'stub',
      acknowledged: true,
      acknowledgedAt: new Date(0).toISOString(),
    }),
    listAdlDisclosureEvents: async () => [],
    ...over,
  };
}

/** Strip :param segments so Fastify mount string still matches matrix path template. */
function pathMountNeedle(path: string): string {
  // Matrix uses '/api/v1/funding-rate/:symbol' — source has same template or quoted form.
  return path;
}

describe('ccxt capability matrix — inventory integrity', () => {
  it('every REST_ROUTES name appears exactly once in the matrix', () => {
    const contractNames = Object.keys(REST_ROUTES).sort();
    const matrixNames = [...matrixRestRouteNames()].sort();
    expect(matrixNames).toEqual(contractNames);
  });

  it('matrix method/path/scope match REST_ROUTES for contract rows', () => {
    for (const row of CCXT_CAPABILITY_MATRIX) {
      if (!(row.name in REST_ROUTES)) continue;
      const r = REST_ROUTES[row.name as keyof typeof REST_ROUTES];
      expect(row.method, row.name).toBe(r.method);
      expect(row.path, row.name).toBe(r.path);
      expect(row.scope, row.name).toBe(r.scope);
      expect(row.auth, row.name).toBe(r.scope === null ? 'public' : 'private');
    }
  });

  it('refuse arm graph is closed (no dangling, no orphan)', () => {
    expect(danglingRefuseArmIds()).toEqual([]);
    expect(orphanRefuseArmIds()).toEqual([]);
  });

  it('done-bar refuse arms are named and stable', () => {
    const ids = CCXT_REFUSE_ARMS.map((a) => a.id).sort();
    expect(ids).toEqual(
      [
        'addIsolatedMarginInsufficient',
        'callerPriceOnClose',
        'cancelNotClose',
        'callerPriceOnOpen',
        'crossMarginOnOpen',
        'fundingRateSpot',
        'fundingRateUnavailable',
        'futuresUnconfiguredOnOpen',
        'identityLevelInsufficientOnOpen',
        'identityLevelUnavailableOnOpen',
        'identityLevelUnsetOnOpen',
        'leverageRequiredOnOpen',
        'profitSourceUnconfiguredOnClose',
        'reduceIsolatedMarginBelowInitial',
        'reduceIsolatedMarginWouldLiquidate',
        'setLeverageInsufficientMargin',
        'setLeverageTooHigh',
        'setLeverageWouldLiquidate',
        'setMarginMode',
      ].sort(),
    );
    expect(
      refuseOnlyRoutes()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['setMarginMode']);
  });

  it('setMarginMode stays refuse 501; setLeverage is a supported 200 path within 10×', () => {
    expect([...leverageRefuseDrift()]).toEqual([]);
    expect(CCXT_LEVERAGE_REFUSE_IDS).toEqual(['setMarginMode']);
    const lev = CCXT_CAPABILITY_MATRIX.find((r) => r.name === 'setLeverage')!;
    expect(lev.kind).toBe('supported');
    expect(lev.kind).not.toBe('refuse');
    const mode = CCXT_CAPABILITY_MATRIX.find((r) => r.name === 'setMarginMode')!;
    expect(mode.kind).toBe('refuse');
    const arm = refuseArmById('setMarginMode')!;
    expect(arm.httpStatus).toBe(501);
    expect(arm.ccxtCode).toBe('NotSupported');
  });

  it('caller-refused price fields pin private-rest PRICE_FIELDS', () => {
    // private-rest: const PRICE_FIELDS = ['entryPrice', 'exitPrice', 'price', 'markPrice']
    for (const field of CALLER_REFUSED_PRICE_FIELDS) {
      expect(privateRestSource, `private-rest missing refused field ${field}`).toContain(`'${field}'`);
    }
    expect(privateRestSource).toContain("error: 'trade.price_not_accepted'");
    const arm = refuseArmById('callerPriceOnClose')!;
    expect(arm.intafacedCode).toBe('trade.price_not_accepted');
    expect(arm.httpStatus).toBe(400);
  });

  it('openPosition refuse arms pin private-rest domain codes', () => {
    expect(privateRestSource).toContain('checkMarginModeForFuturesOpen');
    expect(privateRestSource).toContain('crossMarginRefusal');
    expect(marginModeSource).toContain("'trade.cross_margin_unsupported'");
    expect(marginModeSource).toContain("'trade.portfolio_margin_unset'");
    expect(marginModeSource).toContain("'trade.unsupported_collateral_class'");
    expect(privateRestSource).toContain("'trade.leverage_required'");
    expect(privateRestSource).toContain("'/api/v1/futures/adl-disclosure'");
    expect(privateRestSource).toContain("'/api/v1/futures/adl-disclosure/ack'");
    expect(privateRestSource).toContain("'/api/v1/futures/adl-events'");
    // No agreement, quiz or ADL acknowledgement refuses an open (owner decision 2026-10-27).
    expect(refuseArmById('adlDisclosureRequired')).toBeUndefined();
    expect(refuseArmById('agreementRequiredOnOpen')).toBeUndefined();
    expect(refuseArmById('derivativesEligibilityUnsetOnOpen')).toBeUndefined();
    expect(privateRestSource).toContain('isDerivativesAccessError');
    expect(privateRestSource).not.toContain("'/api/v1/account/agreements'");
    expect(privateRestSource).not.toContain("'/api/v1/account/derivatives-eligibility'");
    for (const [id, code] of [
      ['identityLevelInsufficientOnOpen', 'trade.identity_level_insufficient'],
      ['identityLevelUnavailableOnOpen', 'trade.identity_level_unavailable'],
    ] as const) {
      expect(refuseArmById(id)!.httpStatus).toBe(403);
      expect(refuseArmById(id)!.intafacedCode).toBe(code);
    }
    expect(privateRestSource).toContain('FuturesError');
    const unconfigured = refuseArmById('futuresUnconfiguredOnOpen')!;
    expect(unconfigured.httpStatus).toBe(403);
    expect(unconfigured.intafacedCode).toBe('trade.futures_unconfigured');
    expect(unconfigured.ccxtCode).toBe('NotSupported');
    expect(positionServiceSource).toContain("'trade.futures_unconfigured', 403");
    const closeUnconfigured = refuseArmById('profitSourceUnconfiguredOnClose')!;
    expect(closeUnconfigured.httpStatus).toBe(403);
    expect(closeUnconfigured.intafacedCode).toBe('trade.profit_source_unconfigured');
    expect(closeUnconfigured.ccxtCode).toBe('NotSupported');
    expect(positionServiceSource).toContain("'trade.profit_source_unconfigured'");
  });

  it('extension inventory includes capabilities + ADL doors (not only REST_ROUTES)', () => {
    const names = CCXT_CAPABILITY_MATRIX.map((r) => r.name);
    expect(names).toContain('fetchCapabilities');
    expect(names).toContain('fetchAdlDisclosure');
    expect(names).toContain('ackAdlDisclosure');
    expect(names).toContain('fetchAdlDisclosureEvents');
    expect(names).not.toContain('fetchAgreements');
    expect(names).not.toContain('acceptAgreement');
    expect(names).not.toContain('fetchDerivativesEligibility');
    expect(names).not.toContain('assessDerivativesEligibility');
    expect(names).toContain('fetchClosedPositions');
    expect(names).toContain('fetchPosition');
    expect(names).toContain('fetchPositionMarginCall');
    expect(names).toContain('previewOrder');
    expect(names).toContain('batchAmendOrders');
    expect(names).toContain('massCancelOrders');
  });
});

describe('ccxt capability matrix — claim ≡ mount source', () => {
  it('every public matrix path is mounted in public-rest.ts', () => {
    for (const row of CCXT_CAPABILITY_MATRIX.filter((r) => r.auth === 'public')) {
      const needle = pathMountNeedle(row.path);
      expect(publicRestSource, `public-rest missing mount ${row.method} ${needle}`).toContain(`'${needle}'`);
    }
  });

  it('every private matrix path is mounted in private-rest.ts or a sibling private register', () => {
    for (const row of CCXT_CAPABILITY_MATRIX.filter((r) => r.auth === 'private')) {
      const needle = pathMountNeedle(row.path);
      expect(privateMountSource, `private mount missing ${row.method} ${needle}`).toContain(`'${needle}'`);
    }
  });

  it('setMarginMode stays 501; setLeverage is a live isolated path that can 200', () => {
    expect(privateRestSource).not.toMatch(
      /app\.post\('\/api\/v1\/positions\/leverage',\s*(?:privateWrite,\s*)?derivativesNotSupported\('setLeverage'/,
    );
    expect(privateRestSource).toContain("app.post('/api/v1/positions/leverage'");
    expect(privateRestSource).toMatch(
      /app\.post\('\/api\/v1\/positions\/margin-mode',\s*privateWrite,\s*derivativesNotSupported\('setMarginMode'/,
    );
    expect(privateRestSource).toContain('setMarginMode must stay 501');
    expect(privateRestSource).toContain('notSupported(');
    expect(privateRestSource).toContain('reply.code(200).send(pos)');
    expect(publicRestSource).not.toContain("app.post('/api/v1/positions/leverage'");
    expect(publicRestSource).not.toContain("app.post('/api/v1/positions/margin-mode'");
  });

  it('funding-rate refuse codes appear in public-rest', () => {
    expect(publicRestSource).toContain("'trade.funding_rate_spot_market'");
    expect(publicRestSource).toContain("'trade.funding_rate_unavailable'");
    expect(publicRestSource).toContain("'/api/v1/funding-rate/:symbol'");
  });
});

describe('ccxt capability matrix — claim ≡ wire (inject)', () => {
  it('setLeverage supported: signed → 200 from the injected service', async () => {
    const app = Fastify();
    registerPrivateRest(
      app,
      privateDeps({
        setLeverage: async () => ({ id: 'pos-1', symbol: 'BTC/USDT', leverage: '5' }) as never,
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/leverage',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', positionId: 'pos-1', leverage: '5', clientAdjustmentId: 'ccxt-set-leverage-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().leverage).toBe('5');
    await app.close();
  });

  it('addIsolatedMargin supported: signed → 200 from the injected service', async () => {
    const app = Fastify();
    registerPrivateRest(
      app,
      privateDeps({
        addIsolatedMargin: async () => ({ id: 'pos-1', symbol: 'BTC/USDT', collateral: '7500' }) as never,
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', positionId: 'pos-1', amount: '2500', clientAdjustmentId: 'ccxt-add-margin-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().collateral).toBe('7500');
    await app.close();
  });

  it('fetchClosedPositions supported: signed → 200 [] when none', async () => {
    const app = Fastify();
    registerPrivateRest(app, privateDeps());
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions/closed?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('fetchPosition supported: signed → 200 from the injected service', async () => {
    const app = Fastify();
    registerPrivateRest(
      app,
      privateDeps({
        getPosition: async () => ({ id: 'pos-1', symbol: 'BTC/USDT', status: 'open' }) as never,
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions/pos-1',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('pos-1');
    await app.close();
  });

  it('reduceIsolatedMargin supported: signed → 200 from the injected service', async () => {
    const app = Fastify();
    registerPrivateRest(
      app,
      privateDeps({
        reduceIsolatedMargin: async () => ({ id: 'pos-1', symbol: 'BTC/USDT', collateral: '5000' }) as never,
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin/reduce',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', positionId: 'pos-1', amount: '2500', clientAdjustmentId: 'ccxt-reduce-margin-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().collateral).toBe('5000');
    await app.close();
  });

  it('setLeverageTooHigh arm: signed → 400 domain, never clamped to 10×', async () => {
    const arm = refuseArmById('setLeverageTooHigh')!;
    const { FuturesError } = await import('./futures/position-service.js');
    const app = Fastify();
    registerPrivateRest(
      app,
      privateDeps({
        setLeverage: async () => {
          throw new FuturesError('11x exceeds 10x', arm.intafacedCode, 400);
        },
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: arm.path,
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', positionId: 'pos-1', leverage: '11', clientAdjustmentId: 'ccxt-set-too-high-1' },
    });
    expect(res.statusCode).toBe(arm.httpStatus);
    expect(res.json().error).toBe(arm.intafacedCode);
    await app.close();
  });

  it('setMarginMode refuse arm: signed → matrix httpStatus + codes', async () => {
    const arm = refuseArmById('setMarginMode')!;
    const app = Fastify();
    registerPrivateRest(app, privateDeps());
    await app.ready();
    const res = await app.inject({
      method: arm.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS',
      url: arm.path,
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: { symbol: 'BTC/USDT', marginMode: 'cross' },
    });
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBe(arm.httpStatus);
    expect(arm.httpStatus).toBe(501);
    expect(res.json().code).toBe(arm.ccxtCode);
    expect(res.json().intafacedCode).toBe(arm.intafacedCode);
    expect(JSON.stringify(res.json())).not.toMatch(/"marginMode"\s*:/);
    await app.close();
  });

  it('fundingRateSpot refuse arm: spot market → 501 NotSupported, no fundingRate field', async () => {
    const arm = refuseArmById('fundingRateSpot')!;
    const app = Fastify();
    registerPublicRest(app, publicDeps());
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT' });
    expect(res.statusCode).toBe(arm.httpStatus);
    expect(res.json().code).toBe(arm.ccxtCode);
    expect(res.json().intafacedCode).toBe(arm.intafacedCode);
    expect(JSON.stringify(res.json())).not.toMatch(/"fundingRate"/);
    await app.close();
  });

  it('fundingRateUnavailable refuse arm: futures, no published rate → 501', async () => {
    const arm = refuseArmById('fundingRateUnavailable')!;
    const perp = fakeMarket({
      id: '00000000-0000-4000-8000-000000000099',
      symbol: 'BTC/USDT-PERP',
      kind: 'futures',
    });
    const app = Fastify();
    registerPublicRest(
      app,
      publicDeps({
        markets: async () => [perp],
        marketBySymbol: async (s) => (s === perp.symbol ? perp : null),
        fundingRateForMarket: async () => null,
      }),
    );
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT-PERP' });
    expect(res.statusCode).toBe(arm.httpStatus);
    expect(res.json().code).toBe(arm.ccxtCode);
    expect(res.json().intafacedCode).toBe(arm.intafacedCode);
    expect(JSON.stringify(res.json())).not.toMatch(/"fundingRate"/);
    await app.close();
  });

  it('callerPriceOnClose refuse arm: exitPrice query → 400, closePosition never called', async () => {
    const arm = refuseArmById('callerPriceOnClose')!;
    let closed = false;
    const app = Fastify();
    registerPrivateRest(
      app,
      privateDeps({
        closePosition: async () => {
          closed = true;
          throw new Error('should not close');
        },
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/positions/pos-1?exitPrice=999999`,
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(arm.httpStatus);
    expect(res.json().error).toBe(arm.intafacedCode);
    expect(res.json().message).toContain('exitPrice');
    expect(closed).toBe(false);
    await app.close();
  });

  it('callerPriceOnOpen refuse arm: entryPrice body → 400, openPosition never called', async () => {
    const arm = refuseArmById('callerPriceOnOpen')!;
    let opened = false;
    const app = Fastify();
    registerPrivateRest(
      app,
      privateDeps({
        openPosition: async () => {
          opened = true;
          throw new Error('should not open');
        },
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        symbol: 'BTC/USDT',
        side: 'long',
        size: '1',
        leverage: '2',
        entryPrice: '50000',
      },
    });
    expect(res.statusCode).toBe(arm.httpStatus);
    expect(res.json().error).toBe(arm.intafacedCode);
    expect(res.json().message).toContain('entryPrice');
    expect(opened).toBe(false);
    await app.close();
  });

  it('crossMarginOnOpen refuse arm: marginMode cross → 400, openPosition never called', async () => {
    const arm = refuseArmById('crossMarginOnOpen')!;
    let opened = false;
    const app = Fastify();
    registerPrivateRest(
      app,
      privateDeps({
        openPosition: async () => {
          opened = true;
          throw new Error('should not open');
        },
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: { ...signedHeaders(), 'content-type': 'application/json' },
      payload: {
        symbol: 'BTC/USDT',
        side: 'long',
        size: '1',
        leverage: '2',
        clientOpenId: 'matrix-cross-refuse-1',
        marginMode: 'cross',
      },
    });
    expect(res.statusCode).toBe(arm.httpStatus);
    expect(res.json().error).toBe(arm.intafacedCode);
    expect(opened).toBe(false);
    await app.close();
  });

  it('GET /capabilities serves the matrix claim with the ADL disclosure door and no ADL refuse arm', async () => {
    const app = Fastify();
    registerPublicRest(app, publicDeps());
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      routes: Array<{ name: string; kind?: string; refuseArmIds?: string[] }>;
      refuseArms: Array<{ id: string; httpStatus: number }>;
    };
    expect(body.routes.some((r) => r.name === 'fetchAdlDisclosure')).toBe(true);
    expect(body.routes.some((r) => r.name === 'openPosition' && r.refuseArmIds?.includes('adlDisclosureRequired'))).toBe(false);
    expect(body.refuseArms.some((a) => a.id === 'adlDisclosureRequired')).toBe(false);
    expect(body.refuseArms.some((a) => a.id === 'crossMarginOnOpen' && a.httpStatus === 400)).toBe(true);
    expect(body.refuseArms.some((a) => a.id === 'leverageRequiredOnOpen' && a.httpStatus === 400)).toBe(true);
    expect(body.routes.some((r) => r.name === 'openPosition' && r.refuseArmIds?.includes('futuresUnconfiguredOnOpen'))).toBe(true);
    expect(body.refuseArms.some((a) => a.id === 'futuresUnconfiguredOnOpen' && a.httpStatus === 403)).toBe(true);
    expect(body.routes.some((r) => r.name === 'closePosition' && r.refuseArmIds?.includes('cancelNotClose'))).toBe(true);
    expect(body.routes.some((r) => r.name === 'closePositionQuantity' && r.refuseArmIds?.includes('profitSourceUnconfiguredOnClose'))).toBe(
      true,
    );
    expect(body.refuseArms.some((a) => a.id === 'profitSourceUnconfiguredOnClose' && a.httpStatus === 403)).toBe(true);
    expect(body.routes.some((r) => r.name === 'setLeverage' && r.kind === 'supported')).toBe(true);
    expect(body.routes.some((r) => r.name === 'setMarginMode' && r.kind === 'refuse')).toBe(true);
    for (const id of CCXT_LEVERAGE_REFUSE_IDS) {
      const route = body.routes.find((r) => r.name === id);
      expect(route?.kind, id).toBe('refuse');
      expect(route?.kind, id).not.toBe('supported');
      const arm = body.refuseArms.find((a) => a.id === id);
      expect(arm?.httpStatus, id).toBe(501);
      expect(arm?.httpStatus, id).not.toBe(200);
    }
    await app.close();
  });

  it('supported public surface still answers (matrix kind=supported is not a lie)', async () => {
    const app = Fastify();
    registerPublicRest(app, publicDeps());
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });
});
