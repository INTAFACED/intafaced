import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { UNPUBLISHED_FEE_SCHEDULE } from '../spot/fee-schedule.js';
import type { Market } from '../spot/types.js';
import { liquidationPriceFor } from './liquidation-price.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import { perpetualFeeRates } from './matched-order-plan.js';
import { registerPositionPreviewRest } from './position-preview-rest.js';
import { registerRiskCalculatorRest, type RiskCalculatorRestDeps } from './risk-calculator-rest.js';

const EDGE_SECRET = 'risk-calculator-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const MARKET: Market = {
  id: 'fixture-perp',
  symbol: 'FIX/SETTLE',
  baseAsset: 'fixture-base',
  quoteAsset: 'fixture-settlement',
  kind: 'futures',
  tickSize: parseAmount('0.01'),
  lotSize: parseAmount('0.01'),
  minQty: parseAmount('0.01'),
  maxQty: null,
  minNotional: parseAmount('1'),
  status: 'active',
  makerBps: 1,
  takerBps: 2,
  listedAt: null,
  assetClass: 'crypto',
  schedule: 'crypto-24x7',
  paper: false,
};
const POLICY: FuturesLadderPolicy = {
  tiers: [
    { uptoDepthBps: 500, maintenanceBps: 50 },
    { uptoDepthBps: 2_000, maintenanceBps: 100 },
    { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 },
  ],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 2_500,
};

