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
    ...(liquidation === undefined ? {} : { liquidationPriceFor: async () => (liquidation === null ? null : parseAmount(liquidation)) }),
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
