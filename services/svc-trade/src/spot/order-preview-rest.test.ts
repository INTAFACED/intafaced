import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import {
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_REFUSE_FIXTURE,
  SCREENING_REFUSE_UNCONFIGURED,
  SCREENING_FAIL_CLOSED_ENV,
  SCREENING_REVIEWED_EMPTY,
} from '@intafaced/config';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { decideMarketAction, type MarketLifecyclePort } from '../market-lifecycle.js';
import { READY_MARKET_LIFECYCLE, READY_MARKET_NOW, readyMarket } from './testing.js';
import { parseFeeScheduleJson, UNPUBLISHED_FEE_SCHEDULE, type OwnerFeeSchedule } from './fee-schedule.js';
import { registerSpotOrderPreviewRest, SPOT_ORDER_PREVIEW_PATH, type SpotOrderPreviewRestDeps } from './order-preview-rest.js';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TradeError, type Market } from './types.js';

const EDGE_SECRET = 'spot-order-preview-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const MARKET = readyMarket('fixture-spot', {
  symbol: 'FIX/QUOTE',
  baseAsset: 'fixture-base',
  quoteAsset: 'fixture-quote',
  tickSize: parseAmount('0.01'),
  lotSize: parseAmount('0.01'),
  minQty: parseAmount('0.01'),
  maxQty: parseAmount('1000'),
  minNotional: parseAmount('1'),
  makerBps: 1,
  takerBps: 2,
});

const here = dirname(fileURLToPath(import.meta.url));
const previewSource = readFileSync(join(here, 'order-preview-rest.ts'), 'utf8');

function headers(scopes: string[] = ['trade:read'], region = 'DE'): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, region),
    'x-intafaced-region': region,
  };
}

