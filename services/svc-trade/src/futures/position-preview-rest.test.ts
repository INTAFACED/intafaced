import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { registerPositionPreviewRest } from './position-preview-rest.js';
import type { Market } from '../spot/types.js';
import { UNPUBLISHED_FEE_SCHEDULE } from '../spot/fee-schedule.js';
import { perpetualFeeRates } from './matched-order-plan.js';

const EDGE_SECRET = 'position-preview-edge-secret-long-enough';
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

function appWith(input: {
  mark: string | null;
  cap: string | null;
  liquidation?: string | null;
  takerFeeBps?: ((userId: string) => Promise<number>) | null;
  /** Defaults: a band of 0.05, a slippage cap of 50 bps and a max-order of 1000, so the size and price lines pass. */
  priceBand?: string | null;
  slippageCapBps?: number | null;
  maxOrder?: number | null;
  riskTierFor?: Parameters<typeof registerPositionPreviewRest>[1]['riskTierFor'];
  openInterestFor?: Parameters<typeof registerPositionPreviewRest>[1]['openInterestFor'];
  priceBandInForce?: Parameters<typeof registerPositionPreviewRest>[1]['priceBandInForce'];
}) {
  const app = Fastify();
  const liquidation = input.liquidation;
  registerPositionPreviewRest(app, {
    edgeSecret: EDGE_SECRET,
    serviceName: 'svc-trade',
    marketBySymbol: async (symbol) => (symbol === MARKET.symbol ? MARKET : null),
    markForMarket: async () => (input.mark === null ? null : { price: input.mark, source: 'depth' }),
    leverageCap: input.cap === null ? null : parseAmount(input.cap),
    takerFeeBps: input.takerFeeBps === undefined ? async () => 2 : input.takerFeeBps,
    priceBand: input.priceBand === undefined ? parseAmount('0.05') : input.priceBand === null ? null : parseAmount(input.priceBand),
    slippageCapBps: async () => (input.slippageCapBps === undefined ? 50 : input.slippageCapBps),
    maxOrder: () => (input.maxOrder === undefined ? 1000 : input.maxOrder),
    ...(liquidation === undefined ? {} : { liquidationPriceFor: async () => (liquidation === null ? null : parseAmount(liquidation)) }),
    ...(input.riskTierFor ? { riskTierFor: input.riskTierFor } : {}),
    ...(input.openInterestFor ? { openInterestFor: input.openInterestFor } : {}),
    ...(input.priceBandInForce ? { priceBandInForce: input.priceBandInForce } : {}),
  });
  return app;
}

const payload = { symbol: MARKET.symbol, side: 'long', size: '2', leverage: '4', marginMode: 'isolated' };