function headers(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

const DEPTH = { long: parseAmount('10000'), short: parseAmount('4000') };

function appWith(over: Partial<RiskCalculatorRestDeps> = {}) {
  const app = Fastify();
  registerRiskCalculatorRest(app, {
    edgeSecret: EDGE_SECRET,
    serviceName: 'svc-trade',
    marketBySymbol: async (symbol) => (symbol === MARKET.symbol ? MARKET : null),
    publishedLadder: () => POLICY,
    depthNotional: async ({ side }) => DEPTH[side],
    leverageCap: parseAmount('10'),
    takerFeeBps: async () => 5,
    ...over,
  });
  return app;
}

const calc = { symbol: MARKET.symbol, side: 'long', size: '1', entryPrice: '100', exitPrice: '110', leverage: '10' };

describe('GET /api/v1/futures/tiers', () => {
  it('publishes the owner’s tiers, their rates and the notional each takes at today’s depth', async () => {
    const app = appWith();
    const res = await app.inject({ method: 'GET', url: `/api/v1/futures/tiers?symbol=${encodeURIComponent(MARKET.symbol)}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      symbol: MARKET.symbol,
      tiers: [
        { tier: 1, uptoDepthBps: 500, maintenanceBps: 50, maintenanceRate: '0.005', notionalUpto: { long: '500', short: '200' } },
        { tier: 2, uptoDepthBps: 2000, maintenanceBps: 100, maintenanceRate: '0.01', notionalUpto: { long: '2000', short: '800' } },
        { tier: 3, uptoDepthBps: null, maintenanceBps: 500, maintenanceRate: '0.05', notionalUpto: { long: null, short: null } },
      ],
      depth: { long: '10000', short: '4000' },
      maxLeverage: '10',
      leverageBasis: 'listing_cap',
    });
    await app.close();
  });

  it('an unset ladder refuses with the ladder code; nothing is invented', async () => {
    const app = appWith({ publishedLadder: () => undefined });
    const res = await app.inject({ method: 'GET', url: `/api/v1/futures/tiers?symbol=${encodeURIComponent(MARKET.symbol)}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('trade.ladder_unset');
    await app.close();
  });

  it('an unreadable book leaves the bounds empty; the rates still show', async () => {
    const app = appWith({
      depthNotional: async () => {
        throw new Error('book unreachable');
      },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/futures/tiers?symbol=${encodeURIComponent(MARKET.symbol)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().depth).toEqual({ long: null, short: null });
    expect(res.json().tiers[0]).toMatchObject({ maintenanceBps: 50, notionalUpto: { long: null, short: null } });
    await app.close();
  });

  it('an unset leverage cap is named, never read as unlimited', async () => {
    const app = appWith({ leverageCap: null });
    const res = await app.inject({ method: 'GET', url: `/api/v1/futures/tiers?symbol=${encodeURIComponent(MARKET.symbol)}` });
    expect(res.json()).toMatchObject({ maxLeverage: null, leverageBasis: 'trade.leverage_cap_unset' });
    await app.close();
  });

  it('refuses a missing or spot symbol', async () => {
    const app = appWith({ marketBySymbol: async () => ({ ...MARKET, kind: 'spot' }) });
    expect((await app.inject({ method: 'GET', url: '/api/v1/futures/tiers' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/futures/tiers?symbol=X' })).json().error).toBe(
      'trade.futures_market_not_found',
    );
    await app.close();
  });
});

describe('POST /api/v1/futures/calculator', () => {
  it('works out margin, tier, liquidation price, P&L and fees for typed inputs, with the formulas', async () => {
    const app = appWith();
    const res = await app.inject({ method: 'POST', url: '/api/v1/futures/calculator', headers: headers(), payload: calc });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      notional: '100',
      initialMargin: '10',
      tier: 1,
      maintenanceBps: 50,
      maintenanceMargin: '0.5',
      liquidationPrice: '90.452261306532663317',
      pnl: '10',
      roePercent: '100',
      takerFeeBps: 5,
      entryFee: '0.05',
      exitFee: '0.055',
      netPnl: '9.895',
      basis: { prices: 'typed', maintenance: 'ladder_at_current_depth' },
      refusals: [],
    });
    expect(body.formulas.initialMargin).toBe('Initial margin = size × entry price ÷ leverage');
    expect(body.formulas.liquidationPrice).toMatch(/margin plus P&L equals the maintenance margin/);
    await app.close();
  });

  it('matches the preview to the unit when the entry is the mark', async () => {
    const mark = '61234.5';
    const preview = Fastify();
    registerPositionPreviewRest(preview, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-trade',
      marketBySymbol: async () => MARKET,
      markForMarket: async () => ({ price: mark, source: 'depth' }),
      leverageCap: parseAmount('10'),
      takerFeeBps: async () => 5,
      // index.ts's own wiring: the ladder at today's depth on the side the position closes into.
      liquidationPriceFor: async ({ side, size, markPrice, initialMargin }) =>
        liquidationPriceFor({ side, size, entryPrice: markPrice, margin: initialMargin, depthNotional: DEPTH[side], policy: POLICY }).price,
    });
    const app = appWith();
    for (const side of ['long', 'short'] as const) {
      const p = (
        await preview.inject({
          method: 'POST',
          url: '/api/v1/positions/preview',
          headers: headers(),
          payload: { symbol: MARKET.symbol, side, size: '0.37', leverage: '7' },
        })
      ).json();
      const c = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/futures/calculator',
          headers: headers(),
          payload: { symbol: MARKET.symbol, side, size: '0.37', entryPrice: mark, leverage: '7' },
        })
      ).json();
      expect(c.initialMargin).toBe(p.initialMargin);
      expect(c.liquidationPrice).toBe(p.liquidationPrice);
      expect(c.entryFee).toBe(p.estimatedFee);
    }
    await preview.close();
    await app.close();
  });

  it('an unset ladder still gives margin and P&L, and names the ladder code on the maintenance line', async () => {
    const app = appWith({ publishedLadder: () => undefined });
    const res = await app.inject({ method: 'POST', url: '/api/v1/futures/calculator', headers: headers(), payload: calc });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ initialMargin: '10', pnl: '10', tier: null, maintenanceMargin: null, liquidationPrice: null });
    expect(res.json().refusals).toEqual([expect.objectContaining({ code: 'trade.ladder_unset', field: 'maintenanceMargin' })]);
    await app.close();
  });

  it('an unpublished fee schedule empties the fee lines with its own code', async () => {
    const app = appWith({ takerFeeBps: async () => perpetualFeeRates(UNPUBLISHED_FEE_SCHEDULE, 0).takerBps });
    const res = await app.inject({ method: 'POST', url: '/api/v1/futures/calculator', headers: headers(), payload: calc });
    expect(res.json()).toMatchObject({ entryFee: null, exitFee: null, netPnl: null, takerFeeBps: null, pnl: '10' });
    expect(res.json().refusals[0]).toMatchObject({ code: 'trade.position_preview_fee_unavailable', field: 'fee' });
    expect(res.json().refusals[0].message).toMatch(/trade\.fee_schedule_blank/);
    await app.close();
  });

  it('leverage above the cap is shown with its refusal', async () => {
    const app = appWith({ leverageCap: parseAmount('5') });
    const res = await app.inject({ method: 'POST', url: '/api/v1/futures/calculator', headers: headers(), payload: calc });
    expect(res.json().refusals).toEqual([expect.objectContaining({ code: 'trade.leverage_too_high', field: 'leverage' })]);
    await app.close();
  });

  it('leverage finer than hundredths is refused as the order path refuses it', async () => {
    const app = appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/futures/calculator',
      headers: headers(),
      payload: { ...calc, leverage: '3.333' },
    });
    expect(res.json().refusals).toEqual([expect.objectContaining({ code: 'trade.leverage_invalid', field: 'leverage' })]);
    const fine = await app.inject({
      method: 'POST',
      url: '/api/v1/futures/calculator',
      headers: headers(),
      payload: { ...calc, leverage: '3.33' },
    });
    expect(fine.json().refusals).toEqual([]);
    await app.close();
  });

  it('refuses a signed-out caller, number-typed money, unknown fields and other margin variants', async () => {
    const app = appWith();
    const post = (payload: Record<string, unknown>, h: Record<string, string> = headers()) =>
      app.inject({ method: 'POST', url: '/api/v1/futures/calculator', headers: h, payload });
    expect((await post(calc, {})).statusCode).toBe(401);
    expect((await post({ ...calc, size: 1 })).json().error).toBe('trade.calculator_invalid');
    expect((await post({ ...calc, exitPrice: 'abc' })).json().error).toBe('trade.calculator_invalid');
    expect((await post({ ...calc, markPrice: '1' })).json().error).toBe('trade.calculator_invalid');
    expect((await post({ ...calc, marginMode: 'cross' })).json().error).toBe('trade.margin_variant_unsupported');
    await app.close();
    const inverse = appWith({ marketBySymbol: async () => ({ ...MARKET, futuresFamily: 'inverse' }) });
    const res = await inverse.inject({ method: 'POST', url: '/api/v1/futures/calculator', headers: headers(), payload: calc });
    expect(res.json().error).toBe('trade.margin_variant_unsupported');
    await inverse.close();
  });

  it('never moves money: neither file reaches a ledger client or a recipe', () => {
    for (const file of ['risk-calculator-rest.ts', 'risk-calculator.ts']) {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      expect(src).not.toMatch(/LedgerClient|ledger-client\/recipes|ledger\.|INSERT|UPDATE /);
    }
  });
});