/** Install a process screening list for one request, then put the previous answer back. */
async function withScreeningList(regions: string | undefined, source: string | undefined, run: () => Promise<void>): Promise<void> {
  const previousRegions = process.env[SANCTIONS_REGIONS_ENV];
  const previousSource = process.env[SANCTIONS_SOURCE_ENV];
  if (regions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
  else process.env[SANCTIONS_REGIONS_ENV] = regions;
  if (source === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
  else process.env[SANCTIONS_SOURCE_ENV] = source;
  try {
    await run();
  } finally {
    if (previousRegions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
    else process.env[SANCTIONS_REGIONS_ENV] = previousRegions;
    if (previousSource === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
    else process.env[SANCTIONS_SOURCE_ENV] = previousSource;
  }
}

const savedRegions = process.env[SANCTIONS_REGIONS_ENV];
const savedSource = process.env[SANCTIONS_SOURCE_ENV];
const savedSwitch = process.env[SCREENING_FAIL_CLOSED_ENV];

beforeEach(() => {
  // vitest.config.ts turns the shared fail-closed switch off for business fixtures. Preview reads that
  // switch (it no longer hard-codes strict), so these screening cases run strict like production.
  process.env[SCREENING_FAIL_CLOSED_ENV] = 'on';
  process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
  process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-ref';
});

afterEach(() => {
  if (savedSwitch === undefined) delete process.env[SCREENING_FAIL_CLOSED_ENV];
  else process.env[SCREENING_FAIL_CLOSED_ENV] = savedSwitch;
  if (savedRegions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
  else process.env[SANCTIONS_REGIONS_ENV] = savedRegions;
  if (savedSource === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
  else process.env[SANCTIONS_SOURCE_ENV] = savedSource;
});

const HALTED_LIFECYCLE: MarketLifecyclePort = {
  snapshot(market) {
    const ready = READY_MARKET_LIFECYCLE.snapshot(market);
    return {
      ...ready,
      state: 'HALTED',
      reasonCategory: 'OPERATOR',
      reasonCode: 'trade.market_halted',
      allowedActions: ['CANCEL', 'REDUCE', 'CLOSE'],
    };
  },
  admit(snapshot, action) {
    return decideMarketAction(snapshot, action);
  },
};

const PUBLISHED_FEE_SCHEDULE = parseFeeScheduleJson(
  JSON.stringify({ published: true, version: 'preview-test', makerBps: '1', takerBps: '2' }),
);

function appWith(input: {
  market?: Market | null;
  lifecycle?: MarketLifecyclePort | null;
  bestAsk?: AmountOrNull | (() => Promise<AmountOrNull>);
  bestBid?: AmountOrNull | (() => Promise<AmountOrNull>);
  submit?: () => Promise<never>;
  ledgerPost?: () => Promise<never>;
  spotEnabled?: boolean;
  feeSchedule?: OwnerFeeSchedule;
  slippageCapBps?: number | null;
  feeDiscountBps?: (userId: string) => Promise<number>;
  stopLimitEnabled?: boolean;
  matchingHalt?: (marketId: string) => Promise<{ market: boolean; venue: boolean }>;
  operatorRisk?: SpotOrderPreviewRestDeps['operatorRisk'];
}) {
  const app = Fastify();
  const bestAsk = input.bestAsk;
  const bestBid = input.bestBid;
  const submit =
    input.submit ??
    vi.fn(async () => {
      throw new Error('matching.submit must not run on preview');
    });
  const ledgerPost =
    input.ledgerPost ??
    vi.fn(async () => {
      throw new Error('ledger.post must not run on preview');
    });
  registerSpotOrderPreviewRest(app, {
    edgeSecret: EDGE_SECRET,
    serviceName: 'svc-trade',
    now: READY_MARKET_NOW,
    marketBySymbol: async (symbol) => {
      if (input.market === null) return null;
      const market = input.market ?? MARKET;
      return symbol === market.symbol ? market : null;
    },
    marketLifecycle: input.lifecycle === undefined ? READY_MARKET_LIFECYCLE : input.lifecycle,
    stopLimitEnabled: input.stopLimitEnabled,
    bestAsk: async () => {
      if (typeof bestAsk === 'function') return bestAsk();
      return bestAsk === undefined ? parseAmount('100') : bestAsk;
    },
    bestBid: async () => {
      if (typeof bestBid === 'function') return bestBid();
      return bestBid === undefined ? parseAmount('100') : bestBid;
    },
    spotEnabled: input.spotEnabled ?? true,
    futuresEnabled: false,
    optionsSettlementLawStamped: false,
    slippageCapBps: input.slippageCapBps === undefined ? 200 : input.slippageCapBps,
    feeSchedule: input.feeSchedule ?? PUBLISHED_FEE_SCHEDULE,
    ...(input.feeDiscountBps ? { feeDiscountBps: input.feeDiscountBps } : {}),
    ...(input.matchingHalt ? { matchingHalt: input.matchingHalt } : {}),
    ...(input.operatorRisk ? { operatorRisk: input.operatorRisk } : {}),
  });
  return { app, submit, ledgerPost };
}

type AmountOrNull = ReturnType<typeof parseAmount> | null;

const limitBuy = { symbol: MARKET.symbol, side: 'buy', type: 'limit', amount: '2', price: '100' };

describe('POST /api/v1/orders/preview', () => {
  it('returns server-authored decimal strings without moving value', async () => {
    const { app, submit, ledgerPost } = appWith({});
    const response = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: limitBuy });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      symbol: MARKET.symbol,
      side: 'buy',
      type: 'limit',
      amount: '2',
      price: '100',
      timeInForce: 'GTC',
      holdAsset: 'fixture-quote',
      holdAmount: '200',
      protectionPrice: null,
      estimatedFee: '0.0004',
      feeAsset: 'fixture-base',
      feeBps: 2,
      feeRole: 'taker',
      feeScheduleVersion: 'preview-test',
      makerFeeBps: 1,
      takerFeeBps: 2,
      orderable: true,
      refusals: [],
    });
    expect(submit).not.toHaveBeenCalled();
    expect(ledgerPost).not.toHaveBeenCalled();
    await app.close();
  });

  it('quotes maker when a GTC limit buy is strictly below a known best ask', async () => {
    const { app } = appWith({});
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, price: '99' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ feeRole: 'maker', feeBps: 1, orderable: true });
    await app.close();
  });

  it('quotes taker for a limit sell', async () => {
    const { app } = appWith({});
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, side: 'sell' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ feeRole: 'taker', side: 'sell' });
    await app.close();
  });

  it('refuses maker-or-cancel and does not call the ledger', async () => {
    const { app, ledgerPost } = appWith({});
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, price: '99', timeInForce: 'MOC' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().orderable).toBe(false);
    expect(response.json().refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'trade.invalid_tif', field: 'timeInForce' })]),
    );
    expect(ledgerPost).not.toHaveBeenCalled();
    await app.close();
  });

  describe('good-till-date', () => {
    const FUTURE = '2026-08-25T16:00:00.000Z'; // the clock reads 2026-08-24T16:00Z
    const post = async (payload: Record<string, unknown>) => {
      const { app, ledgerPost } = appWith({});
      const response = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload });
      await app.close();
      return { response, ledgerPost };
    };
    const refusalsOf = (r: { json: () => { refusals: Array<{ code: string; field: string }> } }) => r.json().refusals;

    it('previews a limit buy good till a future date, held like a resting order', async () => {
      const gtc = await post({ ...limitBuy, timeInForce: 'GTC' });
      const { response, ledgerPost } = await post({ ...limitBuy, timeInForce: 'GTD', expireAt: FUTURE });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ timeInForce: 'GTD', orderable: true, refusals: [] });
      expect(response.json().holdAmount).toBe(gtc.response.json().holdAmount);
      expect(ledgerPost).not.toHaveBeenCalled();
    });

    it('refuses a good-till-date order with no expiry, naming the field', async () => {
      const { response } = await post({ ...limitBuy, timeInForce: 'GTD' });
      expect(response.json().orderable).toBe(false);
      expect(refusalsOf(response)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'trade.missing_expire_at', field: 'expireAt' })]),
      );
    });

    it.each([
      ['an expiry in the past', '2026-08-24T15:59:59.000Z', 'trade.invalid_expiry'],
      ['an expiry equal to now', '2026-08-24T16:00:00.000Z', 'trade.invalid_expiry'],
      ['an expiry that is not a date', 'tomorrow', 'trade.invalid_tif'],
    ])('refuses %s', async (_name, expireAt, code) => {
      const { response } = await post({ ...limitBuy, timeInForce: 'GTD', expireAt });
      expect(response.json().orderable).toBe(false);
      expect(refusalsOf(response)).toEqual(expect.arrayContaining([expect.objectContaining({ code, field: 'expireAt' })]));
    });

    it('refuses an expiry on an order that is not good till date, rather than ignoring it', async () => {
      const { response } = await post({ ...limitBuy, timeInForce: 'GTC', expireAt: FUTURE });
      expect(response.json().orderable).toBe(false);
      expect(refusalsOf(response)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'trade.invalid_tif', field: 'expireAt' })]),
      );
    });

    it('refuses post-only with good-till-date outright, as the place door does', async () => {
      const { response } = await post({ ...limitBuy, timeInForce: 'GTD', expireAt: FUTURE, postOnly: true });
      expect(response.statusCode, response.body).toBe(400);
      const bare = await post({ ...limitBuy, timeInForce: 'GTD', postOnly: true });
      expect(bare.response.statusCode, bare.response.body).toBe(400);
    });

    it('refuses good-till-date on a market order, which has no price to rest at', async () => {
      const { response } = await post({
        symbol: MARKET.symbol,
        side: 'buy',
        type: 'market',
        amount: '2',
        timeInForce: 'GTD',
        expireAt: FUTURE,
      });
      expect(response.json().orderable).toBe(false);
      expect(refusalsOf(response)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'trade.invalid_tif', field: 'timeInForce' })]),
      );
    });
  });

  it('given a taker fee of 100 bps and a rank discount of 5000, a limit buy preview fee bps is 50', async () => {
    const schedule = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'rank-50', makerBps: '100', takerBps: '100' }));
    const { app, ledgerPost } = appWith({ feeSchedule: schedule, feeDiscountBps: async () => 5000 });
    const response = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: limitBuy });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      feeBps: 50,
      makerFeeBps: 50,
      takerFeeBps: 50,
      feeScheduleVersion: 'rank-50',
      orderable: true,
    });
    expect(ledgerPost).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses halt/lifecycle without inventing a hold that place would not take', async () => {
    const haltedListing = readyMarket(MARKET.id, { ...MARKET, status: 'halted' });
    const listing = appWith({ market: haltedListing });
    const listingRes = await listing.app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: limitBuy,
    });
    expect(listingRes.statusCode, listingRes.body).toBe(200);
    expect(listingRes.json().orderable).toBe(false);
    expect(listingRes.json().refusals.map((row: { code: string }) => row.code)).toContain('trade.market_not_tradable');

    const lifecycle = appWith({ lifecycle: HALTED_LIFECYCLE });
    const lifecycleRes = await lifecycle.app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: limitBuy,
    });
    expect(lifecycleRes.statusCode, lifecycleRes.body).toBe(200);
    expect(lifecycleRes.json().orderable).toBe(false);
    expect(lifecycleRes.json().refusals.map((row: { code: string }) => row.code)).toContain('trade.market_halted');
    expect(lifecycleRes.json().holdAmount).toBe('200');
    await listing.app.close();
    await lifecycle.app.close();
  });

  it('limit-only: a market order previews as refused with trade.mode_limit_only, a limit order does not', async () => {
    const LIMIT_ONLY_LIFECYCLE: MarketLifecyclePort = {
      snapshot: (market, options) => ({ ...READY_MARKET_LIFECYCLE.snapshot(market, options), state: 'LIMIT_ONLY' }) as never,
      admit: (snapshot, action) => decideMarketAction(snapshot, action),
    };
    const { app } = appWith({ lifecycle: LIMIT_ONLY_LIFECYCLE });
    const market = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, type: 'market', price: undefined },
    });
    expect(market.json().refusals.map((row: { code: string }) => row.code)).toContain('trade.mode_limit_only');
    const limit = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: limitBuy });
    expect(limit.json().refusals.map((row: { code: string }) => row.code)).not.toContain('trade.mode_limit_only');
    await app.close();
  });

  it('refuses unauthenticated callers', async () => {
    const { app } = appWith({});
    const response = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, payload: limitBuy });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('trade.unauthenticated');
    await app.close();
  });

  it('shows SOCKET §13 stop-family refusal and does not invent a stop hold', async () => {
    const { app } = appWith({});
    for (const payload of [
      { symbol: MARKET.symbol, side: 'buy', type: 'stop', amount: '2', stopPrice: '90' },
      { symbol: MARKET.symbol, side: 'buy', type: 'stop_limit', amount: '2', price: '100', stopPrice: '90' },
      { symbol: MARKET.symbol, side: 'sell', type: 'take_profit', amount: '2', stopPrice: '110' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: SPOT_ORDER_PREVIEW_PATH,
        headers: headers(),
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        holdAsset: null,
        holdAmount: null,
        estimatedFee: null,
        orderable: false,
      });
      expect(response.json().refusals.map((row: { code: string }) => row.code)).toContain('trade.order_type_unsupported');
    }
    await app.close();
  });

  it('previews a stop-market as the stop-limit it is placed as: limit at the protection price, hold sized to it', async () => {
    const { app } = appWith({ stopLimitEnabled: true, slippageCapBps: 50 });
    const stop = { symbol: MARKET.symbol, side: 'buy', type: 'stop', amount: '2', stopPrice: '100' };
    const ok = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: stop });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ stopPrice: '100', price: '100.5', holdAsset: 'fixture-quote', holdAmount: '201', orderable: true });
    const sell = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: { ...stop, side: 'sell' } });
    expect(sell.json()).toMatchObject({ price: '99.5', holdAsset: 'fixture-base', holdAmount: '2', orderable: true });
    for (const [bad, code] of [
      [{ ...stop, price: '101' }, 'trade.invalid_price'],
      [{ ...stop, timeInForce: 'IOC' }, 'trade.invalid_tif'],
      [{ ...stop, stopPrice: undefined }, 'trade.stop_trigger_invalid'],
    ] as const) {
      const refused = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: bad });
      expect(refused.json().orderable, refused.body).toBe(false);
      expect(refused.json().refusals.map((row: { code: string }) => row.code)).toContain(code);
    }
    await app.close();
    const blank = appWith({ stopLimitEnabled: true, slippageCapBps: null }).app;
    const unset = await blank.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: stop });
    expect(unset.json().refusals.map((row: { code: string }) => row.code)).toContain('trade.protection_unset');
    await blank.close();
  });

  it('previews a stop-limit when the trigger store is wired: hold sized to the limit price, trigger echoed', async () => {
    const { app } = appWith({ stopLimitEnabled: true });
    const stopLimit = { symbol: MARKET.symbol, side: 'sell', type: 'stop_limit', amount: '2', price: '95', stopPrice: '96' };
    const ok = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: stopLimit });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      type: 'stop_limit',
      price: '95',
      stopPrice: '96',
      holdAsset: 'fixture-base',
      holdAmount: '2',
      orderable: true,
      feeRole: 'taker',
    });
    const buy = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...stopLimit, side: 'buy', price: '105', stopPrice: '104' },
    });
    expect(buy.json()).toMatchObject({ holdAsset: 'fixture-quote', holdAmount: '210', orderable: true });
    for (const bad of [
      { ...stopLimit, stopPrice: undefined },
      { ...stopLimit, stopPrice: '96.005' },
      { ...stopLimit, stopPrice: '0' },
      { ...stopLimit, price: undefined },
    ]) {
      const refused = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: bad });
      expect(refused.statusCode, refused.body).toBe(200);
      expect(refused.json().orderable).toBe(false);
    }
    const stray = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { symbol: MARKET.symbol, side: 'buy', type: 'limit', amount: '2', price: '100', stopPrice: '90' },
    });
    expect(stray.json().orderable).toBe(false);
    expect(stray.json().refusals.map((row: { code: string }) => row.code)).toContain('trade.stop_trigger_invalid');
    await app.close();
  });

  it('404s unknown markets', async () => {
    const { app } = appWith({});
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, symbol: 'NO/SUCH' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('trade.market_not_found');
    await app.close();
  });

  it('refuses JSON-number money inputs', async () => {
    const { app } = appWith({});
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, amount: 2 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('trade.order_preview_invalid');
    await app.close();
  });

  it('refuses client-authored hold and fee fields', async () => {
    const { app } = appWith({});
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, holdAmount: '200', estimatedFee: '0.01' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('trade.order_preview_server_values_only');
    expect(response.body).toContain('estimatedFee, holdAmount');
    await app.close();
  });

  it('leaves fee blank when published bps are not a schedule', async () => {
    const { app } = appWith({
      market: readyMarket(MARKET.id, { ...MARKET, takerBps: Number.NaN, makerBps: Number.NaN }),
      feeSchedule: UNPUBLISHED_FEE_SCHEDULE,
    });
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: limitBuy,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      estimatedFee: null,
      feeBps: null,
      feeAsset: null,
      orderable: false,
    });
    expect(response.json().refusals.map((row: { code: string }) => row.code)).toContain('trade.order_preview_fee_unavailable');
    await app.close();
  });

  it('refuses fee preview when owner schedule is blank — never invents listing bps', async () => {
    const listed = readyMarket(MARKET.id, { ...MARKET, makerBps: 10, takerBps: 20 });
    const { app } = appWith({ market: listed, feeSchedule: UNPUBLISHED_FEE_SCHEDULE });
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: limitBuy,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      estimatedFee: null,
      feeBps: null,
      feeAsset: null,
      orderable: false,
    });
    expect(response.json().refusals.map((row: { code: string }) => row.code)).toContain('trade.order_preview_fee_unavailable');
    expect(response.body).not.toMatch(/"feeBps":\s*(10|20)/);
    await app.close();
  });

  it('never imports a ledger port or matching submit', () => {
    expect(previewSource).not.toMatch(/LedgerClient|orderHold|recipes/);
    expect(previewSource).not.toMatch(/matching\.submit|\.submit\(/);
    expect(previewSource).toContain('never receives a ledger port');
  });

  it('refuses preview when the sanctions list is unset and posts no hold', async () => {
    await withScreeningList(undefined, undefined, async () => {
      const { app, submit, ledgerPost } = appWith({});
      const response = await app.inject({
        method: 'POST',
        url: SPOT_ORDER_PREVIEW_PATH,
        headers: headers(),
        payload: limitBuy,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().orderable).toBe(false);
      expect(response.json().refusals.map((row: { code: string }) => row.code)).toContain(SCREENING_REFUSE_UNCONFIGURED);
      expect(submit).not.toHaveBeenCalled();
      expect(ledgerPost).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it('refuses preview when the sanctions list is blank and posts no hold', async () => {
    await withScreeningList('   ', undefined, async () => {
      const { app, submit, ledgerPost } = appWith({});
      const response = await app.inject({
        method: 'POST',
        url: SPOT_ORDER_PREVIEW_PATH,
        headers: headers(),
        payload: limitBuy,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().orderable).toBe(false);
      expect(response.json().refusals.map((row: { code: string }) => row.code)).toContain(SCREENING_REFUSE_UNCONFIGURED);
      expect(submit).not.toHaveBeenCalled();
      expect(ledgerPost).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it('refuses preview when the region is on the sanctions list and posts no hold', async () => {
    await withScreeningList('AA:programme-ref', 'counsel-memo-ref', async () => {
      const { app, submit, ledgerPost } = appWith({});
      const response = await app.inject({
        method: 'POST',
        url: SPOT_ORDER_PREVIEW_PATH,
        headers: headers(['trade:read'], 'AA'),
        payload: limitBuy,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().orderable).toBe(false);
      expect(response.json().refusals.map((row: { code: string }) => row.code)).toContain('denied.region_blocked');
      expect(submit).not.toHaveBeenCalled();
      expect(ledgerPost).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it('refuses preview when the sanctions list is a fixture and posts no hold', async () => {
    await withScreeningList('AA:placeholder', 'test-fixture-not-a-real-list', async () => {
      const { app, submit, ledgerPost } = appWith({});
      const response = await app.inject({
        method: 'POST',
        url: SPOT_ORDER_PREVIEW_PATH,
        headers: headers(),
        payload: limitBuy,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().orderable).toBe(false);
      expect(response.json().refusals.map((row: { code: string }) => row.code)).toContain(SCREENING_REFUSE_FIXTURE);
      expect(submit).not.toHaveBeenCalled();
      expect(ledgerPost).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it('follows the shared fail-closed switch: a fixture list is orderable only when explicitly off in dev', async () => {
    const savedApp = process.env.APP_ENV;
    const savedSwitch = process.env[SCREENING_FAIL_CLOSED_ENV];
    try {
      await withScreeningList('AA:placeholder', 'test-fixture-not-a-real-list', async () => {
        process.env.APP_ENV = 'dev';
        process.env[SCREENING_FAIL_CLOSED_ENV] = 'off';
        const local = appWith({});
        const open = await local.app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: limitBuy });
        expect(open.statusCode, open.body).toBe(200);
        expect(open.json().orderable).toBe(true);
        expect(open.json().refusals).toEqual([]);
        await local.app.close();

        // Off is ignored outside explicit dev/test: staging and prod stay fail-closed.
        process.env.APP_ENV = 'prod';
        const hosted = appWith({});
        const shut = await hosted.app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: limitBuy });
        expect(shut.json().orderable).toBe(false);
        expect(shut.json().refusals.map((row: { code: string }) => row.code)).toContain(SCREENING_REFUSE_FIXTURE);
        await hosted.app.close();

        // Unset switch stays fail-closed.
        process.env.APP_ENV = 'dev';
        delete process.env[SCREENING_FAIL_CLOSED_ENV];
        const unset = appWith({});
        const refused = await unset.app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: limitBuy });
        expect(refused.json().orderable).toBe(false);
        await unset.app.close();
      });
    } finally {
      if (savedApp === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = savedApp;
      if (savedSwitch === undefined) delete process.env[SCREENING_FAIL_CLOSED_ENV];
      else process.env[SCREENING_FAIL_CLOSED_ENV] = savedSwitch;
    }
  });

  it('stays orderable when shape passes and the sanctions gate allows the region', async () => {
    await withScreeningList('AA:programme-ref', 'counsel-memo-ref', async () => {
      const { app, submit, ledgerPost } = appWith({});
      const response = await app.inject({
        method: 'POST',
        url: SPOT_ORDER_PREVIEW_PATH,
        headers: headers(['trade:read'], 'DE'),
        payload: limitBuy,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().orderable).toBe(true);
      expect(response.json().refusals).toEqual([]);
      expect(submit).not.toHaveBeenCalled();
      expect(ledgerPost).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it('refuses a market sell with trade.protection_unset when the owner floor is unpublished', async () => {
    const { app } = appWith({ slippageCapBps: null, bestBid: parseAmount('100') });
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { symbol: MARKET.symbol, side: 'sell', type: 'market', amount: '2' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.orderable).toBe(false);
    expect(body.protectionPrice).toBeNull();
    expect(body.refusals.map((row: { code: string }) => row.code)).toContain('trade.protection_unset');
    await app.close();
  });

  it('returns the sell floor and estimated fee when the owner cap and a bid exist', async () => {
    const { app } = appWith({ slippageCapBps: 200, bestBid: parseAmount('100') });
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { symbol: MARKET.symbol, side: 'sell', type: 'market', amount: '2' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    // 100 - 200 bps = 98. Fee is taker 2 bps of 98 * 2 = 196.
    expect(body.orderable).toBe(true);
    expect(body.protectionPrice).toBe('98');
    expect(body.estimatedFee).not.toBeNull();
    expect(body.feeBps).toBe(2);
    expect(body.feeRole).toBe('taker');
    expect(body.refusals).toEqual([]);
    await app.close();
  });

  it('preview and GET /account/fees return the same published maker and taker rates', async () => {
    const schedule = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'desk', makerBps: '8', takerBps: '10' }));
    const listed = { ...MARKET, makerBps: 10, takerBps: 20 };
    const { app } = appWith({ market: listed, feeSchedule: schedule });
    registerPrivateRest(app, {
      edgeSecret: EDGE_SECRET,
      serviceName: 'svc-trade',
      markets: async () => [listed],
      feeSchedule: schedule,
    } as unknown as PrivateRestDeps);
    const maker = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { symbol: listed.symbol, side: 'buy', type: 'limit', amount: '1', price: '100', timeInForce: 'PO' },
    });
    const taker = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { symbol: listed.symbol, side: 'buy', type: 'limit', amount: '1', price: '100' },
    });
    const fees = await app.inject({ method: 'GET', url: '/api/v1/account/fees', headers: headers() });
    expect(maker.statusCode, maker.body).toBe(200);
    expect(taker.statusCode, taker.body).toBe(200);
    expect(fees.statusCode, fees.body).toBe(200);
    expect(maker.json().feeBps).toBe(8);
    expect(taker.json().feeBps).toBe(10);
    const row = fees.json()[listed.symbol];
    expect(row.makerBps).toBe(8);
    expect(row.takerBps).toBe(10);
    expect(row.maker).toBe('0.0008');
    expect(row.taker).toBe('0.001');
    expect(row.version).toBe('desk');
    await app.close();
  });
});

describe('POST /api/v1/orders/preview: exit-leg fees', () => {
  const ocoSell = { symbol: MARKET.symbol, side: 'sell', type: 'limit', amount: '2', price: '110' };

  it('figures the fee of each linked leg: take-profit as maker, stop-loss as taker, in the leg side asset', async () => {
    const { app } = appWith({
      feeSchedule: parseFeeScheduleJson(JSON.stringify({ published: true, version: 'v', makerBps: '10', takerBps: '20' })),
    });
    const response = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...ocoSell, exit: { kind: 'oco', takeProfit: '110', stopLoss: '90' } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().exitFees).toEqual({
      side: 'sell',
      takeProfit: { price: '110', feeRole: 'maker', feeBps: 10, estimatedFee: '0.22', feeAsset: 'fixture-quote' },
      stopLoss: { price: '90', feeRole: 'taker', feeBps: 20, estimatedFee: '0.36', feeAsset: 'fixture-quote' },
    });
  });

  it('a bracket entry on the buy side previews its exit as a sell, and a buy OCO pays its leg fees in base', async () => {
    const { app } = appWith({
      feeSchedule: parseFeeScheduleJson(JSON.stringify({ published: true, version: 'v', makerBps: '10', takerBps: '20' })),
    });
    const bracket = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, exit: { kind: 'bracket_exit', takeProfit: '110', stopLoss: '90' } },
    });
    expect(bracket.json().exitFees.side).toBe('sell');
    const buyOco = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...limitBuy, price: '91', exit: { kind: 'oco', takeProfit: '80', stopLoss: '90', stopLossLimit: '91' } },
    });
    expect(buyOco.json().exitFees).toEqual({
      side: 'buy',
      takeProfit: { price: '80', feeRole: 'maker', feeBps: 10, estimatedFee: '0.002', feeAsset: 'fixture-base' },
      stopLoss: { price: '91', feeRole: 'taker', feeBps: 20, estimatedFee: '0.004', feeAsset: 'fixture-base' },
    });
  });

  it('refuses a malformed exit and an unpublished schedule instead of inventing a fee, and omits exitFees without exit', async () => {
    const { app } = appWith({});
    const bad = await app.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...ocoSell, exit: { kind: 'oco', takeProfit: 110, stopLoss: '90' } },
    });
    expect(bad.json().orderable).toBe(false);
    expect(bad.json().exitFees).toBeNull();
    expect(bad.json().refusals).toContainEqual(expect.objectContaining({ field: 'exit' }));
    const { app: unpublished } = appWith({ feeSchedule: UNPUBLISHED_FEE_SCHEDULE });
    const blank = await unpublished.inject({
      method: 'POST',
      url: SPOT_ORDER_PREVIEW_PATH,
      headers: headers(),
      payload: { ...ocoSell, exit: { kind: 'oco', takeProfit: '110', stopLoss: '90' } },
    });
    expect(blank.json().exitFees).toBeNull();
    expect(blank.json().orderable).toBe(false);
    const plain = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: limitBuy });
    expect(plain.json().exitFees).toBeNull();
  });
});

describe('POST /api/v1/orders/preview: per-order slippage tolerance', () => {
  const preview = async (payload: Record<string, unknown>, over: Parameters<typeof appWith>[0] = {}) => {
    const { app } = appWith({ slippageCapBps: 200, bestAsk: parseAmount('100'), bestBid: parseAmount('100'), ...over });
    const response = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload });
    await app.close();
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const buy = { symbol: MARKET.symbol, side: 'buy', type: 'market', amount: '2' };
  const sell = { symbol: MARKET.symbol, side: 'sell', type: 'market', amount: '2' };

  it('a market buy with a tighter tolerance previews the tighter protection price and a hold sized to it', async () => {
    const wide = await preview(buy);
    const tight = await preview({ ...buy, maxSlippageBps: 50 });
    // 100 + 200 bps = 102; 100 + 50 bps = 100.5. The hold is the protection price times the quantity.
    expect(wide.protectionPrice).toBe('102');
    expect(tight.protectionPrice).toBe('100.5');
    expect(tight.holdAmount).toBe('201');
    expect(tight.orderable).toBe(true);
    expect(tight.refusals).toEqual([]);
  });

  it('a market sell with a tighter tolerance previews the higher floor', async () => {
    const tight = await preview({ ...sell, maxSlippageBps: 50 });
    expect(tight.protectionPrice).toBe('99.5');
    expect(tight.orderable).toBe(true);
  });

  it('refuses a tolerance looser than the owner cap, a non-integer, a string and a limit order, with no protection price', async () => {
    for (const body of [
      { ...buy, maxSlippageBps: 300 },
      { ...buy, maxSlippageBps: 1.5 },
      { ...buy, maxSlippageBps: 0 },
      { ...buy, maxSlippageBps: '50' },
      { ...sell, maxSlippageBps: 300 },
      { symbol: MARKET.symbol, side: 'buy', type: 'limit', amount: '2', price: '100', maxSlippageBps: 50 },
    ]) {
      const res = await preview(body);
      expect(res.orderable, JSON.stringify(body)).toBe(false);
      expect(
        res.refusals.map((r: { code: string }) => r.code),
        JSON.stringify(body),
      ).toContain('trade.slippage_tolerance_invalid');
    }
  });

  it('a tolerance never stands in for an unpublished owner cap', async () => {
    const res = await preview({ ...buy, maxSlippageBps: 50 }, { slippageCapBps: null });
    expect(res.orderable).toBe(false);
    expect(res.protectionPrice).toBeNull();
    expect(res.refusals.map((r: { code: string }) => r.code)).toContain('trade.slippage_cap_unset');
  });
});