describe('POST /api/v1/positions/preview', () => {
  it('returns server-authored decimal strings without moving value', async () => {
    const app = appWith({ mark: '100', cap: '5', liquidation: '80' });
    const response = await app.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      markPrice: '100',
      markSource: 'depth',
      leverageCap: '5',
      orderValue: '200',
      initialMargin: '50',
      estimatedFee: '0.04',
      liquidationPrice: '80',
      orderable: true,
      refusals: [],
    });
    await app.close();
  });

  it('null mark, cap, and policy stay null with typed refuses', async () => {
    const app = appWith({ mark: null, cap: null });
    const response = await app.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      markPrice: null,
      markSource: null,
      leverageCap: null,
      orderValue: null,
      initialMargin: null,
      estimatedFee: null,
      liquidationPrice: null,
      orderable: false,
    });
    expect(response.json().refusals.map((row: { code: string }) => row.code)).toEqual([
      'trade.leverage_cap_unset',
      'trade.position_preview_mark_unavailable',
      'trade.position_preview_liquidation_unavailable',
    ]);
    expect(response.body).not.toContain('"0"');
    await app.close();
  });

  it('the fee is the account’s perpetual taker rate, never the listing row’s; unset or unpublished refuses the fee line', async () => {
    // The listing row says 2 bps; the schedule gives this account 5.
    const app = appWith({ mark: '100', cap: '5', liquidation: '80', takerFeeBps: async () => 5 });
    const priced = await app.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(priced.json()).toMatchObject({ estimatedFee: '0.1', orderable: true });
    await app.close();

    for (const takerFeeBps of [null, async () => perpetualFeeRates(UNPUBLISHED_FEE_SCHEDULE, 0).takerBps]) {
      const blank = appWith({ mark: '100', cap: '5', liquidation: '80', takerFeeBps });
      const response = await blank.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ estimatedFee: null, orderable: false });
      expect(response.json().refusals.map((row: { code: string }) => row.code)).toEqual(['trade.position_preview_fee_unavailable']);
      await blank.close();
    }
  });

  it('a non-cash collateral class is named on the collateral line, and the preview is not orderable', async () => {
    const app = appWith({ mark: '100', cap: '5', liquidation: '80' });
    for (const collateralClass of ['yield_bearing', 'staked', 'lending_idle']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/positions/preview',
        headers: headers(),
        payload: { ...payload, collateralClass },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ orderable: false, initialMargin: '50' });
      expect(response.json().refusals).toEqual([
        expect.objectContaining({ code: 'trade.unsupported_collateral_class', field: 'collateral' }),
      ]);
    }
    const cash = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/preview',
      headers: headers(),
      payload: { ...payload, collateralClass: 'cash' },
    });
    expect(cash.json()).toMatchObject({ orderable: true, refusals: [] });
    await app.close();
  });

  it('a market open shows the band, the slippage cap and the price it would be held at', async () => {
    const app = appWith({ mark: '100', cap: '5', liquidation: '80' });
    const response = await app.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(response.json()).toMatchObject({
      type: 'market',
      band: { fraction: '0.05', low: '95', high: '105' },
      slippageCapBps: 50,
      orderPrice: '100.5',
      priceCorrection: null,
      maxOrderNotional: '1000',
      split: null,
      orderable: true,
    });
    await app.close();
  });

  it('a blank slippage cap refuses a market open on the slippage line; a limit is not asked for one', async () => {
    const app = appWith({ mark: '100', cap: '5', liquidation: '80', slippageCapBps: null });
    const market = await app.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(market.json()).toMatchObject({ slippageCapBps: null, orderPrice: null, orderable: false });
    expect(market.json().refusals).toEqual([expect.objectContaining({ code: 'trade.slippage_cap_unset', field: 'slippage' })]);
    const limit = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/preview',
      headers: headers(),
      payload: { ...payload, type: 'limit', limitPrice: '99' },
    });
    expect(limit.json()).toMatchObject({ type: 'limit', orderPrice: '99', orderable: true, refusals: [] });
    await app.close();
  });

  it('a limit outside the band refuses with its edges, or shows the correction under adjust', async () => {
    const app = appWith({ mark: '100', cap: '5', liquidation: '80' });
    const asked = { ...payload, type: 'limit', limitPrice: '120' };
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload: asked });
    expect(rejected.json()).toMatchObject({ orderPrice: null, priceCorrection: null, orderable: false });
    expect(rejected.json().refusals).toEqual([
      expect.objectContaining({ code: 'trade.futures_price_outside_band', field: 'price', message: expect.stringContaining('95 to 105') }),
    ]);
    const adjusted = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/preview',
      headers: headers(),
      payload: { ...asked, priceCorrection: 'adjust' },
    });
    expect(adjusted.json()).toMatchObject({ orderPrice: '105', priceCorrection: { asked: '120', applied: '105' }, orderable: true });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/preview',
      headers: headers(),
      payload: { ...asked, priceCorrection: 'nudge' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('trade.price_correction_invalid');
    await app.close();
  });

  it('shows the band in force with its width and why: wider while the dynamic range has widened it (D-instruments-08)', async () => {
    const widened = appWith({
      mark: '100',
      cap: '5',
      liquidation: '80',
      priceBandInForce: async () => ({
        fraction: parseAmount('0.08'),
        staticFraction: parseAmount('0.05'),
        source: 'dynamic',
        reason: 'widened',
        max: parseAmount('0.2'),
        premium: parseAmount('0.03'),
        checkedAt: new Date('2026-10-23T12:00:30.000Z'),
        changedAt: new Date('2026-10-23T12:00:00.000Z'),
      }),
    });
    const inside = await widened.inject({
      method: 'POST',
      url: '/api/v1/positions/preview',
      headers: headers(),
      payload: { ...payload, type: 'limit', limitPrice: '107' },
    });
    expect(inside.json()).toMatchObject({
      band: {
        fraction: '0.08',
        low: '92',
        high: '108',
        staticFraction: '0.05',
        source: 'dynamic',
        reason: 'widened',
        max: '0.2',
        premium: '0.03',
        changedAt: '2026-10-23T12:00:00.000Z',
      },
      orderPrice: '107',
      orderable: true,
    });
    const outside = await widened.inject({
      method: 'POST',
      url: '/api/v1/positions/preview',
      headers: headers(),
      payload: { ...payload, type: 'limit', limitPrice: '109' },
    });
    expect(outside.json().refusals).toEqual([
      expect.objectContaining({ code: 'trade.futures_price_outside_band', message: expect.stringContaining('92 to 108') }),
    ]);
    await widened.close();
    // Unwired, the static band with its reason.
    const plain = appWith({ mark: '100', cap: '5', liquidation: '80' });
    const res = await plain.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(res.json().band).toEqual({
      fraction: '0.05',
      low: '95',
      high: '105',
      staticFraction: '0.05',
      source: 'static',
      reason: 'price_range_unset',
      max: null,
      premium: null,
      changedAt: null,
    });
    await plain.close();
  });

  it('above the max-order the size line refuses and names the split; blank band and max-order refuse their own lines', async () => {
    const app = appWith({ mark: '100', cap: '5', liquidation: '80', maxOrder: 150 });
    const response = await app.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    // 2 at 100 is 200 against 150: children sized at the band's high edge (105), 1.42 in lots of 0.01, and the rest.
    expect(response.json()).toMatchObject({ maxOrderNotional: '150', split: { parts: 2, sizes: ['1.42', '0.58'] }, orderable: false });
    expect(response.json().refusals).toEqual([
      expect.objectContaining({ code: 'trade.limit_max_order', field: 'size', message: expect.stringContaining('2 orders') }),
    ]);
    await app.close();
    const blank = appWith({ mark: '100', cap: '5', liquidation: '80', maxOrder: null, priceBand: null });
    const unset = await blank.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(unset.json()).toMatchObject({ band: null, maxOrderNotional: null, split: null, orderable: false });
    expect(unset.json().refusals.map((row: { code: string }) => row.code)).toEqual([
      'trade.futures_price_band_unset',
      'trade.max_order_unset',
    ]);
    await blank.close();
  });

  it('names the margin tier the order carries the side into, and whether the order must confirm it', async () => {
    const asked: unknown[] = [];
    const app = appWith({
      mark: '100',
      cap: '5',
      liquidation: '80',
      riskTierFor: async (input) => {
        asked.push({ userId: input.userId, market: input.market.id, side: input.side, size: input.size, mark: input.markPrice });
        return {
          currentTier: 1,
          projectedTier: 2,
          maintenanceBps: 100,
          notional: parseAmount('200'),
          confirmRequired: true,
          tiers: 4,
          depthNotional: parseAmount('1000'),
        };
      },
    });
    const response = await app.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(response.json()).toMatchObject({
      riskTier: { current: 1, projected: 2, maintenanceBps: 100, maintenanceRate: '0.01', notional: '200', confirmRequired: true },
      // Asking for a confirm is not a refusal: the order goes through once the trader names the tier.
      orderable: true,
      refusals: [],
    });
    expect(asked).toEqual([{ userId: USER, market: MARKET.id, side: 'long', size: parseAmount('2'), mark: parseAmount('100') }]);
    await app.close();
  });

  it('an unreadable tier is named on the tier line; without a mark nothing is rated', async () => {
    const { FuturesError } = await import('./position-service.js');
    const unread = appWith({
      mark: '100',
      cap: '5',
      liquidation: '80',
      riskTierFor: async () => {
        throw new FuturesError('depth unreadable', 'trade.depth_unknown', 503);
      },
    });
    const response = await unread.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(response.json()).toMatchObject({
      riskTier: null,
      orderable: false,
      refusals: [{ code: 'trade.depth_unknown', field: 'tier', message: 'depth unreadable' }],
    });
    let called = false;
    const markless = appWith({
      mark: null,
      cap: '5',
      riskTierFor: async () => {
        called = true;
        throw new Error('not reached');
      },
    });
    const none = await markless.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(none.json().riskTier).toBeNull();
    expect(called).toBe(false);
    // Any other failure is named on the tier line too; the rest of the preview still answers.
    const broken = appWith({
      mark: '100',
      cap: '5',
      liquidation: '80',
      riskTierFor: async () => {
        throw new Error('connection reset');
      },
    });
    const named = await broken.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(named.statusCode).toBe(200);
    expect(named.json()).toMatchObject({
      initialMargin: '50',
      riskTier: null,
      refusals: [{ code: 'trade.risk_tier_unavailable', field: 'tier' }],
    });
    await broken.close();
    await unread.close();
    await markless.close();
  });

  it('shows the open-interest room before Confirm, and an order past it is refused on the open-interest line', async () => {
    const asked: unknown[] = [];
    const room = (accountCommitted: string) => ({
      limit: parseAmount('1000'),
      shareBps: 1000,
      accountCap: parseAmount('100'),
      marketCommitted: parseAmount('300'),
      accountCommitted: parseAmount(accountCommitted),
      room: parseAmount('100') - parseAmount(accountCommitted),
      binding: 'account' as const,
    });
    const fits = appWith({
      mark: '100',
      cap: '5',
      liquidation: '80',
      openInterestFor: async (input) => {
        asked.push({ userId: input.userId, market: input.market.id });
        return room('97');
      },
    });
    const ok = await fits.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(ok.json()).toMatchObject({
      openInterest: {
        limit: '1000',
        shareBps: 1000,
        accountCap: '100',
        accountCommitted: '97',
        marketCommitted: '300',
        room: '3',
        binding: 'account',
      },
      orderable: true,
      refusals: [],
    });
    expect(asked).toEqual([{ userId: USER, market: MARKET.id }]);
    const over = appWith({ mark: '100', cap: '5', liquidation: '80', openInterestFor: async () => room('99') });
    const refused = await over.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(refused.json()).toMatchObject({
      openInterest: { room: '1' },
      orderable: false,
      refusals: [{ code: 'trade.oi_share_limit', field: 'openInterest' }],
    });
    expect(refused.json().refusals[0].message).toContain(`room left 1 ${MARKET.baseAsset}`);
    await fits.close();
    await over.close();
  });

  it('a blank open-interest limit, or a room that cannot be read, is named on its line', async () => {
    const { FuturesError } = await import('./position-service.js');
    const blank = appWith({
      mark: '100',
      cap: '5',
      liquidation: '80',
      openInterestFor: async () => {
        throw new FuturesError('no open-interest limit is published', 'trade.oi_limit_unset', 503);
      },
    });
    const unset = await blank.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(unset.json()).toMatchObject({
      openInterest: null,
      orderable: false,
      refusals: [{ code: 'trade.oi_limit_unset', field: 'openInterest', message: 'no open-interest limit is published' }],
    });
    const broken = appWith({
      mark: '100',
      cap: '5',
      liquidation: '80',
      openInterestFor: async () => {
        throw new Error('connection reset');
      },
    });
    const named = await broken.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect(named.statusCode).toBe(200);
    expect(named.json()).toMatchObject({ openInterest: null, refusals: [{ code: 'trade.oi_room_unavailable', field: 'openInterest' }] });
    // Unwired, the field is absent rather than a pretend null.
    const unwired = appWith({ mark: '100', cap: '5', liquidation: '80' });
    const absent = await unwired.inject({ method: 'POST', url: '/api/v1/positions/preview', headers: headers(), payload });
    expect('openInterest' in absent.json()).toBe(false);
    await blank.close();
    await broken.close();
    await unwired.close();
  });

  it('refuses JSON-number money inputs', async () => {
    const app = appWith({ mark: '100', cap: '5' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/preview',
      headers: headers(),
      payload: { ...payload, size: 2 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('trade.position_preview_invalid');
    await app.close();
  });

  it('refuses client-authored mark and liquidation fields', async () => {
    const app = appWith({ mark: '100', cap: '5' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/preview',
      headers: headers(),
      payload: { ...payload, markPrice: '100', liquidationPrice: '80' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('trade.position_preview_server_values_only');
    expect(response.body).toContain('liquidationPrice, markPrice');
    await app.close();
  });
});