describe('POST /api/v1/orders/preview: an operator halt in matching (J-cex-spot-02 step 8)', () => {
  const preview = async (matchingHalt: (marketId: string) => Promise<{ market: boolean; venue: boolean }>) => {
    const { app, submit } = appWith({ matchingHalt });
    const response = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload: limitBuy });
    await app.close();
    expect(submit).not.toHaveBeenCalled();
    return response;
  };

  it('a halted market is refused before Confirm, with the halt named', async () => {
    const asked: string[] = [];
    const response = await preview(async (marketId) => {
      asked.push(marketId);
      return { market: true, venue: false };
    });
    expect(asked).toEqual([MARKET.id]);
    expect(response.json()).toMatchObject({
      orderable: false,
      refusals: [expect.objectContaining({ code: 'trade.market_halted', field: 'symbol' })],
    });
  });

  it('a venue-wide halt is refused as one', async () => {
    const response = await preview(async () => ({ market: false, venue: true }));
    expect(response.json().refusals.map((r: { code: string }) => r.code)).toEqual(['trade.venue_halted']);
  });

  it('an open book adds nothing, and a failed read adds nothing (place stays the authority)', async () => {
    expect((await preview(async () => ({ market: false, venue: false }))).json()).toMatchObject({ orderable: true, refusals: [] });
    const failed = await preview(async () => {
      throw new Error('matching down');
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ orderable: true, refusals: [] });
  });
});

describe('POST /api/v1/orders/preview: the operator limits place enforces (J-cex-spot-04 steps 4 and 5)', () => {
  const preview = async (payload: Record<string, unknown>, operatorRisk: SpotOrderPreviewRestDeps['operatorRisk']) => {
    const { app, submit } = appWith({ operatorRisk });
    const response = await app.inject({ method: 'POST', url: SPOT_ORDER_PREVIEW_PATH, headers: headers(), payload });
    await app.close();
    expect(submit).not.toHaveBeenCalled();
    return response.json();
  };

  it('a price outside the band is refused before Confirm, with the edges', async () => {
    const asked: Array<{ side: string; price: string | null; rests: boolean }> = [];
    const body = await preview(limitBuy, async (market, _user, input) => {
      asked.push({ side: input.side, price: input.price === null ? null : formatAmount(input.price), rests: input.rests });
      throw new TradeError('order price is outside the price band 90 to 99', 'trade.price_band', { low: '90', high: '99', collar: '0.05' });
    });
    expect(asked).toEqual([{ side: 'buy', price: '100', rests: true }]);
    expect(body).toMatchObject({
      orderable: false,
      refusals: [{ code: 'trade.price_band', field: 'price', data: { low: '90', high: '99', collar: '0.05' } }],
    });
  });

  it('a full open-order cap is refused with the cap and the count; an IOC is asked as one that cannot rest', async () => {
    const body = await preview(limitBuy, async () => {
      throw new TradeError('2 orders are open', 'trade.operator_throttle', { cap: '2', open: '2' });
    });
    expect(body.refusals).toEqual([
      expect.objectContaining({ code: 'trade.operator_throttle', field: 'symbol', data: { cap: '2', open: '2' } }),
    ]);
    const rests: boolean[] = [];
    await preview({ ...limitBuy, timeInForce: 'IOC' }, async (_market, _user, input) => {
      rests.push(input.rests);
    });
    expect(rests).toEqual([false]);
  });

  it('a limit whose price does not read is not sent to the gate', async () => {
    let asked = false;
    await preview({ ...limitBuy, price: 'abc' }, async () => {
      asked = true;
    });
    expect(asked).toBe(false);
  });
});
